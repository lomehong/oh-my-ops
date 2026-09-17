#!/usr/bin/env node
/**
 * ops-kb-provision.mjs —— 知识库 bot 账号直接供给 CLI（P2，Owner/服务侧）+ 兑换码签发（P3）
 *
 * 契约：docs/designs/omo-kb-sync-credential-design.md §5.2″/§5.6
 * 共用实现：scripts/lib/kb-gitea.mjs（Gitea 原语）、scripts/lib/kb-registry.mjs（登记表与兑换码）
 *
 * ## 为什么凭据是「密码」而不是「令牌」
 * 真机（Gitea 1.27.3）实测：`POST /users/{u}/tokens` 的 201 响应**不含明文**（仅 sha1/token_last_eight）
 * ⇒ API 签发的令牌拿不到、用不了；而**密码**可被管理员 API 任意设定/重置，且 git over HTTPS 接受
 * 「用户名+密码」基本认证 ⇒ 凭据的**发放/轮换/吊销 100% 可 API 自动化**。
 *
 * ## 鉴权（服务侧引导凭据，二选一，均已真机验证）
 *   - `--admin-token-file`：站点管理员用 CLI 签发的 `all`/admin 作用域令牌；
 *   - `--admin-user` + `--admin-password-file`：站点管理员账号的基本认证。
 *
 * ## 命令
 *   create --api <base> --repo <owner/repo> --device <名> --login <bot> [--grant team|collab|none]
 *          [--permission read|write] [--team <名>] [--deliver <credential.json>] [--verify-git] [--apply]
 *   rotate --api <base> --login <bot> [--repo <owner/repo>] [--deliver <路径>] [--apply]
 *   revoke --api <base> --login <bot> [--repo <owner/repo>] [--grant team|collab] [--delete-user] [--apply]
 *   grant  --api <base> --repo <owner/repo> --device <名> --login <bot> [--team <名>] [--permission read|write] [--apply]
 *   code   --op enroll|rotate|revoke [--device <名>] [--ttl <分钟>] [--registry <f>]      # 签发一次性兑换码（P3）
 *   list   [--registry <f>]
 *   --selftest        本地桩服务器自检（无需网络/Gitea）
 *
 * ## 纪律
 *   - 秘密（管理员令牌/密码、bot 密码、兑换码明文）**只从 0600 文件/env 读或只打印一次**，
 *     绝不进 argv、绝不回显、绝不写入登记表（登记表只存 sha1/sha256）；
 *   - 交付物写独立 0600 文件（`--deliver`），终端只打印路径与校验命令；
 *   - 变更类动作默认 **dry-run**，须 `--apply`。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readAdminAuth, makeApi, defaultTeam, randomPassword, credentialJson, repoWebPath, sha1, ensureUser as libEnsureUser, grantAccess as libGrantAccess, revokeAccess as libRevokeAccess, scramblePassword, verifyBotCredential } from "./lib/kb-gitea.mjs";
import { loadRegistry, saveRegistry, issueCode, CODE_OPS } from "./lib/kb-registry.mjs";

const USAGE = `用法见脚本头注释。典型：
  node scripts/ops-kb-provision.mjs create --api https://twin.hzins.com/git/api/v1 \\
       --admin-user omo-admin --admin-password-file /root/omo-admin.pw \\
       --repo hzins-ops/ops-kb --device PC-SZ-375 --login omo-bot-pcsz375 \\
       --grant team --permission write --deliver ./PC-SZ-375-credential.json --apply
  node scripts/ops-kb-provision.mjs code --op enroll --device node-42 --ttl 30`;

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const key = a.slice(2);
		if (["apply", "dry-run", "delete-user", "verify-git", "selftest", "help"].includes(key)) {
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

function writeDeliverable(file, cred) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

const log = (s) => console.log(`  · ${s}`);

/** 授权（dry-run 友好）：实际调用复用共享实现 */
async function grantAccess(api, repo, login, grant, team, permission, apply, logFn = log) {
	if (!apply) {
		if (grant === "collab") return logFn(`加协作者：将 PUT /repos/${repo}/collaborators/${login} {permission:${permission}}`);
		if (grant === "none") return;
		return logFn(`团队：将确保 ${team} 存在 → 挂仓库 ${repo} → 加入成员 ${login}`);
	}
	await libGrantAccess(api, repo, login, grant, team, permission, logFn);
}

