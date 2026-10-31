/**
 * kb-control-plane.mjs —— KB 控制面数据模型与存储（KBCP-P0-1）
 *
 * 落盘纪律：
 *   - 所有 control-plane JSON 均 0600；原子写（tmp+rename）；
 *   - 安装令牌只存 sha256，明文只在签发响应出现一次；
 *   - 进程内串行队列 + revision 乐观锁，防止 HTTP 并发读改写丢失更新；
 *   - 损坏/旧格式**大声失败**，不静默降级为空表。
 *
 * 设计：docs/designs/kb-control-plane-design.md §7.2/§7.4.2/§7.9。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const CONTROL_PLANE_VERSION = 1;
export const INSTALL_TOKEN_PREFIX = "omoinst_";
export const REPORT_TOKEN_PREFIX = "omoreport_";
export const INSTALL_TOKEN_TTL_MIN = 60;
export const CONTROL_PLANE_STORE_NAMES = {
	installers: "installers.json",
	tokens: "install-tokens.json",
	instances: "instances.json",
};

export class ControlPlaneError extends Error {}

export function nowIso() {
	return new Date().toISOString();
}

export function sha256Hex(value) {
	return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function newOpaqueToken(prefix = INSTALL_TOKEN_PREFIX, bytes = 32) {
	return `${prefix}${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function newInstallId() {
	return `ins_${crypto.randomBytes(12).toString("hex")}`;
}

/** 控制面目录：默认与 registry 同级；调用方可显式指定。 */
export function controlPlaneDir(baseDir) {
	return path.join(baseDir, "control-plane");
}

export function storePath(dir, kind) {
	const name = CONTROL_PLANE_STORE_NAMES[kind];
	if (name === undefined) throw new ControlPlaneError(`未知控制面存储：${kind}`);
	return path.join(dir, name);
}

function emptyStore() {
	return { version: CONTROL_PLANE_VERSION, revision: 0, updatedAt: nowIso(), items: [] };
}

/** 0600 原子写；目录 0700。 */
export function atomicWriteJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	try {
		fs.chmodSync(tmp, 0o600);
	} catch {
		// Windows/Git Bash 可能不可表达；保留内容语义
	}
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 尽力而为
	}
}

/** 读取存储；缺失返回空；损坏/旧版本抛错（不静默降级）。 */
export function loadStore(file) {
	if (!fs.existsSync(file)) return emptyStore();
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		throw new ControlPlaneError(`控制面存储不是合法 JSON：${file}（${String(err?.message ?? err)}）`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ControlPlaneError(`控制面存储格式非法：${file}`);
	if (raw.version !== undefined && raw.version !== CONTROL_PLANE_VERSION) {
		throw new ControlPlaneError(`控制面存储版本不支持：${file}（version=${raw.version}）`);
	}
	if (!Array.isArray(raw.items)) throw new ControlPlaneError(`控制面存储缺少 items：${file}`);
	return {
		version: CONTROL_PLANE_VERSION,
		revision: Number.isInteger(raw.revision) ? raw.revision : 0,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
		items: raw.items,
	};
}

/** 读视图（深拷一份，防调用方改动内存）。 */
export function readStore(file) {
	return structuredClone(loadStore(file));
}

const queues = new Map();
/** 同文件读改写串行化；跨进程写由 CLI 走管理 API 约束（设计 K7）。 */
function enqueue(file, task) {
	const prev = queues.get(file) ?? Promise.resolve();
	const next = prev.then(task, task);
	queues.set(file, next.catch(() => {}));
	return next;
}

/**
 * 原子读改写：mutator 返回结果；成功后 revision+1。
 * mutator 抛错则不写盘。
 */
export async function updateStore(file, mutator) {
	return await enqueue(file, () => {
		const store = loadStore(file);
		const result = mutator(store);
		store.version = CONTROL_PLANE_VERSION;
		store.revision += 1;
		store.updatedAt = nowIso();
		atomicWriteJson(file, store);
		return { result, revision: store.revision, store };
	});
}

/** 管理员 token：不存在则生成 32B；只返回明文一次，文件 0600。 */
export function ensureAdminToken(file) {
	if (fs.existsSync(file)) {
		const token = fs.readFileSync(file, "utf8").trim();
		if (token !== "") return { token, created: false };
	}
	const token = newOpaqueToken("omoadmin_", 32);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 尽力而为
	}
	return { token, created: true };
}

