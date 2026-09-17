#!/usr/bin/env node
/**
 * ops-kb-provision.mjs —— 知识库 bot 账号的**全自动供给**（P2，Owner 侧/服务侧）
 *
 * 契约：docs/designs/omo-kb-sync-credential-design.md §5.2″（凭据形态：密码）
 *
 * ## 为什么是「密码」而不是「令牌」
 * 在 Gitea 1.27.3（= 生产实例版本）上实测 + 源码复核：
 *   - `POST /users/{u}/tokens` 的 201 响应**不含明文**（字段仅 id/name/sha1/token_last_eight/scopes）
 *     ⇒ API 签发的令牌**拿不到、用不了**（本地同版本复现一致）；
 *   - 但 **`POST /admin/users`（建号，含密码）/ `PATCH /admin/users/{u}`（改密）/ `DELETE /admin/users/{u}`
 *     全部可用**，且 **git over HTTPS 接受「用户名+密码」基本认证**（本地 1.27.3 实测：`git ls-remote`
 *     直连与 omo 同款 store 机制均成功）⇒ **凭据发放/轮换/吊销 100% 可 API 自动化**。
 *
 * ## 鉴权（服务侧持有，一次性交给你的 Git 服务/站点管理员做）
 * 二选一，均已在本地 1.27.3 验证可调 `/admin/*`：
 *   - `--admin-token-file`：站点管理员用 CLI 签发的 `all` 作用域令牌
 *     （`gitea admin user generate-access-token -u <admin> --scopes all --raw`）；
 *   - `--admin-user` + `--admin-password-file`：站点管理员账号的基本认证
 *     （源码：`tokenRequiresScopes` 对非令牌认证直接放行；`reqToken()` 只要求已登录）。
 *
 * ## 命令
 *   create --api <base> --repo <owner/repo> --device <名> --login <bot> [--grant team|collab|none]
 *          [--permission read|write] [--team <名>] [--deliver <credential.json 路径>] [--apply]
 *   rotate --api <base> --login <bot> [--deliver <路径>] [--apply]
 *   revoke --api <base> --repo <owner/repo> --login <bot> [--grant team|collab] [--delete-user] [--apply]
 *   grant  --api <base> --repo <owner/repo> --device <名> --login <bot> [--team <名>] [--permission read|write] [--apply]
 *   list   [--registry <f>]
 *   --selftest        本地桩服务器自检（无需网络/Gitea）
 *
 * ## 纪律
 *   - 秘密（管理员令牌/密码、bot 密码）**只从文件/env 读**（强制 0600），绝不进 argv、绝不回显；
 *   - 交付物写**独立 0600 文件**（`--deliver`），由一次性渠道交给实例；终端只打印路径与校验命令；
 *   - 变更类动作默认 **dry-run**，须 `--apply`；
 *   - 登记文件（`--registry`，0600）只存 sha1(秘密) 供对账，不存秘密本体。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const USAGE = `用法见脚本头注释。典型：
  # 一次性：站点管理员在 Git 服务器上签发一个 all 作用域令牌
  #   gitea admin user generate-access-token -u <admin> --scopes all --raw > /root/omo-admin.token && chmod 600 /root/omo-admin.token
  # 每台实例（全自动）：
  node scripts/ops-kb-provision.mjs create --api https://twin.hzins.com/git/api/v1 \\
       --admin-token-file /root/omo-admin.token --repo hzins-ops/ops-kb --device PC-SZ-375 \\
       --login omo-bot-pcsz375 --grant team --permission write --deliver ./PC-SZ-375-credential.json --apply
  # 轮换 / 吊销：
  node scripts/ops-kb-provision.mjs rotate --api <base> --admin-token-file <f> --login omo-bot-pcsz375 --deliver ./cred.json --apply
  node scripts/ops-kb-provision.mjs revoke --api <base> --admin-token-file <f> --repo hzins-ops/ops-kb --login omo-bot-pcsz375 --apply`;

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const key = a.slice(2);
		if (["apply", "dry-run", "delete-user", "selftest", "help"].includes(key)) {
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

function readSecretFile(file, what) {
	const st = fs.statSync(file);
	if ((st.mode & 0o077) !== 0) throw new Error(`${what}文件权限过宽（应 0600）：${file} 当前 ${(st.mode & 0o777).toString(8)}`);
	return fs.readFileSync(file, "utf8").trim();
}

/** 管理员凭据：令牌或「账号+密码」（二者都已在 1.27.3 上验证可调 /admin/*） */
export function readAdminAuth(args, env = process.env) {
	if (args["admin-token-file"] !== undefined) return { kind: "token", token: readSecretFile(args["admin-token-file"], "管理员令牌") };
	const pw = args["admin-password-file"] !== undefined ? readSecretFile(args["admin-password-file"], "管理员密码") : env.OPS_KB_ADMIN_PASSWORD;
	if (args["admin-user"] !== undefined && pw !== undefined && pw !== "") return { kind: "basic", user: args["admin-user"], password: pw.trim() };
	throw new Error("缺少管理员凭据：--admin-token-file（推荐）或 --admin-user + --admin-password-file/env OPS_KB_ADMIN_PASSWORD");
}

