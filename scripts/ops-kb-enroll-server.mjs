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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { AuditLog } from "./lib/kb-audit.mjs";
import { readAdminAuth, makeApi, defaultTeam, randomPassword, credentialJson, ensureUser, grantAccess, revokeAccess, scramblePassword, verifyBotCredential, sha1, repoWebPath, getGateState, ensureBranchProtection, ensureWebhook } from "./lib/kb-gitea.mjs";
import { checkCode, consumeCode, upsertEntry, markRevoked, REGISTRY_VERSION, loadRegistry, issueCode, sha256 } from "./lib/kb-registry.mjs";
import { identityFromRequest, unauthorizedResponse } from "./lib/kb-auth.mjs";
import { buildComment, lintSimilarity, lintStructure, verifyHmacWithRotation } from "./lib/kb-lint.mjs";
import { UI_CONFIG_KEYS, readConfigEnv, validateValues, renderConfigEnv, removeConfigKeys, writeConfigEnvAtomic, restoreConfigBackup, maskConfigForUi } from "./lib/kb-ui-config.mjs";
import {
	CONTROL_PLANE_STORE_NAMES,
	REPORT_TOKEN_PREFIX,
	activateInstallToken,
	atomicWriteJson,
	bearerToken,
	completeInstallToken,
	controlPlaneDir,
	ensureAdminToken,
	instanceView,
	issueInstallToken,
	issueReportToken,
	listInstallers,
	listInstallTokens,
	listInstances,
	loadStore,
	readAdminToken,
	revokeInstallToken,
	revokeReportToken,
	storePath,
	upsertInstance,
	upsertInstaller,
	verifyInstallToken,
	verifyReportToken,
} from "./lib/kb-control-plane.mjs";

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
	OMO_KB_WEBHOOK_SECRET: "webhook-secret",
	OMO_KB_WEBHOOK_SECRET_PREVIOUS: "webhook-secret-previous",
	OMO_KB_WEBHOOK_SECRET_ROTATED_AT: "webhook-secret-rotated-at",
	OMO_KB_LINT_MODE: "lint-mode",
	OMO_KB_MAIN_BRANCH: "main-branch",
	OMO_KB_UI_HOST: "ui-host",
	OMO_KB_UI_PORT: "ui-port",
	OMO_KB_CONTROL_PLANE: "control-plane",
	OMO_KB_INSTALL_BASE_URL: "install-base-url",
};
const configPath = typeof args.config === "string" && args.config !== "" ? args.config : undefined;
/** 配置文件中实际存在的键（重启接力时这些键必须从文件重读，不能被旧 argv 覆盖——轮换/改配置后尤为关键） */
const configKeysInFile = new Set();
if (configPath !== undefined) {
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) {
		console.error(`✗ --config 指定的文件不可读：${configPath}`);
		process.exit(1);
	}
	for (const [key, argName] of Object.entries(CONFIG_KEY_TO_ARG)) {
		if (parsed.values[key] === undefined) continue;
		configKeysInFile.add(argName);
		if (args[argName] !== undefined) continue; // 显式参数优先
		const raw = String(parsed.values[key]).trim();
		if (argName === "ui") {
			if (raw === "on") args.ui = true;
		} else if (raw !== "") args[argName] = raw;
	}
}
const useTls = args["tls-cert"] !== undefined && args["tls-key"] !== undefined;
const UI_ON = args.ui === true || args.ui === "on";
const UI_IDENTITY_HEADER = typeof args["ui-identity-header"] === "string" && args["ui-identity-header"] !== "" ? args["ui-identity-header"] : "X-Auth-Username";
const WEBHOOK_SECRET = typeof args["webhook-secret"] === "string" && args["webhook-secret"] !== "" ? args["webhook-secret"] : undefined;
const WEBHOOK_SECRET_PREVIOUS = typeof args["webhook-secret-previous"] === "string" && args["webhook-secret-previous"] !== "" ? args["webhook-secret-previous"] : undefined;
const WEBHOOK_SECRET_ROTATED_AT = typeof args["webhook-secret-rotated-at"] === "string" && args["webhook-secret-rotated-at"] !== "" ? args["webhook-secret-rotated-at"] : undefined;
/** 双密钥宽限：轮换后旧密钥继续接受 24h（Gitea hook 更新存在传播窗口；到期自动失效）。 */
const WEBHOOK_SECRET_GRACE_MS = 24 * 3600_000;
const LINT_MODE = typeof args["lint-mode"] === "string" ? args["lint-mode"] : "warn"; // off | warn | strict
const MAIN_BRANCH = typeof args["main-branch"] === "string" && args["main-branch"] !== "" ? args["main-branch"] : "main"; // 真机实测定值（yufu/huntian-gateway）

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
const uiHost = args["ui-host"] ?? "127.0.0.1";
const uiPort = Number.parseInt(args["ui-port"] ?? "8788", 10);
const botPrefix = args["bot-prefix"] ?? "omo-bot-";
const audit = new AuditLog(auditFile);
const controlPlaneRoot = args["control-plane"] ?? controlPlaneDir(path.dirname(path.resolve(registryFile)));
const installersFile = storePath(controlPlaneRoot, "installers");
const installTokensFile = storePath(controlPlaneRoot, "tokens");
const instancesFile = storePath(controlPlaneRoot, "instances");
/** webhook 最近一次成功验签（关闭双密钥窗口的判据；不含任何密钥） */
const webhookStateFile = path.join(controlPlaneRoot, "webhook.json");
const adminTokenFile = args["control-token-file"] ?? path.join(controlPlaneRoot, "admin.token");
const adminToken = ensureAdminToken(adminTokenFile).token;
const installerArtifactsDir = args["installer-artifacts"] ?? path.join(controlPlaneRoot, "artifacts");
const installScriptPath = args["install-script"] ?? path.join(import.meta.dir, "install-remote.sh");
const installBaseUrl = args["install-base-url"] ?? `https://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;

/** 自签证书 → CA PEM + SPKI pin（pin 不是 x509 证书指纹）。 */
function tlsMaterial(certPath) {
	if (typeof certPath !== "string" || certPath === "") return undefined;
	let pem;
	try {
		pem = fs.readFileSync(certPath, "utf8");
	} catch {
		return undefined;
	}
	try {
		const cert = new crypto.X509Certificate(pem);
		const der = cert.publicKey.export({ type: "spki", format: "der" });
		return { caPem: pem, pin: `sha256//${crypto.createHash("sha256").update(der).digest("base64")}` };
	} catch {
		// 老运行时兜底：用 openssl 计算 SPKI pin；失败则关闭安装分发（明确报错，不降级 -k）
		const pub = spawnSync("openssl", ["x509", "-in", certPath, "-pubkey", "-noout"], { encoding: "utf8" });
		if (pub.status !== 0) return undefined;
		const der = spawnSync("openssl", ["pkey", "-pubin", "-outform", "DER"], { input: pub.stdout });
		if (der.status !== 0) return undefined;
		const hash = crypto.createHash("sha256").update(der.stdout).digest("base64");
		return { caPem: pem, pin: `sha256//${hash}` };
	}
}
const tls = useTls ? tlsMaterial(args["tls-cert"]) : undefined;

let api;
try {
	api = makeApi(args.api, readAdminAuth(args));
} catch (err) {
	console.error(`✗ ${err.message}`);
	process.exit(1);
}

/* ── 预检：Gitea 可达 + 登记表可读 + （如配 TLS）证书可用
   --check 模式与 /ui 在线改配置共用同一实现（防止两条路径漂移）；返回结构化结果，调用方各自决定措辞。 */