export function readAdminToken(file) {
	try {
		const token = fs.readFileSync(file, "utf8").trim();
		return token === "" ? undefined : token;
	} catch {
		return undefined;
	}
}

/* ─────────────────────────── 安装令牌 ─────────────────────────── */

const TOKEN_TRANSITIONS = {
	issued: ["active", "revoked", "expired"],
	active: ["completed", "revoked", "expired"],
	completed: [],
	revoked: [],
	expired: [],
};

/** 签发一次性安装令牌；明文只返回一次。 */
export async function issueInstallToken(file, { version, channel = "stable", device, ttlMin = INSTALL_TOKEN_TTL_MIN, createdBy = "unknown" } = {}) {
	if (typeof version !== "string" || version === "") throw new ControlPlaneError("缺少安装版本");
	const ttl = Number(ttlMin);
	if (!Number.isFinite(ttl) || ttl < 1 || ttl > 1440) throw new ControlPlaneError("ttlMin 需为 1-1440 的整数");
	const token = newOpaqueToken();
	const installId = newInstallId();
	const now = Date.now();
	const record = {
		sha256: sha256Hex(token),
		installId,
		version,
		channel: String(channel),
		device: typeof device === "string" && device !== "" ? device : undefined,
		state: "issued",
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ttl * 60_000).toISOString(),
		createdBy,
		attempts: 0,
	};
	const { revision } = await updateStore(file, (store) => {
		// 顺手清理过期的未完成令牌（不删除 completed，保留审计）
		store.items = store.items.filter((t) => t.state === "completed" || Date.parse(t.expiresAt) > now);
		store.items.push(record);
		return record;
	});
	return { token, record, revision };
}

function tokenVerdict(record, token, device, now = Date.now()) {
	if (record === undefined) return { ok: false, reason: "not_found" };
	if (record.sha256 !== sha256Hex(token)) return { ok: false, reason: "not_found" };
	if (record.revokedAt !== undefined || record.state === "revoked") return { ok: false, reason: "revoked" };
	if (record.state === "completed") return { ok: false, reason: "completed" };
	if (Date.parse(record.expiresAt) <= now) return { ok: false, reason: "expired" };
	if (record.device !== undefined && record.device !== "" && typeof device === "string" && device !== "" && record.device !== device) return { ok: false, reason: "device_mismatch" };
	return { ok: true, record };
}

/** 校验（不消费）。返回 record 副本，不改状态。 */
export function verifyInstallToken(file, token, device) {
	const store = loadStore(file);
	const record = store.items.find((t) => t.sha256 === sha256Hex(String(token ?? "")));
	return tokenVerdict(record, String(token ?? ""), device);
}

/** 第一次成功获取 script/manifest：issued → active（幂等）。 */
export async function activateInstallToken(file, token) {
	return await updateStore(file, (store) => {
		const record = store.items.find((t) => t.sha256 === sha256Hex(String(token ?? "")));
		if (record === undefined) throw new ControlPlaneError("安装令牌不存在");
		if (record.state === "active") return record;
		if (record.state !== "issued") throw new ControlPlaneError(`安装令牌状态不可激活：${record.state}`);
		if (Date.parse(record.expiresAt) <= Date.now()) {
			record.state = "expired";
			throw new ControlPlaneError("安装令牌已过期");
		}
		record.state = "active";
		record.activatedAt = nowIso();
		record.attempts = (record.attempts ?? 0) + 1;
		return record;
	});
}

