#!/usr/bin/env bun
/**
 * ops-kb-enroll-server.mjs —— 知识库凭据**自注册/轮换/吊销**服务（P3）
 *
 * 契约：docs/designs/omo-kb-sync-credential-design.md §5.6（接口）/§5.7（生命周期）
 * 形态：**零依赖常驻小服务**（bun 运行时），部署到哪由使用者决定，服务本身与位置无关。
 *
 * 授权模型（简单、可审计）：
 *   - 服务零外部依赖（除 bun/Node 标准库）：审计链用本地 lib/kb-audit.mjs（与宿主侧 AuditLog 同算法，有对拍守卫），
 *     避免安装到私有域后 `Cannot find module @ops-pi/core`（真机踩到）；
 *   - 服务持有**管理员引导凭据**（admin 作用域令牌 或 站点管理员账号+密码）；
 *   - 每个动作（enroll/rotate/revoke）都必须出示**一次性兑换码**（由 Owner 用
 *     `ops-kb-provision.mjs code` 签发；单次消费、默认 TTL 30 分钟、可选绑定设备名）；
 *   - 服务侧只存码的 sha256；bot 密码只存 sha1；两者与审计日志均**不含秘密本体**。
 *
 * 接口：
 *   GET  /healthz                      → {ok, repo, version}
 *   POST /enroll  {code, device, agent_id?}
 *        op=enroll → 建号(幂等)+授权+自证 → 返回 {credential:{repo,username,secret,kind}}
 *        op=rotate → 改密（凭据即时轮换）→ 返回新 credential
 *        op=revoke → 改乱密码 + 撤权 → 返回 {revoked:true}
 *   错误码：401 码无效 / 410 码过期 / 409 码已用 / 403 设备不匹配 / 400 缺参 / 429 触发限流 / 500 服务侧失败
 *
 * 用法（示例，TLS 直连；不接受明文 HTTP，除非显式 --allow-insecure-http 且打印醒目告警）：
 *   bun scripts/ops-kb-enroll-server.mjs --api https://twin.hzins.com/git/api/v1 \
 *       --repo hzins-ops/ops-kb --grant team --team omo-kb-ops-kb --permission write \
 *       --admin-user omo-admin --admin-password-file /root/omo-admin.pw \
 *       --registry /var/lib/omo-kb/registry.json --audit /var/lib/omo-kb/audit.jsonl \
 *       --host 0.0.0.0 --port 8787 --tls-cert /etc/omo-kb/tls.crt --tls-key /etc/omo-kb/tls.key
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AuditLog } from "./lib/kb-audit.mjs";
import { readAdminAuth, makeApi, defaultTeam, randomPassword, credentialJson, ensureUser, grantAccess, revokeAccess, scramblePassword, verifyBotCredential, sha1 } from "./lib/kb-gitea.mjs";
import { checkCode, consumeCode, upsertEntry, markRevoked, REGISTRY_VERSION, loadRegistry, issueCode } from "./lib/kb-registry.mjs";
import { identityFromRequest, unauthorizedResponse } from "./lib/kb-auth.mjs";
import { UI_CONFIG_KEYS, parseConfigEnv, readConfigEnv, validateValues, renderConfigEnv, writeConfigEnvAtomic, restoreConfigBackup, maskConfigForUi } from "./lib/kb-ui-config.mjs";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		if (["allow-insecure-http", "help", "check", "ui"].includes(key)) {
			out[key] = true;
			continue;
		}
		const val = argv[i + 1];
		if (val === undefined || val.startsWith("--")) throw new Error(`参数 --${key} 缺少取值`);
		out[key] = val;
		i++;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
	console.log("用法见脚本头注释。");
	process.exit(0);
}
/* ── 配置文件默认值（--config）：显式参数优先，config.env 兜底 ──
   /ui 在线改配置依赖 --config（要知道写回哪个文件）；启动器与重启接力都会带上它。 */
