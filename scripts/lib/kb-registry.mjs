/**
 * kb-registry.mjs —— 知识库供给登记表 + 一次性兑换码（供给 CLI 与 enroll 服务共用）
 *
 * 落盘纪律：0600；**永不含秘密本体**（bot 密码只存 sha1 供对账；兑换码只存 sha256，明文只在签发时打印一次）。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const REGISTRY_VERSION = 3;

export function loadRegistry(file) {
	if (!fs.existsSync(file)) return { version: REGISTRY_VERSION, entries: [], codes: [] };
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	return { version: raw.version ?? REGISTRY_VERSION, entries: raw.entries ?? [], codes: raw.codes ?? [] };
}

export function saveRegistry(file, reg) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

export function sha256(s) {
	return crypto.createHash("sha256").update(s).digest("hex");
}

export function sha1(s) {
	return crypto.createHash("sha1").update(s).digest("hex");
}

/** 兑换码可选操作 */
export const CODE_OPS = ["enroll", "rotate", "revoke"];

/**
 * 签发一次性兑换码（明文只返回一次，登记表只存 sha256）。
 * @param {string} file 登记表路径
 * @param {{device?: string, op?: string, ttlMin?: number, by?: string}} opts
 * @returns {{code: string, expiresAt: string}}
 */
export function issueCode(file, opts = {}) {
	const op = opts.op ?? "enroll";
	if (!CODE_OPS.includes(op)) throw new Error(`未知操作：${op}（可用：${CODE_OPS.join("/")}）`);
	const ttlMin = opts.ttlMin ?? 30;
	const code = crypto.randomBytes(24).toString("base64url");
	const now = Date.now();
	const entry = {
		sha256: sha256(code),
		op,
		device: opts.device,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ttlMin * 60_000).toISOString(),
		issuedBy: opts.by ?? "owner",
	};
	const reg = loadRegistry(file);
	reg.codes = reg.codes.filter((c) => c.usedAt === undefined && Date.parse(c.expiresAt) > now); // 顺手清理已用/过期码
	reg.codes.push(entry);
	saveRegistry(file, reg);
	return { code, expiresAt: entry.expiresAt };
}

/**
 * 校验兑换码（不消费）。
 * @returns {{ok: true, entry: object} | {ok: false, reason: "not_found"|"expired"|"used"|"device_mismatch"}}
 */
export function checkCode(file, code, device) {
	const reg = loadRegistry(file);
	const entry = reg.codes.find((c) => c.sha256 === sha256(String(code ?? "")));
	if (entry === undefined) return { ok: false, reason: "not_found" };
	if (entry.usedAt !== undefined) return { ok: false, reason: "used" };
	if (Date.parse(entry.expiresAt) <= Date.now()) return { ok: false, reason: "expired" };
	if (entry.device !== undefined && entry.device !== "" && entry.device !== device) return { ok: false, reason: "device_mismatch" };
	return { ok: true, entry };
}

/** 标记兑换码已用（单次消费；跨设备不可重放） */
export function consumeCode(file, code, usedBy) {
	const reg = loadRegistry(file);
	const target = reg.codes.find((c) => c.sha256 === sha256(String(code ?? "")));
	if (target === undefined) return;
	target.usedAt = new Date().toISOString();
	target.usedBy = usedBy ?? "";
	saveRegistry(file, reg);
}

/** 写入/更新一条 bot 登记（同 device+login 覆盖） */
export function upsertEntry(file, entry) {
	const reg = loadRegistry(file);
	reg.entries = reg.entries.filter((e) => !(e.device === entry.device && e.login === entry.login));
	reg.entries.push(entry);
	saveRegistry(file, reg);
	return entry;
}

/** 标记登记吊销 */
export function markRevoked(file, login, at = new Date().toISOString()) {
	const reg = loadRegistry(file);
	for (const e of reg.entries) if (e.login === login) e.revokedAt = at;
	saveRegistry(file, reg);
}