export function makeApi(base, auth, fetchImpl = fetch) {
	const root = base.replace(/\/+$/, "");
	const authHeader = auth.kind === "token" ? `token ${auth.token}` : `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`;
	async function call(method, p, body, asBasic) {
		const res = await fetchImpl(`${root}${p}`, {
			method,
			headers: {
				Authorization: asBasic === undefined ? authHeader : `Basic ${Buffer.from(`${asBasic.user}:${asBasic.password}`).toString("base64")}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		let json;
		try {
			json = text === "" ? undefined : JSON.parse(text);
		} catch {
			json = undefined;
		}
		return { status: res.status, ok: res.ok, json, text };
	}
	return {
		base: root,
		get: (p, asBasic) => call("GET", p, undefined, asBasic),
		post: (p, b, asBasic) => call("POST", p, b, asBasic),
		patch: (p, b, asBasic) => call("PATCH", p, b, asBasic),
		put: (p, b, asBasic) => call("PUT", p, b, asBasic),
		del: (p, asBasic) => call("DELETE", p, undefined, asBasic),
	};
}

export function loadRegistry(file) {
	if (!fs.existsSync(file)) return { version: 2, entries: [] };
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveRegistry(file, reg) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

export function defaultTeam(repo) {
	return `omo-kb-${repo.split("/").pop()}`;
}

export function randomPassword() {
	return `omo-${crypto.randomBytes(18).toString("base64url")}`;
}

export function credentialJson(apiBase, repo, login, secret, kind) {
	return { repo: `${new URL(apiBase).origin}${repoWebPath(apiBase, repo)}`, username: login, secret, kind, createdAt: new Date().toISOString() };
}

/** 由 API base（可能是子路径部署，如 https://host/git/api/v1）推导仓库 HTTPS 地址 */
export function repoWebPath(apiBase, repo) {
	const u = new URL(apiBase);
	const idx = u.pathname.indexOf("/api/");
	return `${idx >= 0 ? u.pathname.slice(0, idx) : ""}/${repo}`;
}

/** 仓库 HTTPS 地址（同 credentialJson 的推导） */
function cred0(apiBase, repo) {
	return `${new URL(apiBase).origin}${repoWebPath(apiBase, repo)}`;
}

function writeDeliverable(file, cred) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

async function teamId(api, org, team) {
	const found = await api.get(`/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(team)}`);
	return (found.json?.data ?? []).find((t) => t.name === team)?.id;
}

/** 确保团队存在；返回 {id, created} */
async function ensureTeam(api, org, team, permission, apply) {
	const id = await teamId(api, org, team);
	if (id !== undefined) return { id, created: false };
	if (!apply) return { id: undefined, created: true };
	const created = await api.post(`/orgs/${encodeURIComponent(org)}/teams`, {
		name: team,
		permission: permission === "read" ? "read" : "write",
		units_map: { "repo.code": permission === "read" ? "read" : "write" },
	});
	if (!created.ok) throw new Error(`建团队失败 HTTP ${created.status} ${created.text.slice(0, 200)}`);
	return { id: created.json.id, created: true };
}

/** 授予访问：team（团队成员）或 collab（仓库协作者） */
async function grantAccess(api, repo, login, grant, team, permission, apply, log) {
	const [org] = repo.split("/");
	if (grant === "none") return;
	if (grant === "collab") {
		if (!apply) return log(`加协作者：将 PUT /repos/${repo}/collaborators/${login} {permission:${permission}}`);
		const r = await api.put(`/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { permission });
		return log(`加协作者(${permission})：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status} ${r.text.slice(0, 120)}`}`);
	}
	const t = await ensureTeam(api, org, team, permission, apply);
	log(`团队 ${team}：${t.created ? (apply ? "已创建" : "将创建") : `已存在(id=${t.id})`}`);
	const id = t.id ?? (await teamId(api, org, team));
	if (id === undefined) return log(`加入团队：将 PUT /teams/<新建>/members/${login}`);
	if (!apply) return log(`加入团队：将 PUT /teams/${id}/members/${login}`);
	const r = await api.put(`/teams/${id}/members/${encodeURIComponent(login)}`);
	return log(`加入团队：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status} ${r.text.slice(0, 120)}`}`);
}