/** report verified：active → completed（只允许一次）。 */
export async function completeInstallToken(file, token) {
	return await updateStore(file, (store) => {
		const record = store.items.find((t) => t.sha256 === sha256Hex(String(token ?? "")));
		if (record === undefined) throw new ControlPlaneError("安装令牌不存在");
		if (record.state === "completed") throw new ControlPlaneError("安装令牌已完成");
		if (record.state !== "active") throw new ControlPlaneError(`安装令牌未激活：${record.state}`);
		record.state = "completed";
		record.completedAt = nowIso();
		return record;
	});
}

export async function revokeInstallToken(file, tokenOrInstallId) {
	return await updateStore(file, (store) => {
		const record = store.items.find((t) => t.installId === tokenOrInstallId || t.sha256 === sha256Hex(String(tokenOrInstallId ?? "")));
		if (record === undefined) throw new ControlPlaneError("安装令牌不存在");
		if (TOKEN_TRANSITIONS[record.state]?.includes("revoked") !== true) throw new ControlPlaneError(`安装令牌不可吊销：${record.state}`);
		record.state = "revoked";
		record.revokedAt = nowIso();
		return record;
	});
}

export function listInstallTokens(file) {
	return readStore(file).items.map((t) => ({ ...t, sha256: undefined }));
}

/* ─────────────────────────── 安装版本 ─────────────────────────── */

export async function upsertInstaller(file, entry) {
	if (typeof entry?.version !== "string" || entry.version === "") throw new ControlPlaneError("installer 缺 version");
	if (typeof entry?.script_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.script_sha256)) throw new ControlPlaneError("installer 缺合法 script_sha256");
	return await updateStore(file, (store) => {
		const idx = store.items.findIndex((x) => x.version === entry.version && (x.channel ?? "stable") === (entry.channel ?? "stable"));
		const record = { ...entry, channel: entry.channel ?? "stable", createdAt: entry.createdAt ?? nowIso(), status: entry.status ?? "available" };
		if (idx >= 0) store.items[idx] = record;
		else store.items.push(record);
		return record;
	});
}

export function listInstallers(file) {
	return readStore(file).items;
}

/* ─────────────────────────── 实例上报令牌 ─────────────────────────── */

/**
 * 实例上报令牌：`/install/enroll` 成功时签发，随响应只出现一次；服务端只存 sha256。
 * 与一次性安装令牌分离——安装令牌在 verified 后完成，后续 `omo kb status --report` 仍需可用凭据。
 */
export async function issueReportToken(instancesFile, installId) {
	const token = newOpaqueToken(REPORT_TOKEN_PREFIX, 32);
	const hash = sha256Hex(token);
	const { result } = await updateStore(instancesFile, (store) => {
		const idx = store.items.findIndex((x) => x.installId === installId);
		if (idx < 0) throw new ControlPlaneError(`实例不存在：${installId}`);
		store.items[idx].reportTokenSha256 = hash;
		store.items[idx].reportTokenIssuedAt = nowIso();
		delete store.items[idx].reportTokenRevokedAt;
		return store.items[idx];
	});
	return { token, record: result };
}

/** 上报令牌校验：按哈希查实例；吊销/失败态实例拒绝上报。 */
export function verifyReportToken(instancesFile, token) {
	const hash = sha256Hex(String(token ?? ""));
	const record = readStore(instancesFile).items.find((x) => x.reportTokenSha256 === hash);
	if (record === undefined) return { ok: false, reason: "not_found" };
	if (record.revokedAt !== undefined || record.status === "revoked") return { ok: false, reason: "revoked" };
	if (record.reportTokenRevokedAt !== undefined) return { ok: false, reason: "revoked" };
	return { ok: true, record };
}