const CONFIG_KEY_TO_ARG = {
	OMO_KB_API: "api",
	OMO_KB_REPO: "repo",
	OMO_KB_TEAM: "team",
	OMO_KB_PERMISSION: "permission",
	OMO_KB_GRANT: "grant",
	OMO_KB_HOST: "host",
	OMO_KB_PORT: "port",
	OMO_KB_TLS_CERT: "tls-cert",
	OMO_KB_TLS_KEY: "tls-key",
	OMO_KB_REGISTRY: "registry",
	OMO_KB_AUDIT: "audit",
	OMO_KB_ADMIN_TOKEN_FILE: "admin-token-file",
	OMO_KB_ADMIN_USER: "admin-user",
	OMO_KB_ADMIN_PASSWORD_FILE: "admin-password-file",
	OMO_KB_UI: "ui",
	OMO_KB_UI_IDENTITY_HEADER: "ui-identity-header",
};
const configPath = typeof args.config === "string" && args.config !== "" ? args.config : undefined;
if (configPath !== undefined) {
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) {
		console.error(`✗ --config 指定的文件不可读：${configPath}`);
		process.exit(1);
	}
	for (const [key, argName] of Object.entries(CONFIG_KEY_TO_ARG)) {
		if (parsed.values[key] === undefined) continue;
		if (args[argName] !== undefined) continue; // 显式参数优先
		const raw = String(parsed.values[key]).trim();
		if (argName === "ui") {
			if (raw === "on") args.ui = true;
		} else if (raw !== "") args[argName] = raw;
	}
}
const useTls = args["tls-cert"] !== undefined && args["tls-key"] !== undefined;
const UI_ON = args.ui === true || args.ui === "on";
const UI_IDENTITY_HEADER = typeof args["ui-identity-header"] === "string" && args["ui-identity-header"] !== "" ? args["ui-identity-header"] : "X-Auth-Username"; // 真机实测定值（yufu/huntian-gateway）

if (args.repo === undefined || args.api === undefined) {
	console.error("✗ 需要 --api 与 --repo（或提供 --config <config.env>）");
	process.exit(1);
}

const registryFile = args.registry ?? "ops-kb-registry.json";
const auditFile = args["audit"] ?? "ops-kb-audit.jsonl";
const grant = args.grant ?? "team";
const permission = args.permission ?? "read";
const team = args.team ?? defaultTeam(args.repo);
const codeTtlMin = Number.parseInt(args["code-ttl-min"] ?? "30", 10);
const port = Number.parseInt(args.port ?? "8787", 10);
const host = args.host ?? "127.0.0.1";
const botPrefix = args["bot-prefix"] ?? "omo-bot-";
const audit = new AuditLog(auditFile);

let api;
try {
	api = makeApi(args.api, readAdminAuth(args));
} catch (err) {
	console.error(`✗ ${err.message}`);
	process.exit(1);
}

/* ── --check 预检模式：Gitea 可达 + 登记表可读 + （如配 TLS）证书可用 ⇒ 退出 ──
   /ui 在线改配置保存时自动跑（失败不重启、自动回滚 .bak）；运维也可手动执行验证配置。 */
if (args.check === true) {
	try {
		await fetch(args.api, { signal: AbortSignal.timeout(5000) }); // 任何 HTTP 应答=可达（Gitea 对匿名常 403/404，也算通）
	} catch (err) {
		console.error(`CHECK FAIL: API 不可达 ${args.api}（${String(err?.cause?.code ?? err?.message ?? err)}）`);
		process.exit(1);
	}
	try {
		loadRegistry(registryFile);
	} catch (err) {
		console.error(`CHECK FAIL: 登记表不可读 ${registryFile}（${String(err?.message ?? err)}）`);
		process.exit(1);
	}
	try {
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			...(useTls ? { tls: { cert: Bun.file(args["tls-cert"]), key: Bun.file(args["tls-key"]) } } : {}),
			fetch: () => json(200, { ok: true }),
		});
		probe.stop(true);
	} catch (err) {
		console.error(`CHECK FAIL: 监听/证书不可用（${String(err?.message ?? err)}）`);
		process.exit(1);
	}
	console.log(`CHECK OK repo=${args.repo} api=${args.api} port=${port} registry=${registryFile} ui=${UI_ON ? "on" : "off"}`);
	process.exit(0);
}

/* ── /ui 管理后台（yufu 网关信任模式：身份头缺失一律 401）── */
let uiPageCache;
function uiPageResponse() {
	try {
		if (uiPageCache === undefined) uiPageCache = fs.readFileSync(path.join(import.meta.dir, "ui", "index.html"), "utf8");
		return new Response(uiPageCache, { headers: { "Content-Type": "text/html; charset=utf-8" } });
	} catch {
		return json(503, { error: "UI 页面缺失（ui/index.html）——服务包不完整" });
	}
}

