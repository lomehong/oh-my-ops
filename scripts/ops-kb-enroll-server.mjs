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
import { AuditLog } from "./lib/kb-audit.mjs";
import { readAdminAuth, makeApi, defaultTeam, randomPassword, credentialJson, ensureUser, grantAccess, revokeAccess, scramblePassword, verifyBotCredential, sha1 } from "./lib/kb-gitea.mjs";
import { checkCode, consumeCode, upsertEntry, markRevoked, REGISTRY_VERSION } from "./lib/kb-registry.mjs";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		if (["allow-insecure-http", "help"].includes(key)) {
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
if (args.repo === undefined || args.api === undefined) {
	console.error("✗ 需要 --api 与 --repo");
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

const useTls = args["tls-cert"] !== undefined && args["tls-key"] !== undefined;
if (!useTls && args["allow-insecure-http"] !== true) {
	console.error("✗ 拒绝以明文 HTTP 启动（凭据将经网络传输）：请提供 --tls-cert/--tls-key，或显式 --allow-insecure-http（仅限本机/受信内网）");
	process.exit(1);
}
if (!useTls) console.error("⚠ 明文 HTTP 模式（--allow-insecure-http）：凭据将以明文经网络传输，仅限受信链路！");

const server = Bun.serve({
	hostname: host,
	port,
	...(useTls ? { tls: { cert: Bun.file(args["tls-cert"]), key: Bun.file(args["tls-key"]) } } : {}),
	async fetch(req) {
		const u = new URL(req.url);
		const ip = server.requestIP(req)?.address ?? "unknown";
		if (u.pathname === "/healthz") return json(200, { ok: true, repo: args.repo, registryVersion: REGISTRY_VERSION, tls: useTls });
		if (u.pathname === "/enroll" && req.method === "POST") return await handleEnroll(req, ip);
		return json(404, { error: "not found" });
	},
});

// 打印监听端口（测试与运维都靠这一行判定就绪；日志一律不含秘密）
console.log(`LISTEN ${useTls ? "https" : "http"}://${host}:${server.port} repo=${args.repo} registry=${registryFile} audit=${auditFile} codeTtlMin=${codeTtlMin}`);