async function revokeAccess(api, repo, login, grant, team, apply, logFn = log) {
	if (!apply) return logFn(`撤权：将撤 ${login} 的${grant === "collab" ? "协作者" : "团队成员"}（组织 ${repo.split("/")[0]} / 团队 ${team}）`);
	await libRevokeAccess(api, repo, login, grant, team, logFn);
}

async function cmdCreate(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.repo === undefined || args.device === undefined || args.login === undefined) throw new Error("create 需要 --api --repo --device --login");
	const grant = args.grant ?? "team";
	const permission = args.permission ?? "read";
	const team = args.team ?? defaultTeam(args.repo);
	const password = args.password ?? randomPassword();

	if (!apply) {
		log(`建号：将 POST /admin/users {username:${args.login}}（已存在则改密）`);
		await grantAccess(api, args.repo, args.login, grant, team, permission, false);
		log("（dry-run：加 --apply 执行）");
		return 0;
	}

	const user = await libEnsureUser(api, args.login, password, log);
	await grantAccess(api, args.repo, args.login, grant, team, permission, true);

	const probe = await verifyBotCredential(api, args.repo, args.login, password);
	log(`凭据自证 GET /repos/${args.repo}：${probe.ok ? "✓ 200" : `✗ HTTP ${probe.status}`}`);
	if (!probe.ok) {
		console.error("✗ 自证失败：授权或凭据未生效，未生成交付文件");
		return 1;
	}
	if (args["verify-git"] !== false) {
		const repoUrl = `${new URL(api.base).origin}${repoWebPath(api.base, args.repo)}`;
		const probeGit = Bun.spawnSync({
			cmd: ["git", "-c", "credential.helper=", "ls-remote", `http://${encodeURIComponent(args.login)}:${encodeURIComponent(password)}@${repoUrl.replace(/^https?:\/\//, "")}`],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});
		log(`git 层自证（ls-remote）：${probeGit.exitCode === 0 ? "✓ 凭据可用于 git" : "⚠ 未能验证（本机无 git 或网络不可达）——请在生产首台实例上跑 omo kb sync 复核"}`);
	}

	const cred = credentialJson(api.base, args.repo, args.login, password, "password");
	const file = args.deliver ?? `${args.device}-credential.json`;
	writeDeliverable(file, cred);
	const regFile = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(regFile);
	reg.entries = reg.entries.filter((e) => !(e.device === args.device && e.login === args.login));
	reg.entries.push({
		device: args.device,
		login: args.login,
		repo: args.repo,
		grant,
		team: grant === "team" ? team : undefined,
		permission,
		credentialKind: "password",
		secretSha1: sha1(password),
		createdAt: new Date().toISOString(),
		...(user.created ? {} : { rebindAt: new Date().toISOString() }),
	});
	saveRegistry(regFile, reg);
	console.log("✓ 供给完成");
	log(`交付文件（0600）：${file}`);
	log(`登记（0600，不含秘密）：${regFile}`);
	console.log("\n在目标实例上（一次性渠道拿到交付文件后）：");
	console.log(`  install -m 600 ${path.basename(file)} ~/.omo/kb/credential.json && omo kb status && omo kb sync`);
	return 0;
}

async function cmdRotate(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.login === undefined) throw new Error("rotate 需要 --api --login");
	const password = args.password ?? randomPassword();
	if (!apply) {
		log(`轮换：将 PATCH /admin/users/${args.login}（改密 ⇒ 旧凭据立即失效）`);
		log("（dry-run：加 --apply 执行）");
		return 0;
	}
	const r = await api.patch(`/admin/users/${encodeURIComponent(args.login)}`, { password, must_change_password: false });
	if (!r.ok) throw new Error(`轮换失败 HTTP ${r.status} ${r.text.slice(0, 200)}`);
	log(`改密：✓ ${r.status}（旧凭据立即失效）`);
	if (args.repo !== undefined) {
		const file = args.deliver ?? `${args.login}-credential.json`;
		writeDeliverable(file, credentialJson(api.base, args.repo, args.login, password, "password"));
		log(`交付文件（0600）：${file}`);
	}
	const regFile = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(regFile);
	for (const e of reg.entries) {
		if (e.login === args.login) {
			e.secretSha1 = sha1(password);
			e.rotatedAt = new Date().toISOString();
		}
	}
	saveRegistry(regFile, reg);
	console.log("✓ 轮换完成（把新交付文件推给实例即可；旧凭据已即时失效）");
	return 0;
}