function handleUiState(actor) {
	let reg;
	let registryError;
	try {
		reg = loadRegistry(registryFile);
	} catch (err) {
		// 不静默：空表必须能区分「真的没有」与「读不到」（真机教训：空表无原因，Owner 无法判断）
		reg = { entries: [], codes: [] };
		registryError = String(err?.message ?? err);
	}
	const entries = (reg.entries ?? []).map((e) => ({ device: e.device ?? "-", login: e.login, repo: e.repo ?? "-", grant: e.grant ?? "-", team: e.team ?? "-", permission: e.permission ?? "-", revokedAt: e.revokedAt, createdAt: e.createdAt }));
	const pendingCodes = (reg.codes ?? []).filter((c) => c.usedAt === undefined).map((c) => ({ op: c.op, device: c.device ?? "任意", expiresAt: c.expiresAt }));
	let configView;
	if (configPath === undefined) configView = { error: "服务未经 --config 启动，无法查看/修改配置" };
	else {
		const parsed = readConfigEnv(configPath);
		configView = parsed ? maskConfigForUi(parsed.values) : { error: "配置文件不可读" };
	}
	let auditTail = [];
	try {
		const lines = fs.readFileSync(auditFile, "utf8").split("\n").filter((l) => l.trim() !== "");
		auditTail = lines.slice(-50).map((l) => {
			try {
				const r = JSON.parse(l);
				return { seq: r.seq, ts: r.ts, event: r.event, actor: r.actor, device: r.device, ip: r.ip };
			} catch {
				return { raw: l.slice(0, 80) };
			}
		});
	} catch { /* 审计文件尚不存在 */ }
	return json(200, {
		actor,
		health: { ok: true, repo: args.repo, registryVersion: REGISTRY_VERSION, tls: useTls, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
		ui: { on: UI_ON, identityHeader: UI_IDENTITY_HEADER, configPath: configPath ?? null },
		config: configView,
		registry: { entries, pendingCodes, file: registryFile, ...(registryError === undefined ? {} : { error: registryError }) },
		auditTail,
	});
}

async function handleUiCode(req, ip, actor) {
	let body;
	try {
		body = await req.json();
	} catch {
		return json(400, { error: "请求体必须是 JSON" });
	}
	const device = typeof body?.device === "string" ? body.device.trim() : "";
	const ttlMin = body?.ttlMin === undefined ? codeTtlMin : Number(body.ttlMin);
	if (device === "") return json(400, { error: "缺少 device" });
	if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > 1440) return json(400, { error: "ttlMin 需为 1-1440 的分钟数" });
	try {
		const { code, expiresAt } = issueCode(registryFile, { op: "enroll", device, ttlMin, by: `ui:${actor}` });
		audit.append({ event: "ui.code.issued", ts: new Date().toISOString(), device, actor, ttlMin, expiresAt, ip });
		// 明文只出现在本次响应（与 CLI 签码同一纪律）
		return json(200, { ok: true, code, expiresAt, device, hint: "omo kb enroll --server <服务地址> --code-file <0600 码文件>" });
	} catch (err) {
		return json(400, { error: String(err?.message ?? err) });
	}
}

function handleUiConfigGet(actor) {
	if (configPath === undefined) return json(400, { error: "服务未经 --config 启动，无法查看/修改配置" });
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) return json(400, { error: `配置文件不可读：${configPath}` });
	return json(200, { actor, keys: Object.fromEntries(Object.entries(UI_CONFIG_KEYS).map(([k, m]) => [k, m.label])), values: maskConfigForUi(parsed.values) });
}

/** 重启接力：新进程带绑定重试先起，等旧进程让位（窗口 <1s，/healthz 短暂拒绝属预期） */
function successorArgs() {
	// 只丢弃「UI 白名单可改」的键（以 config 文件新值为准）；管理员凭据路径不在 UI 白名单内 ⇒ 原样接力，
	// 否则预检/重启子进程丢凭据必假失败（V6 真机教训）。
	const drop = new Set(["api", "repo", "team", "permission", "grant", "host", "port", "tls-cert", "tls-key", "registry", "audit", "config"]);
	const out = [process.execPath, import.meta.path];
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		if (drop.has(key)) {
			const v = argv[i + 1];
			if (v !== undefined && !v.startsWith("--")) i++;
			continue;
		}
		out.push(a);
		const v = argv[i + 1];
		if (v !== undefined && !v.startsWith("--")) {
			out.push(v);
			i++;
		}
	}
	if (configPath !== undefined) out.push("--config", configPath);
	return out;
}