async function preflight(cfg) {
	try {
		await fetch(cfg.api, { signal: AbortSignal.timeout(5000) }); // 任何 HTTP 应答=可达（Gitea 对匿名常 403/404，也算通）
	} catch (err) {
		return { ok: false, detail: `API 不可达 ${cfg.api}（${String(err?.cause?.code ?? err?.message ?? err)}）` };
	}
	try {
		loadRegistry(cfg.registryFile);
	} catch (err) {
		return { ok: false, detail: `登记表不可读 ${cfg.registryFile}（${String(err?.message ?? err)}）` };
	}
	if (cfg.tlsCert !== undefined && cfg.tlsKey !== undefined) {
		try {
			const probe = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				tls: { cert: Bun.file(cfg.tlsCert), key: Bun.file(cfg.tlsKey) },
				fetch: () => json(200, { ok: true }),
			});
			probe.stop(true);
		} catch (err) {
			return { ok: false, detail: `监听/证书不可用（${String(err?.message ?? err)}）` };
		}
	}
	return { ok: true };
}

/* ── --check 预检模式：运维可手动执行验证配置 ⇒ 退出 */
if (args.check === true) {
	const verdict = await preflight({ api: args.api, registryFile, tlsCert: args["tls-cert"], tlsKey: args["tls-key"] });
	if (!verdict.ok) {
		console.error(`CHECK FAIL: ${verdict.detail}`);
		process.exit(1);
	}
	console.log(`CHECK OK repo=${args.repo} api=${args.api} port=${port} registry=${registryFile} ui=${UI_ON ? "on" : "off"}`);
	process.exit(0);
}

/* ── /kb/webhook：合流期 lint 门禁（KBORG-1）──
   Gitea PR 事件（opened/synchronized，base=main）⇒ 拉 PR 变更文件 ⇒ 结构规则 + 相似度 ⇒
   回写 commit status（context=kb-lint）与 PR 评论。HMAC-SHA256 签名防伪造；恒 200（幂等）。 */

/** 双密钥验签：current 优先；轮换后 previous 在 24h 宽限内仍接受（到期拒绝）。 */
function webhookSecretVerdict(body, sig, now = Date.now()) {
	const verdict = verifyHmacWithRotation(
		{ current: WEBHOOK_SECRET, previous: WEBHOOK_SECRET_PREVIOUS, rotatedAt: WEBHOOK_SECRET_ROTATED_AT, graceMs: WEBHOOK_SECRET_GRACE_MS },
		body,
		sig,
		now,
	);
	return verdict.via === "none" ? undefined : verdict;
}

/** 最近一次成功验签（0600，原子写；只存时间与来源，不含密钥） */
function readWebhookState() {
	try {
		const raw = JSON.parse(fs.readFileSync(webhookStateFile, "utf8"));
		return raw !== null && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}
function recordWebhookVerified(via) {
	try {
		atomicWriteJson(webhookStateFile, { ...readWebhookState(), lastVerifiedAt: new Date().toISOString(), via });
	} catch (err) {
		audit.append({ event: "webhook.state-write-failed", reason: String(err?.message ?? err) });
	}
}

function webhookSecretView(now = Date.now()) {
	const rotatedAt = Date.parse(WEBHOOK_SECRET_ROTATED_AT ?? "");
	const previousActive = WEBHOOK_SECRET_PREVIOUS !== undefined && Number.isFinite(rotatedAt) && now - rotatedAt <= WEBHOOK_SECRET_GRACE_MS;
	return {
		configured: WEBHOOK_SECRET !== undefined,
		previousActive,
		rotatedAt: Number.isFinite(rotatedAt) ? new Date(rotatedAt).toISOString() : undefined,
		previousExpiresAt: previousActive ? new Date(rotatedAt + WEBHOOK_SECRET_GRACE_MS).toISOString() : undefined,
		lastVerifiedAt: readWebhookState().lastVerifiedAt,
	};
}

async function handleKbWebhook(req, ip) {
	if (LINT_MODE === "off" || WEBHOOK_SECRET === undefined) return json(503, { error: "lint 未启用（需 --webhook-secret 且 --lint-mode 非 off）" });
	const raw = await req.text();
	// Gitea 原生 webhook 的签名头是 X-Gitea-Signature；X-KB-Signature 作为自建调用方的等价头保留
	const sig = req.headers.get("X-Gitea-Signature") ?? req.headers.get("X-KB-Signature") ?? "";
	const secret = webhookSecretVerdict(raw, sig);
	if (secret === undefined) {
		audit.append({ event: "webhook.denied", ts: new Date().toISOString(), ip });
		return json(401, { error: "签名校验失败" });
	}
	recordWebhookVerified(secret.via);
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return json(400, { error: "请求体必须是 JSON" });
	}
	const pr = payload?.pull_request;
	const action = payload?.action;
	if (pr === undefined || !["opened", "synchronized"].includes(action)) return json(200, { ignored: true, reason: "非 PR opened/synchronized 事件" });
	if (pr.base?.ref !== MAIN_BRANCH) return json(200, { ignored: true, reason: `非 ${MAIN_BRANCH} 目标分支` });
	if (payload.repository?.full_name !== undefined && payload.repository.full_name !== args.repo) return json(200, { ignored: true, reason: "仓库不匹配" });
	const number = payload.number ?? pr.number;
	const sha = String(pr.head?.sha ?? "");
	try {
		const domainsRes = await api.get(`/repos/${args.repo}/contents/domains.yml`);
		const domainsText = domainsRes.status === 200 && domainsRes.json?.content !== undefined ? Buffer.from(domainsRes.json.content, "base64").toString("utf8") : undefined;
		const filesRes = await api.get(`/repos/${args.repo}/pulls/${number}/files?limit=50`);
		const changed = (filesRes.json ?? []).map((f) => f.filename);
		const contents = [];
		for (const f of (filesRes.json ?? []).slice(0, 30)) {
			if (!/\.(md|json)$/.test(f.filename)) continue;
			const c = await api.get(`/repos/${args.repo}/contents/${f.filename}?ref=${sha}`);
			if (c.status === 200 && c.json?.content !== undefined) contents.push({ path: f.filename, text: Buffer.from(c.json.content, "base64").toString("utf8") });
		}
		const existing = [];
		for (const d of new Set(changed.map((p) => p.split("/")[0]))) {
			if (d === "") continue;
			const e = await api.get(`/repos/${args.repo}/contents/${d}/README.md?ref=${MAIN_BRANCH}`);
			if (e.status === 200 && e.json?.content !== undefined) existing.push({ domain: d, path: `${d}/README.md`, text: Buffer.from(e.json.content, "base64").toString("utf8") });
		}
		const struct = lintStructure({ changedPaths: changed, contents, domainsText });
		const sim = lintSimilarity({ contents, existing, thresholds: { block: 0.9, warn: 0.5 } });
		const hard = [...struct.hard, ...sim.hard];
		const warnings = [...struct.warnings, ...sim.warnings];
		const blocked = LINT_MODE === "strict" && hard.length > 0;
		const comment = buildComment({ mode: LINT_MODE, hard, warnings });
		const statusRes = await api.post(`/repos/${args.repo}/statuses/${sha}`, {
			state: blocked ? "failure" : "success",
			context: "kb-lint",
			description: (blocked ? `✗ ${hard.length} 条违规` : warnings.length > 0 ? `⚠ ${warnings.length} 条提示` : "✓ 合规").slice(0, 200),
		});
		if (!statusRes.ok) {
			audit.append({ event: "lint.status-write-failed", ts: new Date().toISOString(), pr: number, sha: sha.slice(0, 8), mode: LINT_MODE, httpStatus: statusRes.status, detail: String(statusRes.text ?? "").slice(0, 300), actor: "webhook", ip });
			return json(200, { ok: false, gateApplied: false, blocked, hard: hard.length, warnings: warnings.length, error: `status 回写失败 HTTP ${statusRes.status}（已入审计）` });
		}
		let commentWritten;
		let commentError;
		if (comment !== "") {
			const commentRes = await api.post(`/repos/${args.repo}/issues/${number}/comments`, { body: comment });
			commentWritten = commentRes.ok;
			if (!commentRes.ok) {
				commentError = `HTTP ${commentRes.status}`;
				audit.append({ event: "lint.comment-write-failed", ts: new Date().toISOString(), pr: number, sha: sha.slice(0, 8), mode: LINT_MODE, httpStatus: commentRes.status, detail: String(commentRes.text ?? "").slice(0, 300), actor: "webhook", ip });
			}
		}
		audit.append({ event: `lint.${blocked ? "blocked" : "passed"}`, ts: new Date().toISOString(), pr: number, sha: sha.slice(0, 8), mode: LINT_MODE, hard: hard.length, warnings: warnings.length, statusWritten: true, commentWritten: comment === "" ? "skipped" : commentWritten, actor: "webhook", secretVia: secret.via, ip });
		return json(200, { ok: true, gateApplied: true, blocked, hard: hard.length, warnings: warnings.length, statusWritten: true, ...(comment === "" ? { commentSkipped: true } : { commentWritten, ...(commentWritten ? {} : { commentError }) }) });
	} catch (err) {
		audit.append({ event: "lint.error", ts: new Date().toISOString(), reason: String(err?.message ?? err), ip });
		return json(200, { ok: false, error: `lint 执行失败（已入审计）：${String(err?.message ?? err)}` });
	}
}