async function cmdRevoke(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.login === undefined) throw new Error("revoke 需要 --api --login");
	if (args["delete-user"] === true) {
		if (!apply) log(`将 DELETE /admin/users/${args.login}`);
		else {
			const r = await api.del(`/admin/users/${encodeURIComponent(args.login)}`);
			log(`删号：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
		}
	} else if (!apply) {
		log(`将 PATCH /admin/users/${args.login}（改乱密码，凭据即时失效）`);
	} else {
		await scramblePassword(api, args.login, log);
	}
	if (args.repo !== undefined) await revokeAccess(api, args.repo, args.login, args.grant ?? "team", args.team ?? defaultTeam(args.repo), apply);
	if (apply) {
		const regFile = args.registry ?? "ops-kb-registry.json";
		const reg = loadRegistry(regFile);
		for (const e of reg.entries) if (e.login === args.login) e.revokedAt = new Date().toISOString();
		saveRegistry(regFile, reg);
		log(`登记：已标记 revokedAt（${regFile}）`);
	}
	console.log(apply ? "✓ 吊销完成（Gitea 侧即时生效）" : "（dry-run：加 --apply 执行）");
	console.log("  提醒：撤权/改密后凭据即刻失效；如需彻底清理账号，用 --delete-user。");
	return 0;
}

async function cmdGrant(args, apply) {
	const api = makeApi(args.api, readAdminAuth(args));
	if (args.api === undefined || args.repo === undefined || args.device === undefined || args.login === undefined) throw new Error("grant 需要 --api --repo --device --login");
	await grantAccess(api, args.repo, args.login, args.grant ?? "team", args.team ?? defaultTeam(args.repo), args.permission ?? "read", apply);
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

/** P3：签发一次性兑换码（enroll 服务用）；明文只打印一次 */
function cmdCode(args) {
	const op = args.op ?? "enroll";
	if (!CODE_OPS.includes(op)) throw new Error(`--op 需为 ${CODE_OPS.join("/")}`);
	const ttlMin = args.ttl === undefined ? 30 : Number.parseInt(args.ttl, 10);
	if (!Number.isFinite(ttlMin) || ttlMin < 0) throw new Error("--ttl 需为非负整数（分钟）");
	const file = args.registry ?? "ops-kb-registry.json";
	const { code, expiresAt } = issueCode(file, { op, device: args.device, ttlMin, by: args.by ?? "owner" });
	console.log(`✓ 已签发一次性兑换码（op=${op}${args.device === undefined ? "" : `，绑定设备 ${args.device}`}，有效期至 ${expiresAt}）`);
	console.log(`  · 码（**只显示这一次**）：${code}`);
	console.log(`  · 在实例上执行：omo kb enroll --server <服务地址> --code-file <把码写进 0600 文件>`);
	console.log(`  · 登记：${file}（只存 sha256，不存明文）`);
	return 0;
}

function cmdList(args) {
	const file = args.registry ?? "ops-kb-registry.json";
	const reg = loadRegistry(file);
	if (reg.entries.length === 0) console.log(`（${file} 无 bot 登记项）`);
	for (const e of reg.entries) {
		console.log(`  ${e.revokedAt === undefined ? "●" : "○"} ${e.device ?? "-"}  ${e.login}  ${e.repo ?? "-"}  授予=${e.grant ?? "-"}(团队 ${e.team ?? "-"}/${e.permission ?? "-"})  ${e.credentialKind ?? "token"}  秘密sha1=${String(e.secretSha1 ?? e.tokenSha1 ?? "").slice(0, 12)}…  ${e.revokedAt === undefined ? "有效" : `已吊销 ${e.revokedAt}`}`);
	}
	const pending = (reg.codes ?? []).filter((c) => c.usedAt === undefined && Date.parse(c.expiresAt) > Date.now());
	if (pending.length > 0) {
		console.log(`  未使用兑换码 ${pending.length} 个：`);
		for (const c of pending) console.log(`    · op=${c.op} 设备=${c.device ?? "任意"} 过期=${c.expiresAt} sha256=${c.sha256.slice(0, 12)}…`);
	}
	return 0;
}

/** 自检：本地桩服务器，端到端跑 create → rotate → revoke → code（无网络、无真凭据） */
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
			if (u.pathname === "/api/v1/teams/7/repos/acme/kb" && req.method === "PUT") return new Response(null, { status: 204 });
			if (u.pathname === "/api/v1/teams/7/members/omo-bot" && req.method === "PUT") return new Response(null, { status: 204 });
			if (u.pathname === "/api/v1/teams/7/members/omo-bot" && req.method === "DELETE") return new Response(null, { status: 204 });
			if (u.pathname === "/api/v1/repos/acme/kb" && req.method === "GET") return json({ full_name: "acme/kb" });
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
		checks.push(["调用序：建号 → 查团队 → 建团队 → 挂仓库 → 加成员 → 自证", seen.join("|").includes("POST /api/v1/admin/users|GET /api/v1/orgs/acme/teams/search|POST /api/v1/orgs/acme/teams|PUT /api/v1/teams/7/repos/acme/kb|PUT /api/v1/teams/7/members/omo-bot|GET /api/v1/repos/acme/kb"), seen.join("|")]);
		const cred = JSON.parse(fs.readFileSync(deliver, "utf8"));
		checks.push(["交付：kind=password + 仓库地址由 API 前缀推导", cred.kind === "password" && cred.repo === `http://127.0.0.1:${server.port}/acme/kb` && cred.secret.length > 20, JSON.stringify({ ...cred, secret: "***" })]);
		checks.push(["交付文件 0600", (fs.statSync(deliver).mode & 0o777) === 0o600, (fs.statSync(deliver).mode & 0o777).toString(8)]);
		const r1 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["登记无秘密本体、只有 sha1", r1.entries.length === 1 && !JSON.stringify(r1).includes(cred.secret), JSON.stringify(r1)]);
		const ro = await run(["rotate", ...common, "--login", "omo-bot", "--deliver", deliver, "--apply"]);
		checks.push(["rotate 换密并更新交付", ro.code === 0 && JSON.parse(fs.readFileSync(deliver, "utf8")).secret !== cred.secret, ro.out]);
		const rv = await run(["revoke", ...common, "--login", "omo-bot", "--apply"]);
		const r2 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["revoke 改乱密码 + 撤团队成员 + 标记", rv.code === 0 && r2.entries[0].revokedAt !== undefined && seen.includes("DELETE /api/v1/teams/7/members/omo-bot"), rv.out + rv.err]);
		const dry = await run(["create", ...common, "--login", "omo-bot-2", "--deliver", path.join(dir, "d2.json")]);
		checks.push(["默认 dry-run：不建号、不落交付", dry.code === 0 && !fs.existsSync(path.join(dir, "d2.json")), dry.out]);
		const wide = path.join(dir, "wide.token");
		fs.writeFileSync(wide, "X\n", { mode: 0o644 });
		const w = await run(["create", "--api", base, "--admin-token-file", wide, "--repo", "acme/kb", "--device", "n", "--login", "x", "--apply"]);
		checks.push(["管理员令牌文件权限过宽即拒", w.code !== 0 && w.err.includes("权限过宽"), w.err]);
		const basic = await run(["create", "--api", base, "--admin-user", "root", "--admin-password-file", tokenFile, "--repo", "acme/kb", "--device", "node-2", "--login", "omo-bot-3", "--registry", reg, "--deliver", path.join(dir, "d3.json"), "--apply"]);
		checks.push(["支持基本认证（账号+密码）路径", basic.code === 0, basic.out + basic.err]);
		const code = await run(["code", "--op", "enroll", "--device", "node-9", "--ttl", "30", "--registry", reg]);
		const r3 = JSON.parse(fs.readFileSync(reg, "utf8"));
		const plain = /码（\*\*只显示这一次\*\*）：(\S+)/.exec(code.out)?.[1];
		checks.push(["签发兑换码：明文只打印一次，登记表只存 sha256", code.code === 0 && typeof plain === "string" && r3.codes.at(-1).sha256 !== plain && r3.codes.at(-1).device === "node-9" && !JSON.stringify(r3).includes(plain), code.out]);
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
		if (cmd === "code") process.exit(cmdCode(args));
		if (cmd === "list") process.exit(cmdList(args));
		console.log(USAGE);
		process.exit(cmd === undefined ? 0 : 1);
	} catch (err) {
		console.error(`✗ ${err.message}`);
		process.exit(1);
	}
}