async function handleUiConfigPost(req, ip, actor) {
	if (configPath === undefined) return json(400, { error: "服务未经 --config 启动，无法在线修改配置" });
	let body;
	try {
		body = await req.json();
	} catch {
		return json(400, { error: "请求体必须是 JSON" });
	}
	const values = body?.values;
	if (typeof values !== "object" || values === null || Array.isArray(values)) return json(400, { error: "缺少 values 对象" });
	const strValues = {};
	for (const [k, v] of Object.entries(values)) strValues[k] = String(v);
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) return json(400, { error: `配置文件不可读：${configPath}` });
	const verdict = validateValues(strValues);
	if (!verdict.ok) {
		audit.append({ event: "ui.config.rejected", ts: new Date().toISOString(), actor, reason: JSON.stringify(verdict.errors), ip });
		return json(400, { error: "校验失败", errors: verdict.errors });
	}
	writeConfigEnvAtomic(configPath, renderConfigEnv(parsed, strValues));
	// 预检：新配置起临时服务自证（Gitea 可达/登记表可读/证书可用）；失败 ⇒ 回滚 .bak，绝不重启
	// 继承 successorArgs（管理员凭据等未被 --config 覆盖的原始参数），否则无凭据起不来必假失败
	const check = Bun.spawn([...successorArgs(), "--check"], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(check.stdout).text(), new Response(check.stderr).text()]);
	const checkCodeExit = await check.exited;
	if (checkCodeExit !== 0) {
		restoreConfigBackup(configPath);
		const detail = `${out}${err}`.trim().slice(-400);
		audit.append({ event: "ui.config.preflight_failed", ts: new Date().toISOString(), actor, detail, ip });
		return json(400, { error: "预检失败，已回滚配置，服务未重启", detail });
	}
	audit.append({ event: "ui.config.updated", ts: new Date().toISOString(), actor, changed: Object.keys(strValues), ip });
	Bun.spawn(successorArgs(), { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: { ...process.env, OMO_KB_BIND_RETRY_MS: "5000" } }).unref();
	setTimeout(() => {
		try {
			server.stop(true);
		} catch { /* 已停 */ }
		process.exit(0);
	}, 300);
	return json(200, { ok: true, restarting: true, detail: "配置已写入并通过预检，服务正在切换（<1s 窗口）" });
}

/* ---------------- 限流：同一来源 1 分钟内最多 10 次失败 ---------------- */
const failures = new Map();
function throttled(ip) {
	const now = Date.now();
	const rec = failures.get(ip) ?? { n: 0, since: now };
	if (now - rec.since > 60_000) {
		rec.n = 0;
		rec.since = now;
	}
	rec.n++;
	failures.set(ip, rec);
	return rec.n > 10;
}

function json(status, body) {
	return new Response(`${JSON.stringify(body)}\n`, { status, headers: { "Content-Type": "application/json" } });
}