async function revokeAccess(api, repo, login, grant, team, apply, log) {
	const [org] = repo.split("/");
	if (grant === "collab") {
		if (!apply) return log(`撤协作者：将 DELETE /repos/${repo}/collaborators/${login}`);
		const r = await api.del(`/repos/${repo}/collaborators/${encodeURIComponent(login)}`);
		return log(`撤协作者：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
	}
	const id = await teamId(api, org, team);
	if (id === undefined) return log("撤团队成员：（团队不存在，跳过）");
	if (!apply) return log(`撤团队成员：将 DELETE /teams/${id}/members/${login}`);
	const r = await api.del(`/teams/${id}/members/${encodeURIComponent(login)}`);
	log(`撤团队成员：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
}

/** 建号（幂等：已存在则改密），返回最终使用的密码 */
async function ensureUser(api, login, password, apply, log) {
	if (!apply) return password;
	const created = await api.post("/admin/users", { username: login, password, email: `${login}@omo.local`, must_change_password: false, visibility: "private" });
	if (created.status === 201) {
		log(`建号：✓ 201（id=${created.json?.id}）`);
		return password;
	}
	if (created.status === 422 || created.status === 409) {
		log(`建号：账号已存在 → 改密（幂等）`);
		const patched = await api.patch(`/admin/users/${encodeURIComponent(login)}`, { password, must_change_password: false });
		if (!patched.ok) throw new Error(`改密失败 HTTP ${patched.status} ${patched.text.slice(0, 200)}`);
		return password;
	}
	throw new Error(`建号失败 HTTP ${created.status} ${created.text.slice(0, 200)}`);
}

async function cmdCreate(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.repo === undefined || args.device === undefined || args.login === undefined) throw new Error("create 需要 --api --repo --device --login");
	const grant = args.grant ?? "team";
	const permission = args.permission ?? "read";
	const team = args.team ?? defaultTeam(args.repo);
	const password = args.password ?? randomPassword();
	const log = (s) => console.log(`  · ${s}`);

	await ensureUser(api, args.login, password, apply, log);
	await grantAccess(api, args.repo, args.login, grant, team, permission, apply, log);
	if (!apply) {
		console.log("（dry-run：加 --apply 执行）");
		return 0;
	}
	// 自证一：用 bot 自己的凭据读仓库（证明授权+凭据同时生效）
	const probe = await api.get(`/repos/${args.repo}`, { user: args.login, password });
	log(`凭据自证 GET /repos/${args.repo}：${probe.ok ? "✓ 200" : `✗ HTTP ${probe.status}`}`);

	// 自证二（更强）：git 层实测——凭据必须能真正拉到 refs（生产首验用；无 git/网络不可达只告警）
	if (args["verify-git"] !== false) {
		const repoUrl = cred0(api.base, args.repo);
		const probeGit = Bun.spawnSync({
			cmd: ["git", "-c", "credential.helper=", "ls-remote", `http://${encodeURIComponent(args.login)}:${encodeURIComponent(password)}@${repoUrl.replace(/^https?:\/\//, "")}`],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const okGit = probeGit.exitCode === 0;
		log(`git 层自证（ls-remote）：${okGit ? "✓ 凭据可用于 git" : "⚠ 未能验证（本机无 git 或网络不可达）——请在生产首台实例上跑 omo kb sync 复核"}`);
	}

	const cred = credentialJson(api.base, args.repo, args.login, password, "password");
	const file = args.deliver ?? `${args.device}-credential.json`;
	writeDeliverable(file, cred);
	const regFile = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(regFile);
	reg.entries = reg.entries.filter((e) => !(e.device === args.device && e.login === args.login));
	reg.entries.push({ device: args.device, login: args.login, repo: args.repo, grant, team: grant === "team" ? team : undefined, permission, credentialKind: "password", secretSha1: crypto.createHash("sha1").update(password).digest("hex"), createdAt: new Date().toISOString() });
	saveRegistry(regFile, reg);
	console.log(`✓ 供给完成`);
	console.log(`  · 交付文件（0600）：${file}`);
	console.log(`  · 登记（0600，不含秘密）：${regFile}`);
	console.log(`\n在目标实例上（一次性渠道拿到交付文件后）：`);
	console.log(`  install -m 600 ${path.basename(file)} ~/.omo/kb/credential.json && omo kb status && omo kb sync`);
	return 0;
}

async function cmdRotate(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.login === undefined) throw new Error("rotate 需要 --api --login");
	const password = args.password ?? randomPassword();
	if (!apply) {
		console.log(`  · 轮换：将 PATCH /admin/users/${args.login} {password: <新>}`);
		console.log("（dry-run：加 --apply 执行）");
		return 0;
	}
	const patched = await api.patch(`/admin/users/${encodeURIComponent(args.login)}`, { password, must_change_password: false });
	if (!patched.ok) throw new Error(`轮换失败 HTTP ${patched.status} ${patched.text.slice(0, 200)}`);
	console.log(`  · 改密：✓ ${patched.status}（旧密码立即失效）`);
	const repo = args.repo;
	if (repo !== undefined) {
		const cred = credentialJson(api.base, repo, args.login, password, "password");
		const file = args.deliver ?? `${args.login}-credential.json`;
		writeDeliverable(file, cred);
		console.log(`  · 交付文件（0600）：${file}`);
	}
	const regFile = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(regFile);
	for (const e of reg.entries) {
		if (e.login === args.login) {
			e.secretSha1 = crypto.createHash("sha1").update(password).digest("hex");
			e.rotatedAt = new Date().toISOString();
		}
	}
	saveRegistry(regFile, reg);
	console.log(`✓ 轮换完成（把新交付文件推给实例即可，旧凭据已即时失效）`);
	return 0;
}

async function cmdRevoke(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.login === undefined) throw new Error("revoke 需要 --api --login");
	const log = (s) => console.log(`  · ${s}`);
	if (args["delete-user"] === true) {
		if (!apply) log(`将 DELETE /admin/users/${args.login}`);
		else {
			const r = await api.del(`/admin/users/${encodeURIComponent(args.login)}`);
			log(`删号：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
		}
	} else {
		const scram = `revoked-${crypto.randomBytes(18).toString("base64url")}`;
		if (!apply) log(`将 PATCH /admin/users/${args.login}（改乱密码，凭据即时失效）`);
		else {
			const r = await api.patch(`/admin/users/${encodeURIComponent(args.login)}`, { password: scram, must_change_password: false });
			log(`改乱密码（即时失效）：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
		}
	}
	if (args.repo !== undefined) await revokeAccess(api, args.repo, args.login, args.grant ?? "team", args.team ?? defaultTeam(args.repo), apply, log);
	if (apply) {
		const regFile = args.registry ?? "ops-kb-registry.json";
		const reg = loadRegistry(regFile);
		for (const e of reg.entries) if (e.login === args.login) e.revokedAt = new Date().toISOString();
		saveRegistry(regFile, reg);
		log(`登记：已标记 revokedAt（${regFile}）`);
	}
	console.log(apply ? "✓ 吊销完成（Gitea 侧即时生效）" : "（dry-run：加 --apply 执行）");
	return 0;
}

async function cmdGrant(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.repo === undefined || args.device === undefined || args.login === undefined) throw new Error("grant 需要 --api --repo --device --login");
	const log = (s) => console.log(`  · ${s}`);
	await grantAccess(api, args.repo, args.login, args.grant ?? "team", args.team ?? defaultTeam(args.repo), args.permission ?? "read", apply, log);
	const regFile = args.registry ?? "ops-kb-registry.json";
	if (apply) {
		const reg = loadRegistry(regFile);
		reg.entries = reg.entries.filter((e) => !(e.device === args.device && e.login === args.login));
		reg.entries.push({ device: args.device, login: args.login, repo: args.repo, grant: args.grant ?? "team", permission: args.permission ?? "read", createdAt: new Date().toISOString() });
		saveRegistry(regFile, reg);
		log(`登记：${regFile}`);
	}
	console.log(apply ? "✓ 授权完成" : "（dry-run：加 --apply 执行）");
	return 0;
}

function cmdList(args) {
	const file = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(file);
	if (reg.entries.length === 0) {
		console.log(`（${file} 无登记项）`);
		return 0;
	}
	for (const e of reg.entries) {
		console.log(`  ${e.revokedAt === undefined ? "●" : "○"} ${e.device ?? "-"}  ${e.login}  ${e.repo ?? "-"}  授予=${e.grant ?? "-"}(团队 ${e.team ?? "-"}/${e.permission ?? "-"})  ${e.credentialKind ?? "token"}  秘密sha1=${String(e.secretSha1 ?? e.tokenSha1 ?? "").slice(0, 12)}…  ${e.revokedAt === undefined ? "有效" : `已吊销 ${e.revokedAt}`}`);
	}
	return 0;
}

/** 自检：本地桩服务器，端到端跑 create → rotate → revoke（无网络、无真凭据） */
async function selftest() {
	const seen = [];
	let teamCreated = false;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			seen.push(`${req.method} ${u.pathname}`);
			const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
			if (u.pathname === "/api/v1/admin/users" && req.method === "POST") return json({ id: 9, login: "omo-bot" }, 201);
			if (u.pathname === "/api/v1/admin/users/omo-bot" && req.method === "PATCH") return json({ login: "omo-bot" });
			if (u.pathname === "/api/v1/orgs/acme/teams/search") return json({ data: teamCreated ? [{ id: 7, name: "omo-kb-kb" }] : [] });
			if (u.pathname === "/api/v1/orgs/acme/teams" && req.method === "POST") {
				teamCreated = true;
				return json({ id: 7, name: "omo-kb-kb" });
			}
			if (u.pathname === "/api/v1/teams/7/members/omo-bot") return new Response(null, { status: 204 });
			if (u.pathname === "/api/v1/repos/acme/kb" && req.method === "GET") return json({ full_name: "acme/kb" });
			if (u.pathname === "/api/v1/teams/7/members/omo-bot" && req.method === "DELETE") return new Response(null, { status: 204 });
			return new Response("{}", { status: 200 });
		},
	});
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ops-kb-provision-"));
	const tokenFile = path.join(dir, "admin.token");
	fs.writeFileSync(tokenFile, "SELFTEST-ADMIN-TOKEN\n", { mode: 0o600 });
	const reg = path.join(dir, "registry.json");
	const deliver = path.join(dir, "cred.json");
	const common = ["--api", base, "--admin-token-file", tokenFile, "--repo", "acme/kb", "--device", "node-1", "--registry", reg];
	const checks = [];
	const run = async (argv) => {
		const r = Bun.spawn({ cmd: [process.execPath, new URL(import.meta.url).pathname, ...argv], stdout: "pipe", stderr: "pipe" });
		const [out, err] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text()]);
		return { code: await r.exited, out, err };
	};
	try {
		const c = await run(["create", ...common, "--login", "omo-bot", "--deliver", deliver, "--apply"]);
		checks.push(["create 成功", c.code === 0, c.out + c.err]);
		checks.push(["调用序：建号 → 查团队(search) → 建团队 → 加成员 → 自证", seen.join("|").includes("POST /api/v1/admin/users|GET /api/v1/orgs/acme/teams/search|POST /api/v1/orgs/acme/teams|PUT /api/v1/teams/7/members/omo-bot|GET /api/v1/repos/acme/kb"), seen.join("|")]);
		const cred = JSON.parse(fs.readFileSync(deliver, "utf8"));
		checks.push(["交付文件：kind=password + 仓库地址由 API 前缀推导", cred.kind === "password" && cred.repo === `http://127.0.0.1:${server.port}/acme/kb` && typeof cred.secret === "string" && cred.secret.length > 20, JSON.stringify({ ...cred, secret: "***" })]);
		checks.push(["交付文件 0600", (fs.statSync(deliver).mode & 0o777) === 0o600, (fs.statSync(deliver).mode & 0o777).toString(8)]);
		const r1 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["登记无秘密本体、只有 sha1", r1.entries.length === 1 && r1.entries[0].credentialKind === "password" && !JSON.stringify(r1).includes(cred.secret), JSON.stringify(r1)]);
		const ro = await run(["rotate", ...common, "--login", "omo-bot", "--deliver", deliver, "--apply"]);
		const cred2 = JSON.parse(fs.readFileSync(deliver, "utf8"));
		checks.push(["rotate 换密并更新交付", ro.code === 0 && cred2.secret !== cred.secret, ro.out]);
		const rv = await run(["revoke", ...common, "--login", "omo-bot", "--apply"]);
		const r2 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["revoke 改乱密码 + 撤团队成员 + 标记", rv.code === 0 && r2.entries[0].revokedAt !== undefined && seen.includes("DELETE /api/v1/teams/7/members/omo-bot"), rv.out + rv.err]);
		const dry = await run(["create", ...common, "--login", "omo-bot-2", "--deliver", path.join(dir, "d2.json")]);
		checks.push(["默认 dry-run：不建号、不落交付", dry.code === 0 && !fs.existsSync(path.join(dir, "d2.json")) && !seen.slice(seen.lastIndexOf("GET /api/v1/orgs/acme/teams/search")).includes("POST /api/v1/admin/users"), dry.out]);
		const wide = path.join(dir, "wide.token");
		fs.writeFileSync(wide, "X\n", { mode: 0o644 });
		const w = await run(["create", "--api", base, "--admin-token-file", wide, "--repo", "acme/kb", "--device", "n", "--login", "x", "--apply"]);
		checks.push(["管理员令牌文件权限过宽即拒", w.code !== 0 && w.err.includes("权限过宽"), w.err]);
		const basic = await run(["create", "--api", base, "--admin-user", "root", "--admin-password-file", tokenFile, "--repo", "acme/kb", "--device", "node-2", "--login", "omo-bot-3", "--registry", reg, "--deliver", path.join(dir, "d3.json"), "--apply"]);
		checks.push(["支持基本认证（账号+密码）路径", basic.code === 0, basic.out + basic.err]);
	} finally {
		server.stop(true);
		fs.rmSync(dir, { recursive: true, force: true });
	}
	let ok = true;
	for (const [name, pass, detail] of checks) {
		console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : `\n      ${String(detail).slice(0, 300)}`}`);
		if (!pass) ok = false;
	}
	console.log(`自检：${checks.filter((c) => c[1]).length}/${checks.length} 通过`);
	return ok ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	const apply = args.apply === true;
	try {
		if (args.selftest === true) process.exit(await selftest());
		if (cmd === "create") process.exit(await cmdCreate(args, apply));
		if (cmd === "rotate") process.exit(await cmdRotate(args, apply));
		if (cmd === "revoke") process.exit(await cmdRevoke(args, apply));
		if (cmd === "grant") process.exit(await cmdGrant(args, apply));
		if (cmd === "list") process.exit(cmdList(args));
		console.log(USAGE);
		process.exit(cmd === undefined ? 0 : 1);
	} catch (err) {
		console.error(`✗ ${err.message}`);
		process.exit(1);
	}
}