/** 吊销上报令牌（实例吊销/轮换凭据时同步失效，避免孤儿令牌继续写入）。保留哈希以区分「已吊销」与「不存在」。 */
export async function revokeReportToken(instancesFile, installId) {
	return await updateStore(instancesFile, (store) => {
		const idx = store.items.findIndex((x) => x.installId === installId);
		if (idx < 0) throw new ControlPlaneError(`实例不存在：${installId}`);
		store.items[idx].reportTokenRevokedAt = nowIso();
		return store.items[idx];
	});
}

/* ─────────────────────────── 实例 ─────────────────────────── */

export async function upsertInstance(file, entry) {
	if (typeof entry?.installId !== "string" || entry.installId === "") throw new ControlPlaneError("实例缺 installId");
	return await updateStore(file, (store) => {
		const idx = store.items.findIndex((x) => x.installId === entry.installId);
		const now = nowIso();
		const prev = idx >= 0 ? store.items[idx] : {};
		const record = {
			id: entry.installId,
			installId: entry.installId,
			device: entry.device ?? prev.device ?? "unknown",
			version: entry.version ?? prev.version ?? "unknown",
			os: entry.os ?? prev.os ?? "unknown",
			arch: entry.arch ?? prev.arch ?? "unknown",
			status: entry.status ?? prev.status ?? "installed",
			lastSeen: entry.lastSeen ?? prev.lastSeen ?? now,
			lastSync: entry.lastSync ?? prev.lastSync,
			configRevision: entry.configRevision ?? prev.configRevision,
			appliedRevision: entry.appliedRevision ?? prev.appliedRevision,
			credential: entry.credential ?? prev.credential,
			lastError: entry.lastError,
			// 上报令牌属于安装凭据，普通上报不得覆盖/清除
			reportTokenSha256: entry.reportTokenSha256 ?? prev.reportTokenSha256,
			reportTokenIssuedAt: entry.reportTokenIssuedAt ?? prev.reportTokenIssuedAt,
			reportTokenRevokedAt: entry.reportTokenRevokedAt ?? prev.reportTokenRevokedAt,
			revokedAt: entry.revokedAt ?? prev.revokedAt,
			createdAt: idx >= 0 ? store.items[idx].createdAt : now,
			updatedAt: now,
		};
		if (idx >= 0) store.items[idx] = record;
		else store.items.push(record);
		return record;
	});
}

/** 列表视图不得含上报令牌哈希（管理端只需要「是否有可用令牌」）。 */
export function listInstances(file) {
	return readStore(file).items.map(({ reportTokenSha256, reportTokenRevokedAt, ...rest }) => ({
		...rest,
		reportToken: reportTokenSha256 !== undefined && reportTokenRevokedAt === undefined,
	}));
}

/** 实例视图：只显示最近上报，不宣称实时在线（registry 登记 ≠ 在线）。 */
export function instanceView(record, now = Date.now(), staleMs = 24 * 3600_000) {
	const { reportTokenSha256, reportTokenRevokedAt, ...rest } = record;
	const last = Date.parse(record.lastSeen ?? "");
	const stale = !Number.isFinite(last) || now - last > staleMs;
	const reportToken = typeof record.reportToken === "boolean"
		? record.reportToken
		: reportTokenSha256 !== undefined && reportTokenRevokedAt === undefined;
	return { ...rest, reportToken, stale, online: false };
}

/* ─────────────────────────── 响应头/工具 ─────────────────────────── */

export function bearerToken(req) {
	const h = req.headers.get("Authorization") ?? "";
	const m = /^Bearer\s+(.+)$/i.exec(h.trim());
	return m === null ? undefined : m[1].trim();
}

export function requireBearer(req, expected) {
	const got = bearerToken(req);
	return typeof expected === "string" && expected !== "" && got === expected;
}

export function jsonResponse(status, body) {
	return new Response(`${JSON.stringify(body)}\n`, { status, headers: { "Content-Type": "application/json" } });
}

export function tokenStateAllowed(from, to) {
	return TOKEN_TRANSITIONS[from]?.includes(to) === true;
}