/** 设备名 → bot 账号名（小写、仅 [a-z0-9-]，稳定可预期，便于审计对账） */
function loginFor(device) {
	const slug = String(device ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	if (slug === "") throw new Error("device 非法（需要非空设备名）");
	return `${botPrefix}${slug}`;
}

async function handleEnroll(req, ip) {
	let body;
	try {
		body = await req.json();
	} catch {
		return json(400, { error: "请求体必须是 JSON" });
	}
	const { code, device, agent_id: agentId } = body ?? {};
	if (typeof code !== "string" || code === "") return json(400, { error: "缺少 code" });
	if (typeof device !== "string" || device === "") return json(400, { error: "缺少 device" });

	const verdict = checkCode(registryFile, code, device);
	if (!verdict.ok) {
		audit.append({ event: "enroll.rejected", device, reason: verdict.reason, ip });
		if (throttled(ip)) return json(429, { error: "尝试过于频繁" });
		if (verdict.reason === "expired") return json(410, { error: "兑换码已过期" });
		if (verdict.reason === "used") return json(409, { error: "兑换码已被使用" });
		if (verdict.reason === "device_mismatch") return json(403, { error: "兑换码与本设备不匹配" });
		return json(401, { error: "兑换码无效" });
	}
	const op = verdict.entry.op;

	try {
		const login = loginFor(device);
		const logs = [];
		const log = (s) => logs.push(s);

		if (op === "revoke") {
			await scramblePassword(api, login, log);
			await revokeAccess(api, args.repo, login, grant, team, log);
			consumeCode(registryFile, code, `${device}`);
			markRevoked(registryFile, login);
			audit.append({ event: "enroll.revoked", device, agentId, login, detail: logs.join("; "), ip });
			return json(200, { ok: true, op, revoked: true, login, detail: logs });
		}

		// enroll / rotate：建立或轮换凭据
		const secret = randomPassword();
		await ensureUser(api, login, secret, log);
		await grantAccess(api, args.repo, login, grant, team, permission, log);
		const probe = await verifyBotCredential(api, args.repo, login, secret);
		if (!probe.ok) {
			audit.append({ event: "enroll.failed", device, agentId, login, reason: `自证失败 HTTP ${probe.status}`, detail: logs.join("; "), ip });
			return json(500, { error: `供给后自证失败（HTTP ${probe.status}），未发放凭据` });
		}
		log(`凭据自证 GET /repos/${args.repo} ✓ ${probe.status}`);

		const credential = credentialJson(api.base, args.repo, login, secret, "password");
		consumeCode(registryFile, code, `${device}`);
		upsertEntry(registryFile, {
			device,
			login,
			repo: args.repo,
			grant,
			team: grant === "team" ? team : undefined,
			permission,
			credentialKind: "password",
			secretSha1: sha1(secret),
			createdAt: new Date().toISOString(),
			...(op === "rotate" ? { rotatedAt: new Date().toISOString() } : {}),
		});
		audit.append({ event: `enroll.${op}`, device, agentId, login, detail: logs.join("; "), ip });
		// 秘密**只出现在本次响应**，绝不落日志/登记表
		return json(200, { ok: true, op, credential, detail: logs });
	} catch (err) {
		audit.append({ event: "enroll.error", device, agentId, op, reason: String(err?.message ?? err), ip });
		return json(500, { error: `服务侧失败：${String(err?.message ?? err)}` });
	}
}

if (!useTls && args["allow-insecure-http"] !== true) {
	console.error("✗ 拒绝以明文 HTTP 启动（凭据将经网络传输）：请提供 --tls-cert/--tls-key，或显式 --allow-insecure-http（仅限本机/受信内网）");
	process.exit(1);
}
if (!useTls) console.error("⚠ 明文 HTTP 模式（--allow-insecure-http）：凭据将以明文经网络传输，仅限受信链路！");

let server;
const bindRetryMs = Number.parseInt(process.env.OMO_KB_BIND_RETRY_MS ?? "0", 10) || 0;
for (let deadline = Date.now() + bindRetryMs; ; ) {
	try {
		server = Bun.serve({
			hostname: host,
			port,
			...(useTls ? { tls: { cert: Bun.file(args["tls-cert"]), key: Bun.file(args["tls-key"]) } } : {}),
			async fetch(req) {
				const u = new URL(req.url);
				const ip = server.requestIP(req)?.address ?? "unknown";
				if (u.pathname === "/healthz") return json(200, { ok: true, repo: args.repo, registryVersion: REGISTRY_VERSION, tls: useTls });
				if (u.pathname === "/enroll" && req.method === "POST") return await handleEnroll(req, ip);
				if (UI_ON && (u.pathname === "/ui" || u.pathname.startsWith("/ui/"))) {
					const actor = identityFromRequest(req, UI_IDENTITY_HEADER);
					if (actor === null) {
						if (throttled(ip)) return json(429, { error: "尝试过于频繁" });
						audit.append({ event: "ui.denied", ts: new Date().toISOString(), ip, via: u.pathname });
						return unauthorizedResponse();
					}
					if (u.pathname === "/ui") return new Response(null, { status: 301, headers: { Location: "ui/" } });
					if (u.pathname === "/ui/") return uiPageResponse();
					if (u.pathname === "/ui/api/state" && req.method === "GET") return handleUiState(actor);
					if (u.pathname === "/ui/api/code" && req.method === "POST") return await handleUiCode(req, ip, actor);
					if (u.pathname === "/ui/api/config" && req.method === "GET") return handleUiConfigGet(actor);
					if (u.pathname === "/ui/api/config" && req.method === "POST") return await handleUiConfigPost(req, ip, actor);
					return json(404, { error: "not found" });
				}
				return json(404, { error: "not found" });
			},
		});
		break;
	} catch (err) {
		if (Date.now() >= deadline) {
			console.error(`✗ 端口绑定失败 ${host}:${port}（${String(err?.message ?? err)}）`);
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}
if (typeof args["pid-file"] === "string" && args["pid-file"] !== "") {
	try {
		fs.mkdirSync(path.dirname(args["pid-file"]), { recursive: true });
		fs.writeFileSync(args["pid-file"], `${process.pid}\n`);
	} catch { /* pid 文件写不进不阻断服务 */ }
}

// 打印监听端口（测试与运维都靠这一行判定就绪；日志一律不含秘密）
console.log(`LISTEN ${useTls ? "https" : "http"}://${host}:${server.port} repo=${args.repo} registry=${registryFile} audit=${auditFile} codeTtlMin=${codeTtlMin} ui=${UI_ON ? "on" : "off"} auth=${UI_ON ? `identity-header(${UI_IDENTITY_HEADER})` : "n/a"} config=${configPath ?? "-"}`);