/* ── /ui 管理后台（yufu 网关信任模式：身份头缺失一律 401）── */
let uiPageCache;
function uiPageResponse() {
	try {
		if (uiPageCache === undefined) uiPageCache = fs.readFileSync(path.join(import.meta.dir, "ui", "index.html"), "utf8");
		// no-store：升级后不得命中浏览器/中间层旧页（真机教训：升了版本页面还是老样子）
		return new Response(uiPageCache, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, must-revalidate" } });
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
		// 与 GET /ui/api/config 同形状（{keys, values}）——两种形状曾导致配置表单渲染为空（headless 抓到）
		configView = parsed === undefined
			? { error: "配置文件不可读" }
			: { keys: Object.fromEntries(Object.entries(UI_CONFIG_KEYS).map(([k, m]) => [k, m.label])), values: maskConfigForUi(parsed.values) };
	}
	const auditTailView = auditTail(50);
	let control;
	try {
		control = {
			installers: listInstallers(installersFile),
			installTokens: listInstallTokens(installTokensFile),
			instances: listInstances(instancesFile).map((x) => instanceView(x)),
		};
	} catch (err) {
		control = { error: String(err?.message ?? err) };
	}
	return json(200, {
		actor,
		health: { ok: true, repo: args.repo, registryVersion: REGISTRY_VERSION, tls: useTls, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
		ui: { on: UI_ON, identityHeader: UI_IDENTITY_HEADER, configPath: configPath ?? null, adminTokenFile, uiHost, uiPort, installBaseUrl, tlsPin: tls?.pin },
		config: configView,
		registry: { entries, pendingCodes, file: registryFile, ...(registryError === undefined ? {} : { error: registryError }) },
		controlPlane: control,
		gate: { mode: LINT_MODE, mainBranch: MAIN_BRANCH, webhookConfigured: WEBHOOK_SECRET !== undefined, webhookSecret: webhookSecretView() },
		content: (() => {
			const provider = /gitlab/i.test(args.api) ? "gitlab" : "gitea";
			return { repo: args.repo, url: repoWebPath(args.api, args.repo), provider, management: provider === "gitea" };
		})(),
		auditTail: auditTailView,
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

async function readJson(req) {
	try {
		return { ok: true, body: await req.json() };
	} catch {
		return { ok: false, response: json(400, { error: "请求体必须是 JSON" }) };
	}
}

async function handleUiInstallTokenPost(req, ip, actor) {
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body ?? {};
	if (typeof body.version !== "string" || body.version === "") return json(400, { error: "缺少 version" });
	const channel = typeof body.channel === "string" && body.channel !== "" ? body.channel : "stable";
	const device = typeof body.device === "string" ? body.device.trim() : undefined;
	const ttlMin = body.ttlMin === undefined ? 60 : Number(body.ttlMin);
	try {
		const issued = await issueInstallToken(installTokensFile, { version: body.version, channel, device, ttlMin, createdBy: `ui:${actor}` });
		const command = buildInstallCommand(issued.token, issued.record);
		if (command === undefined) return json(503, { error: "安装分发需要 TLS（自签 CA + pin）；当前服务未启用 TLS" });
		audit.append({ event: "ui.install-token.issued", installId: issued.record.installId, version: body.version, channel, device, actor, ip, expiresAt: issued.record.expiresAt });
		return json(200, {
			ok: true,
			token: issued.token,
			installId: issued.record.installId,
			version: body.version,
			channel,
			device,
			expiresAt: issued.record.expiresAt,
			tokenFile: "$HOME/.omo-install.token",
			command,
			hint: "令牌只显示这一次；先写入 0600 token 文件，再执行 command；安装完成后删除 token 文件。",
		});
	} catch (err) {
		return json(400, { error: String(err?.message ?? err) });
	}
}

function handleUiInstallers(req, u, ip, actor) {
	if (req.method === "GET") {
		try {
			return json(200, { ok: true, installers: listInstallers(installersFile) });
		} catch (err) {
			return json(500, { error: `installers 不可读：${String(err?.message ?? err)}` });
		}
	}
	return json(405, { error: "method not allowed" });
}

async function handleUiInstallerPost(req, ip, actor) {
	const parsed = await readJson(req);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body ?? {};
	if (typeof body.version !== "string" || body.version === "") return json(400, { error: "缺少 version" });
	let scriptHash = body.script_sha256;
	if (typeof scriptHash !== "string" || !/^[0-9a-f]{64}$/.test(scriptHash)) {
		try {
			scriptHash = crypto.createHash("sha256").update(fs.readFileSync(installScriptPath)).digest("hex");
		} catch (err) {
			return json(500, { error: `无法计算安装脚本哈希：${String(err?.message ?? err)}` });
		}
	}
	try {
		const record = await upsertInstaller(installersFile, {
			version: body.version,
			channel: body.channel ?? "stable",
			script_sha256: scriptHash,
			manifest: body.manifest ?? { version: body.version, platforms: [] },
			status: body.status ?? "available",
			createdAt: body.createdAt,
		});
		audit.append({ event: "ui.installer.upserted", version: record.version, channel: record.channel, actor, ip });
		return json(200, { ok: true, installer: record });
	} catch (err) {
		return json(400, { error: String(err?.message ?? err) });
	}
}

async function handleUiArtifactUpload(req, u, version, ip, actor) {
	const name = u.searchParams.get("name") ?? "";
	const os = u.searchParams.get("os") ?? "linux";
	const arch = u.searchParams.get("arch") ?? "x86_64";
	if (name === "" || path.basename(name) !== name || name.includes("..")) return json(400, { error: "制品名非法" });
	let installer;
	try {
		installer = listInstallers(installersFile).find((x) => x.version === version);
	} catch (err) {
		return json(500, { error: `installers 不可读：${String(err?.message ?? err)}` });
	}
	if (installer === undefined) return json(404, { error: `没有安装版本 ${version}` });
	let body;
	try {
		body = Buffer.from(await req.arrayBuffer());
	} catch {
		return json(400, { error: "无法读取上传内容" });
	}
	if (body.length === 0) return json(400, { error: "空制品" });
	const max = 512 * 1024 * 1024;
	if (body.length > max) return json(413, { error: "制品超过 512MB 上限" });
	const hash = crypto.createHash("sha256").update(body).digest("hex");
	fs.mkdirSync(installerArtifactsDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(installerArtifactsDir, name), body, { mode: 0o600 });
	const manifest = installer.manifest ?? { version: installer.version, platforms: [] };
	const platforms = Array.isArray(manifest.platforms) ? manifest.platforms.filter((p) => p?.artifact !== name) : [];
	platforms.push({ os, arch, artifact: name, sha256: hash, size: body.length, curl: "modern|legacy", openssl: "required-for-legacy" });
	await upsertInstaller(installersFile, { ...installer, manifest: { ...manifest, platforms } });
	audit.append({ event: "ui.installer.artifact", version, name, os, arch, sha256: hash, size: body.length, actor, ip });
	return json(200, { ok: true, name, sha256: hash, size: body.length, os, arch });
}

function handleUiInstances(req, u, ip, actor) {
	if (req.method !== "GET") return json(405, { error: "method not allowed" });
	try {
		return json(200, { ok: true, instances: listInstances(instancesFile).map((x) => instanceView(x)) });
	} catch (err) {
		return json(500, { error: `instances 不可读：${String(err?.message ?? err)}` });
	}
}

async function handleUiInstanceAction(req, u, id, action, ip, actor) {
	if (req.method !== "POST") return json(405, { error: "method not allowed" });
	if (action !== "rotate" && action !== "revoke") return json(404, { error: "not found" });
	let instance;
	try {
		instance = listInstances(instancesFile).find((x) => x.installId === id || x.id === id);
	} catch (err) {
		return json(500, { error: `instances 不可读：${String(err?.message ?? err)}` });
	}
	if (instance === undefined) return json(404, { error: "实例不存在" });
	const device = instance.device;
	try {
		if (action === "revoke") {
			await revokeReportToken(instancesFile, instance.installId);
			await upsertInstance(instancesFile, { installId: instance.installId, status: "revoked", revokedAt: new Date().toISOString() });
		}
		const { code, expiresAt } = issueCode(registryFile, { op: action, device, ttlMin: codeTtlMin, by: `ui:${actor}` });
		audit.append({ event: `ui.instance.${action}`, installId: instance.installId, device, actor, ip, expiresAt });
		return json(200, { ok: true, code, expiresAt, device, hint: `omo kb enroll --server ${installBaseUrl} --code-file <0600 码文件>` });
	} catch (err) {
		return json(400, { error: String(err?.message ?? err) });
	}
}

/**
 * 审计尾部读视图（可选过滤）：
 *   event=前缀（如 install. / ui. / enroll.）· actor=精确 · installId=精确 · q=子串（事件/设备/原因）
 * 过滤在解析后内存中做；任何响应都不含秘密本体（审计行本身不含秘密）。
 */
function auditTail(limit = 50, { event, actor, installId, q } = {}) {
	try {
		const lines = fs.readFileSync(auditFile, "utf8").split("\n").filter((l) => l.trim() !== "");
		const out = [];
		for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
			let r;
			try {
				r = JSON.parse(lines[i]);
			} catch {
				if (!event && !actor && !installId && !q) out.push({ raw: lines[i].slice(0, 80) });
				continue;
			}
			if (event !== undefined && event !== "" && !String(r.event ?? "").startsWith(event)) continue;
			if (actor !== undefined && actor !== "" && r.actor !== actor) continue;
			if (installId !== undefined && installId !== "" && r.installId !== installId) continue;
			if (q !== undefined && q !== "" && !`${r.event ?? ""} ${r.device ?? ""} ${r.reason ?? ""} ${r.detail ?? ""}`.toLowerCase().includes(String(q).toLowerCase())) continue;
			out.push({
				seq: r.seq, ts: r.ts, event: r.event, actor: r.actor, device: r.device, ip: r.ip, installId: r.installId,
				stage: r.stage, step: r.step, reason: r.reason, version: r.version, name: r.name,
			});
		}
		return out.reverse();
	} catch {
		return [];
	}
}

/** 重启接力：新进程带绑定重试先起，等旧进程让位（窗口 <1s，/healthz 短暂拒绝属预期） */
function successorArgs() {
	// 只丢弃「UI 白名单可改」的键（以 config 文件新值为准）；管理员凭据路径不在 UI 白名单内 ⇒ 原样接力，
	// 否则预检/重启子进程丢凭据必假失败（V6 真机教训）。
	const drop = new Set([
		"api", "repo", "team", "permission", "grant", "host", "port", "tls-cert", "tls-key", "registry", "audit", "config",
		"ui", "ui-identity-header", "ui-host", "ui-port", "control-plane", "control-token-file", "install-base-url", "install-script", "installer-artifacts",
	]);
	const out = [process.execPath, import.meta.path];
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		if (drop.has(key) || configKeysInFile.has(key)) {
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
	// 预检走**进程内**同名实现（不再 spawn 一个 --check 子进程）：bun 拉起 bun 子进程在 Windows 上要
	// 同步阻塞约 3 秒（真机实测 3.2s），会把正在服务的事件循环卡住——而预检本就不需要第二个进程。
	const merged = { ...parsed.values, ...strValues };
	const verdictPre = await preflight({
		api: merged.OMO_KB_API ?? args.api,
		registryFile: merged.OMO_KB_REGISTRY ?? registryFile,
		tlsCert: merged.OMO_KB_TLS_CERT ?? args["tls-cert"],
		tlsKey: merged.OMO_KB_TLS_KEY ?? args["tls-key"],
	});
	if (!verdictPre.ok) {
		restoreConfigBackup(configPath);
		const detail = `CHECK FAIL: ${verdictPre.detail}`;
		audit.append({ event: "ui.config.preflight_failed", ts: new Date().toISOString(), actor, detail, ip });
		return json(400, { error: "预检失败，已回滚配置，服务未重启", detail });
	}
	audit.append({ event: "ui.config.updated", ts: new Date().toISOString(), actor, changed: Object.keys(strValues), ip });
	scheduleRestart();
	return json(200, { ok: true, restarting: true, detail: "配置已写入并通过预检，服务正在切换（<1s 窗口）" });
}

/**
 * 重启接力。两条 Windows 真机实测约束（详见执行记录 CIPORT-1）：
 *   1) **先放掉监听**再拉接班进程——旧进程还占着端口时，新进程只会绑失败（TLS 连接回收更慢）；
 *   2) 接班进程必须 detached——父进程退出会带走「直接 spawn」的子进程，服务会静默消失、pid 文件停在旧值。
 * 顺序：先返回响应（连接要活着）→ 300ms 后在计时器里停监听、拉接班、退出。
 */
function scheduleRestart() {
	setTimeout(() => {
		try {
			uiServer?.stop(true);
		} catch { /* 已停 */ }
		try {
			server.stop(true);
		} catch { /* 已停 */ }
		Bun.spawn(successorArgs(), { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true, env: { ...process.env, OMO_KB_BIND_RETRY_MS: "20000" } }).unref();
		setTimeout(() => process.exit(0), 200);
	}, 300);
}

/**
 * webhook secret 轮换（P1-2）：顺序 = Gitea 先换 → 配置落盘（旧密钥转 previous，24h 宽限）→ 重启生效。
 * 回滚：配置写盘失败 ⇒ 把 Gitea hook 改回旧密钥；绝不出现「Gitea 新、服务旧」的持久错位。
 */
async function handleUiGateRotateSecret(req, ip, actor) {
	if (configPath === undefined) return json(400, { error: "服务未经 --config 启动，无法轮换 webhook secret" });
	if (WEBHOOK_SECRET === undefined) return json(400, { error: "当前未配置 webhook secret（OMO_KB_WEBHOOK_SECRET）；先配置并重启后再轮换" });
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) return json(400, { error: `配置文件不可读：${configPath}` });
	const webhookUrl = `${installBaseUrl}/kb/webhook`;
	const newSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
	let hook;
	try {
		hook = await ensureWebhook(api, args.repo, webhookUrl, newSecret);
	} catch (err) {
		audit.append({ event: "ui.gate.secret.rotate_failed", actor, ip, stage: "gitea", reason: String(err?.message ?? err) });
		return json(502, { error: `Gitea webhook 更新失败（本地密钥未变）：${String(err?.message ?? err)}` });
	}
	const rotatedAt = new Date().toISOString();
	try {
		writeConfigEnvAtomic(configPath, renderConfigEnv(parsed, {
			OMO_KB_WEBHOOK_SECRET: newSecret,
			OMO_KB_WEBHOOK_SECRET_PREVIOUS: WEBHOOK_SECRET,
			OMO_KB_WEBHOOK_SECRET_ROTATED_AT: rotatedAt,
		}));
	} catch (err) {
		let rollback = "ok";
		try {
			await ensureWebhook(api, args.repo, webhookUrl, WEBHOOK_SECRET);
		} catch (e2) {
			rollback = String(e2?.message ?? e2);
		}
		audit.append({ event: "ui.gate.secret.rotate_failed", actor, ip, stage: "config", reason: String(err?.message ?? err), giteaRollback: rollback });
		return json(500, { error: `配置写盘失败：${String(err?.message ?? err)}；Gitea 回滚=${rollback}` });
	}
	audit.append({ event: "ui.gate.secret.rotated", actor, ip, hook, rotatedAt, graceHours: WEBHOOK_SECRET_GRACE_MS / 3600_000 });
	scheduleRestart();
	// 新密钥只回显这一次（UI 需用它核对 Gitea）；旧密钥在 24h 宽限内仍被接受
	return json(200, {
		ok: true,
		restarting: true,
		secret: newSecret,
		webhookUrl,
		rotatedAt,
		previousExpiresAt: new Date(Date.parse(rotatedAt) + WEBHOOK_SECRET_GRACE_MS).toISOString(),
		detail: "Gitea 已切换新密钥；服务重启中。旧密钥在宽限期内仍接受，过期自动失效。",
	});
}

/**
 * 关闭双密钥宽限窗口（设计 §7.6.1 关闭条件）：
 * 必须已观测到新密钥验签成功（lastVerifiedAt ≥ rotatedAt），否则拒绝——防止 Gitea 尚未切换就删旧密钥。
 */
async function handleUiSecretClose(req, ip, actor) {
	if (configPath === undefined) return json(400, { error: "服务未经 --config 启动，无法关闭宽限窗口" });
	if (WEBHOOK_SECRET_PREVIOUS === undefined) return json(400, { error: "当前没有待关闭的旧密钥" });
	const state = readWebhookState();
	const rotatedAt = Date.parse(WEBHOOK_SECRET_ROTATED_AT ?? "");
	const verifiedAt = Date.parse(state.lastVerifiedAt ?? "");
	if (!Number.isFinite(verifiedAt) || (Number.isFinite(rotatedAt) && verifiedAt < rotatedAt)) {
		return json(400, { error: "尚未观测到新密钥验签成功：先让 Gitea 触发一次 webhook（验签通过）再关闭宽限" });
	}
	const parsed = readConfigEnv(configPath);
	if (parsed === undefined) return json(400, { error: `配置文件不可读：${configPath}` });
	writeConfigEnvAtomic(configPath, removeConfigKeys(parsed, ["OMO_KB_WEBHOOK_SECRET_PREVIOUS", "OMO_KB_WEBHOOK_SECRET_ROTATED_AT"]));
	audit.append({ event: "ui.gate.secret.window_closed", actor, ip, rotatedAt: WEBHOOK_SECRET_ROTATED_AT, verifiedAt: state.lastVerifiedAt });
	scheduleRestart();
	return json(200, { ok: true, restarting: true, detail: "旧密钥宽限已关闭：重启后仅新密钥有效" });
}

/* ---------------- 限流：同一来源 1 分钟内最多 10 次失败 ---------------- */
const failures = new Map();
function throttled(ip) {
	const now = Date.now();
	// 顺带清扫过期项：键是任意来源 IP，不清扫则随扫描/扫描器流量无界增长
	if (failures.size > 1024) {
		for (const [k, v] of failures) if (now - v.since > 60_000) failures.delete(k);
	}
	const rec = failures.get(ip) ?? { n: 0, since: now };
	if (now - rec.since > 60_000) {
		rec.n = 0;
		rec.since = now;
	}
	rec.n++;
	failures.set(ip, rec);
	return rec.n > 10;
}

/* ---------------- 兑换码在途去重：check 与 consume 之间存在多个 await（Gitea 调用），
   同一码并发提交可双双通过 checkCode（TOCTOU）。在途集合在事件循环内同步判重，窗口归零。 ---------------- */
const codesInFlight = new Set();

function json(status, body) {
	return new Response(`${JSON.stringify(body)}\n`, { status, headers: { "Content-Type": "application/json" } });
}

/* ── 管理面认证：所有 /ui/api/* 必须携带 control-plane/admin.token；yufu 头仅作 actor ── */
function controlActor(req) {
	return identityFromRequest(req, UI_IDENTITY_HEADER) ?? "admin";
}
function controlAuthorized(req) {
	return typeof adminToken === "string" && adminToken !== "" && bearerToken(req) === adminToken;
}

/* ── 安装面认证：一次性安装令牌；错误码区分过期/完成/吊销/设备不匹配 ── */
async function installAuth(req, { activate = false } = {}) {
	const token = bearerToken(req);
	if (token === undefined) return { error: json(401, { error: "缺少安装令牌" }) };
	let verdict;
	try {
		verdict = verifyInstallToken(installTokensFile, token);
	} catch (err) {
		return { error: json(500, { error: `控制面安装令牌存储不可读：${String(err?.message ?? err)}` }) };
	}
	if (!verdict.ok) {
		const status = verdict.reason === "expired" ? 410 : verdict.reason === "completed" ? 409 : verdict.reason === "device_mismatch" ? 403 : verdict.reason === "revoked" ? 403 : 401;
		return { error: json(status, { error: `安装令牌不可用：${verdict.reason}` }) };
	}
	if (activate) {
		try {
			await activateInstallToken(installTokensFile, token);
		} catch (err) {
			return { error: json(409, { error: String(err?.message ?? err) }) };
		}
	}
	return { token, record: verdict.record };
}

function installerFor(record) {
	const all = listInstallers(installersFile);
	return all.find((x) => x.version === record.version && (x.channel ?? "stable") === (record.channel ?? "stable"));
}

function artifactFor(installer, name) {
	const platforms = installer?.manifest?.platforms;
	if (!Array.isArray(platforms)) return undefined;
	if (typeof name !== "string" || name === "" || path.basename(name) !== name || name.includes("..")) return undefined;
	return platforms.find((p) => p?.artifact === name);
}

function buildInstallCommand(token, record) {
	if (tls === undefined) return undefined;
	// 令牌不写进命令；命令从 0600 文件读取。UI 同时把明文令牌单独显示一次。
	return [
		`export OMO_CONTROL_PLANE=${JSON.stringify(installBaseUrl)}`,
		`export OMO_TLS_PIN=${JSON.stringify(tls.pin)}`,
		`export OMO_INSTALL_TOKEN_FILE="$HOME/.omo-install.token"   # 0600；把本次令牌写入后执行`,
		`TMPD="$(mktemp -d)"; umask 077; trap 'rm -rf "$TMPD"' EXIT`,
		`cat > "$TMPD/ca.pem" <<'CA'`,
		tls.caPem.trim(),
		"CA",
		`printf 'Authorization: Bearer %s\\n' "$(cat "$OMO_INSTALL_TOKEN_FILE")" > "$TMPD/headers"`,
		`curl -fsS --cacert "$TMPD/ca.pem" --pinnedpubkey "$OMO_TLS_PIN" --header @"$TMPD/headers" "$OMO_CONTROL_PLANE/install/manifest" -o "$TMPD/manifest.json"`,
		`EXPECTED="$(sed -n 's/.*"script_sha256"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{64\\}\\)".*/\\1/p' "$TMPD/manifest.json" | head -1)"`,
		`[ -n "$EXPECTED" ] || { echo "✗ manifest 缺 script_sha256" >&2; exit 1; }`,
		`curl -fsS --cacert "$TMPD/ca.pem" --pinnedpubkey "$OMO_TLS_PIN" --header @"$TMPD/headers" "$OMO_CONTROL_PLANE/install/script" -o "$TMPD/install.sh"`,
		`ACTUAL="$(sha256sum "$TMPD/install.sh" | awk '{print $1}')"`,
		`[ "$ACTUAL" = "$EXPECTED" ] || { echo "✗ script.sha256 不匹配" >&2; exit 1; }`,
		`export OMO_TLS_CA_FILE="$TMPD/ca.pem"`,
		`sh "$TMPD/install.sh"`,
	].join("\n");
}

/** 设备名 → bot 账号名（小写、仅 [a-z0-9-]，稳定可预期，便于审计对账） */
function loginFor(device) {
	const slug = String(device ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	if (slug === "") throw new Error("device 非法（需要非空设备名）");
	return `${botPrefix}${slug}`;
}

async function provisionCredential({ device, agentId, ip, op = "enroll", actor = "enroll", installId }) {
	const login = loginFor(device);
	const logs = [];
	const log = (s) => logs.push(s);
	const secret = randomPassword();
	await ensureUser(api, login, secret, log);
	await grantAccess(api, args.repo, login, grant, team, permission, log);
	const probe = await verifyBotCredential(api, args.repo, login, secret);
	if (!probe.ok) {
		audit.append({ event: "enroll.failed", device, agentId, login, reason: `自证失败 HTTP ${probe.status}`, detail: logs.join("; "), ip, actor });
		return { ok: false, status: 500, error: `供给后自证失败（HTTP ${probe.status}），未发放凭据` };
	}
	log(`凭据自证 GET /repos/${args.repo} ✓ ${probe.status}`);
	const credential = credentialJson(api.base, args.repo, login, secret, "password");
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
	audit.append({ event: `enroll.${op}`, device, agentId, login, detail: logs.join("; "), ip, actor, ...(installId === undefined ? {} : { installId }) });
	return { ok: true, op, credential, detail: logs };
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

	const codeHash = sha256(String(code));
	if (codesInFlight.has(codeHash)) {
		audit.append({ event: "enroll.rejected", device, reason: "in_flight", ip });
		return json(409, { error: "兑换码正在处理中，请勿并发提交" });
	}
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
	codesInFlight.add(codeHash);
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
		const result = await provisionCredential({ device, agentId, ip, op, actor: "enroll" });
		if (result.ok !== true) return json(result.status ?? 500, { error: result.error });
		consumeCode(registryFile, code, `${device}`);
		return json(200, result);
	} catch (err) {
		audit.append({ event: "enroll.error", device, agentId, op, reason: String(err?.message ?? err), ip });
		return json(500, { error: `服务侧失败：${String(err?.message ?? err)}` });
	} finally {
		codesInFlight.delete(codeHash);
	}
}

/* ─────────────── 安装分发面（/install/*，安装令牌鉴权） ─────────────── */
async function handleInstall(req, u, ip) {
	const pathname = u.pathname;
	// 上报可凭实例上报令牌（长期）或一次性安装令牌；两者都不是时由内部返回 401/410/409
	if (pathname === "/install/report" && req.method === "POST") return await handleInstallReport(req, ip);
	const auth = await installAuth(req, { activate: pathname === "/install/manifest" || pathname === "/install/script" });
	if (auth.error !== undefined) return auth.error;
	const record = auth.record;
	const installer = installerFor(record);
	if (installer === undefined) return json(404, { error: `没有可用安装版本 ${record.version}/${record.channel}` });

	if (pathname === "/install/manifest" && req.method === "GET") {
		const scriptHash = installer.script_sha256;
		const osq = u.searchParams.get("os");
		const archq = u.searchParams.get("arch");
		let selected;
		if (osq !== null && archq !== null) {
			selected = (installer.manifest?.platforms ?? []).find((p) => p?.os === osq && p?.arch === archq);
			if (selected === undefined) return json(404, { error: `没有匹配平台 ${osq}/${archq} 的制品` });
		}
		audit.append({ event: "install.manifest", installId: record.installId, version: installer.version, step: "manifest", os: osq ?? undefined, arch: archq ?? undefined, ip });
		return json(200, {
			version: installer.version,
			channel: installer.channel,
			script_sha256: scriptHash,
			manifest: installer.manifest,
			...(selected === undefined ? {} : { artifact_name: selected.artifact, artifact_sha256: selected.sha256, artifact_size: selected.size }),
			kb: { server: installBaseUrl, repo: args.repo, mainBranch: MAIN_BRANCH },
			expiresAt: record.expiresAt,
		});
	}
	if (pathname === "/install/script" && req.method === "GET") {
		let script;
		try {
			script = fs.readFileSync(installScriptPath, "utf8");
		} catch (err) {
			return json(500, { error: `安装脚本缺失：${String(err?.message ?? err)}` });
		}
		const hash = crypto.createHash("sha256").update(script).digest("hex");
		if (typeof installer.script_sha256 === "string" && installer.script_sha256 !== hash) {
			return json(500, { error: "安装脚本与 manifest 哈希不一致" });
		}
		audit.append({ event: "install.script", installId: record.installId, version: installer.version, step: "script", sha256: hash, ip });
		return new Response(script, { headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "X-Content-SHA256": hash, "Cache-Control": "no-store" } });
	}
	if (pathname.startsWith("/install/artifacts/") && req.method === "GET") {
		const name = decodeURIComponent(pathname.slice("/install/artifacts/".length));
		const artifact = artifactFor(installer, name);
		if (artifact === undefined) return json(404, { error: "制品不在 manifest 白名单" });
		const file = path.join(installerArtifactsDir, name);
		if (path.dirname(file) !== path.resolve(installerArtifactsDir) && path.dirname(path.resolve(file)) !== path.resolve(installerArtifactsDir)) {
			return json(400, { error: "非法制品路径" });
		}
		let st;
		try {
			st = fs.statSync(file);
		} catch {
			return json(404, { error: "制品不存在（请先在控制面上传/缓存）" });
		}
		if (!st.isFile()) return json(404, { error: "制品不是文件" });
		audit.append({ event: "install.artifact", installId: record.installId, version: installer.version, step: "artifact", name, size: st.size, ip });
		return new Response(Bun.file(file), { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(st.size) } });
	}
	if (pathname === "/install/enroll" && req.method === "POST") {
		return await handleInstallEnroll(req, ip, record);
	}
	return json(404, { error: "not found" });
}

async function handleInstallEnroll(req, ip, record) {
	{
		let body;
		try {
			body = await req.json();
		} catch {
			return json(400, { error: "请求体必须是 JSON" });
		}
		const device = typeof body?.device === "string" && body.device !== "" ? body.device : record.device;
		if (typeof device !== "string" || device === "") return json(400, { error: "缺少 device（令牌未绑定设备时需提供）" });
		if (record.device !== undefined && record.device !== "" && record.device !== device) return json(403, { error: "安装令牌与本设备不匹配" });
		try {
			const result = await provisionCredential({ device, agentId: body?.agent_id, ip, op: "enroll", actor: `install:${record.installId}`, installId: record.installId });
			if (result.ok !== true) return json(result.status ?? 500, { error: result.error });
			let reportToken;
			try {
				await upsertInstance(instancesFile, {
					installId: record.installId,
					device,
					version: record.version,
					status: "enrolled",
					lastSeen: new Date().toISOString(),
					credential: { username: result.credential?.username, kind: result.credential?.kind },
				});
				reportToken = (await issueReportToken(instancesFile, record.installId)).token;
			} catch (err) {
				audit.append({ event: "install.report-token.failed", installId: record.installId, device, reason: String(err?.message ?? err), ip });
				return json(500, { error: `实例登记失败（凭据已发放，但无法上报）：${String(err?.message ?? err)}` });
			}
			// 上报令牌只出现这一次；客户端落盘 0600 供 `omo kb status --report` 使用
			return json(200, {
				ok: true,
				op: result.op,
				credential: result.credential,
				detail: result.detail,
				installId: record.installId,
				control_plane: installBaseUrl,
				version: record.version,
				report_token: reportToken,
			});
		} catch (err) {
			audit.append({ event: "install.enroll.error", installId: record.installId, device, reason: String(err?.message ?? err), ip });
			return json(500, { error: `安装接入失败：${String(err?.message ?? err)}` });
		}
	}
}

/**
 * 安装/运行状态上报。
 * 两种凭据：
 *   - 一次性安装令牌（安装期 stages：downloaded/installed/verified）——verified 后令牌完成；
 *   - 实例上报令牌（`omo kb status --report`，长期、只存哈希、吊销即失效）。
 * 幂等：同一 installId 反复上报只更新最近状态。
 */
async function handleInstallReport(req, ip) {
	let body;
	try {
		body = await req.json();
	} catch {
		return json(400, { error: "请求体必须是 JSON" });
	}
	const stage = typeof body?.stage === "string" ? body.stage : "unknown";
	const ok = body?.ok === true;
	const bearer = bearerToken(req);
	let installId;
	let device;
	let reportAuth = false;
	let tokenToComplete;
	if (typeof bearer === "string" && bearer.startsWith(REPORT_TOKEN_PREFIX)) {
		// 上报令牌**不得**回退为安装令牌：否则吊销后会被「令牌不存在」掩盖成 401，审计也看不出真实原因
		let verdict;
		try {
			verdict = verifyReportToken(instancesFile, bearer);
		} catch (err) {
			return json(500, { error: `实例存储不可读：${String(err?.message ?? err)}` });
		}
		if (!verdict.ok) return json(verdict.reason === "not_found" ? 401 : 403, { error: `上报令牌不可用：${verdict.reason}` });
		reportAuth = true;
		installId = verdict.record.installId;
		device = verdict.record.device;
		if (typeof body?.device === "string" && body.device !== "" && body.device !== device) {
			return json(403, { error: "上报令牌与本设备不匹配" });
		}
	}
	if (!reportAuth && typeof bearer === "string" && bearer !== "") {
		// 安装期路径：沿用一次性安装令牌（不经 installAuth，避免 verified 后无法补报）
		let verdict;
		try {
			verdict = verifyInstallToken(installTokensFile, bearer, typeof body?.device === "string" ? body.device : undefined);
		} catch (err) {
			return json(500, { error: `控制面安装令牌存储不可读：${String(err?.message ?? err)}` });
		}
		if (!verdict.ok) {
			const status = verdict.reason === "expired" ? 410 : verdict.reason === "completed" ? 409 : verdict.reason === "device_mismatch" ? 403 : verdict.reason === "revoked" ? 403 : 401;
			return json(status, { error: `安装令牌不可用：${verdict.reason}` });
		}
		installId = verdict.record.installId;
		device = typeof body?.device === "string" && body.device !== "" ? body.device : verdict.record.device ?? "unknown";
		tokenToComplete = bearer;
	}
	try {
		await upsertInstance(instancesFile, {
			installId,
			device,
			version: body?.version,
			os: body?.os,
			arch: body?.arch,
			status: ok ? (stage === "verified" ? "enrolled" : reportAuth ? "reported" : "installed") : "failed",
			lastSeen: new Date().toISOString(),
			lastSync: body?.lastSync,
			configRevision: body?.configRevision,
			appliedRevision: body?.appliedRevision,
			lastError: ok ? undefined : { stage, reason: body?.reason ?? "unknown" },
		});
		if (!reportAuth && ok && stage === "verified" && tokenToComplete !== undefined) {
			try {
				await completeInstallToken(installTokensFile, tokenToComplete);
			} catch (err) {
				audit.append({ event: "install.report.complete-failed", installId, reason: String(err?.message ?? err), ip });
			}
		}
		audit.append({ event: `install.${ok ? "report" : "failed"}`, installId, device, stage, via: reportAuth ? "report-token" : "install-token", reason: body?.reason, ip });
		return json(200, { ok: true, installId });
	} catch (err) {
		return json(500, { error: `安装上报失败：${String(err?.message ?? err)}` });
	}
}

if (!useTls && args["allow-insecure-http"] !== true) {
	console.error("✗ 拒绝以明文 HTTP 启动（凭据将经网络传输）：请提供 --tls-cert/--tls-key，或显式 --allow-insecure-http（仅限本机/受信内网）");
	process.exit(1);
}
if (!useTls) console.error("⚠ 明文 HTTP 模式（--allow-insecure-http）：凭据将以明文经网络传输，仅限受信链路！");
if (UI_ON && (uiHost !== "127.0.0.1" && uiHost !== "localhost" && uiHost !== "::1")) {
	console.error(`⚠ 管理监听绑定在非回环地址（${uiHost}）：管理 API 仍要求本机 admin token；请确保仅经 yufu/SSH 隧道访问。`);
}
const bindRetryMs = Number.parseInt(process.env.OMO_KB_BIND_RETRY_MS ?? "0", 10) || 0;
async function serveWithRetry(options, label) {
	for (const deadline = Date.now() + bindRetryMs; ; ) {
		try {
			return Bun.serve(options);
		} catch (err) {
			if (Date.now() >= deadline) {
				console.error(`✗ 端口绑定失败 ${label}（${String(err?.message ?? err)}）`);
				process.exit(1);
			}
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}

let server;
let uiServer;
server = await serveWithRetry({
	hostname: host,
	port,
	...(useTls ? { tls: { cert: Bun.file(args["tls-cert"]), key: Bun.file(args["tls-key"]) } } : {}),
	async fetch(req) {
		const u = new URL(req.url);
		const ip = server.requestIP(req)?.address ?? "unknown";
		if (u.pathname === "/healthz") return json(200, { ok: true, repo: args.repo, registryVersion: REGISTRY_VERSION, tls: useTls });
		if (u.pathname === "/enroll" && req.method === "POST") return await handleEnroll(req, ip);
		if (u.pathname === "/kb/webhook" && req.method === "POST") return await handleKbWebhook(req, ip);
		if (u.pathname.startsWith("/install/")) return await handleInstall(req, u, ip);
		return json(404, { error: "not found" });
	},
}, `${host}:${port}`);

if (UI_ON) {
	uiServer = await serveWithRetry({
		hostname: uiHost,
		port: uiPort,
		async fetch(req) {
			const u = new URL(req.url);
			const ip = uiServer.requestIP(req)?.address ?? "unknown";
			if (u.pathname === "/ui") return new Response(null, { status: 301, headers: { Location: "ui/" } });
			if (u.pathname === "/ui/") return uiPageResponse();
			if (!u.pathname.startsWith("/ui/api/")) return json(404, { error: "not found" });
			if (!controlAuthorized(req)) {
				if (throttled(ip)) return json(429, { error: "尝试过于频繁" });
				audit.append({ event: "ui.denied", ts: new Date().toISOString(), ip, via: u.pathname, reason: "missing/invalid control token" });
				return json(401, { error: "需要本机 control-plane admin token（Authorization: Bearer …）" });
			}
			const actor = controlActor(req);
			const parts = u.pathname.split("/").filter((x) => x !== "");
			// /ui/api/...
			if (u.pathname === "/ui/api/state" && req.method === "GET") return handleUiState(actor);
			if (u.pathname === "/ui/api/code" && req.method === "POST") return await handleUiCode(req, ip, actor);
			if (u.pathname === "/ui/api/config" && req.method === "GET") return handleUiConfigGet(actor);
			if (u.pathname === "/ui/api/config" && req.method === "POST") return await handleUiConfigPost(req, ip, actor);
			if (u.pathname === "/ui/api/install-tokens" && req.method === "GET") return json(200, { ok: true, tokens: listInstallTokens(installTokensFile) });
			if (u.pathname === "/ui/api/install-tokens" && req.method === "POST") return await handleUiInstallTokenPost(req, ip, actor);
			if (parts.length === 5 && parts[2] === "install-tokens" && parts[4] === "revoke" && req.method === "POST") {
				try {
					const record = await revokeInstallToken(installTokensFile, decodeURIComponent(parts[3]));
					audit.append({ event: "ui.install-token.revoked", installId: record.installId, actor, ip });
					return json(200, { ok: true, installId: record.installId });
				} catch (err) {
					return json(404, { error: String(err?.message ?? err) });
				}
			}
			if (u.pathname === "/ui/api/installers" && req.method === "GET") return handleUiInstallers(req, u, ip, actor);
			if (u.pathname === "/ui/api/installers" && req.method === "POST") return await handleUiInstallerPost(req, ip, actor);
			if (parts.length === 5 && parts[2] === "installers" && parts[4] === "artifacts" && req.method === "POST") {
				return await handleUiArtifactUpload(req, u, decodeURIComponent(parts[3]), ip, actor);
			}
			if (u.pathname === "/ui/api/instances" && req.method === "GET") return handleUiInstances(req, u, ip, actor);
			if (parts.length === 5 && parts[2] === "instances" && ["rotate", "revoke"].includes(parts[4]) && req.method === "POST") {
				return await handleUiInstanceAction(req, u, decodeURIComponent(parts[3]), parts[4], ip, actor);
			}
			if (u.pathname === "/ui/api/gate" && req.method === "GET") {
				const webhookUrl = `${installBaseUrl}/kb/webhook`;
				let observed;
				let observedError;
				try {
					observed = await getGateState(api, args.repo, MAIN_BRANCH, webhookUrl);
				} catch (err) {
					observedError = String(err?.message ?? err);
				}
				return json(200, {
					ok: true,
					gate: { mode: LINT_MODE, mainBranch: MAIN_BRANCH, webhookConfigured: WEBHOOK_SECRET !== undefined, webhookSecret: webhookSecretView(), webhookUrl },
					...(observed === undefined ? { observedError } : { observed }),
					events: auditTail(50).filter((e) => String(e.event ?? "").startsWith("lint.")),
				});
			}
			if (u.pathname === "/ui/api/gate/apply" && req.method === "POST") {
				if (WEBHOOK_SECRET === undefined) return json(400, { error: "未配置 webhook secret；先设置 OMO_KB_WEBHOOK_SECRET" });
				const webhookUrl = `${installBaseUrl}/kb/webhook`;
				try {
					const branch = await ensureBranchProtection(api, args.repo, MAIN_BRANCH, ["kb-lint"]);
					const hook = await ensureWebhook(api, args.repo, webhookUrl, WEBHOOK_SECRET);
					audit.append({ event: "ui.gate.apply", actor, ip, branch, hook, webhookUrl });
					return json(200, { ok: true, branchProtection: branch, webhook: hook, webhookUrl });
				} catch (err) {
					audit.append({ event: "ui.gate.apply.failed", actor, ip, reason: String(err?.message ?? err) });
					return json(502, { error: `Gitea 门禁配置失败：${String(err?.message ?? err)}` });
				}
			}
			if (u.pathname === "/ui/api/secret/rotate" && req.method === "POST") {
				return await handleUiGateRotateSecret(req, ip, actor);
			}
			if (u.pathname === "/ui/api/secret/close" && req.method === "POST") {
				return await handleUiSecretClose(req, ip, actor);
			}
			if (u.pathname === "/ui/api/audit" && req.method === "GET") {
				const limit = Math.max(1, Math.min(200, Number.parseInt(u.searchParams.get("limit") ?? "50", 10) || 50));
				const filters = {
					event: u.searchParams.get("event") ?? undefined,
					actor: u.searchParams.get("actor") ?? undefined,
					installId: u.searchParams.get("installId") ?? undefined,
					q: u.searchParams.get("q") ?? undefined,
				};
				return json(200, { ok: true, audit: auditTail(limit, filters), filters });
			}
			return json(404, { error: "not found" });
		},
	}, `${uiHost}:${uiPort}`);
}

if (typeof args["pid-file"] === "string" && args["pid-file"] !== "") {
	try {
		fs.mkdirSync(path.dirname(args["pid-file"]), { recursive: true });
		fs.writeFileSync(args["pid-file"], `${process.pid}\n`);
	} catch { /* pid 文件写不进不阻断服务 */ }
}

// 打印监听端口（测试与运维都靠这一行判定就绪；日志一律不含秘密）
console.log(`LISTEN ${useTls ? "https" : "http"}://${host}:${server.port} repo=${args.repo} registry=${registryFile} audit=${auditFile} controlPlane=${controlPlaneRoot} codeTtlMin=${codeTtlMin} ui=${UI_ON ? `on(${uiHost}:${uiPort})` : "off"} auth=${UI_ON ? "control-token" : "n/a"} lint=${LINT_MODE}${WEBHOOK_SECRET === undefined ? "(未配密钥)" : ""} config=${configPath ?? "-"}`);
if (UI_ON) console.log(`ADMIN_TOKEN_FILE ${adminTokenFile}`);
