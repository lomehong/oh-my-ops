#!/usr/bin/env node
/**
 * ops-kb-provision.mjs —— 知识库 bot 账号的**访问管理**（P2，Owner 侧离线工具）
 *
 * 契约：docs/designs/omo-kb-sync-credential-design.md §5.2/§5.4/§5.7
 *
 * 真机实测前提（2026-09-17，生产 Gitea 1.27.3，证据见设计文档「第二轮实测」表）：
 *   1. `POST /users/{u}/tokens`（基本认证）**只回 sha1 + token_last_eight，不回明文**
 *      ⇒ API 签发的 token 不可用 ⇒ **凭据签发只能在 Gitea UI 完成（Owner 手动，一次性）**；
 *   2. UI 的 token scope 清单**不含 admin 类**，而 `POST /admin/users` 要求 `write:admin`
 *      ⇒ **bot 账号创建也必须在 UI 或服务端 CLI 完成**；
 *   3. 其余全部可自动化（本脚本覆盖）：建/管团队、加/撤成员、加/撤协作者、PR（write:issue）。
 *      —— 真机已逐个验证：团队 create 201 / 成员 PUT 204 / 团队 DELETE 204 /
 *      协作者 PUT 204 / DELETE 204 / 临时仓 create+delete 204 / PR create 201。
 *
 * 因此本脚本做的是「**授权 + 登记 + 撤销**」（凭据本身由 Owner 在 UI 生成后粘贴交付），不做 token 代签。
 *
 * 用法：
 *   node scripts/ops-kb-provision.mjs grant  --api <base> --token-file <f> --repo <owner/repo> --device <设备名> --login <bot> [--team <名>] [--permission read|write] [--org-member] [--registry <f>] [--dry-run]
 *   node scripts/ops-kb-provision.mjs revoke --api <base> --token-file <f> --repo <owner/repo> --login <bot> [--team <名>] [--org-member] [--delete-team] [--registry <f>] [--dry-run]
 *   node scripts/ops-kb-provision.mjs list   [--registry <f>]
 *   node scripts/ops-kb-provision.mjs --selftest
 *
 * 纪律：
 *   - 令牌**只从文件/env 读**，绝不进 argv、绝不回显、绝不写入 registry（registry 只存 token 的 sha1 供与 UI 对账）；
 *   - 变更类动作默认 **--dry-run 预演**，带 `--apply` 才真跑（治理类动作不静默放行）；
 *   - 撤销 = 撤团队成员（+可选撤组织成员/协作者），**即时生效**；token 本体由 Owner 在 UI 删除（撤权后即使token 存在也无任何访问）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const USAGE = `用法见脚本头注释。示例：
  node scripts/ops-kb-provision.mjs grant --api https://twin.hzins.com/git/api/v1 --token-file ~/.omo/kb-service/admin.token \\
       --repo hzins-ops/ops-kb --device PC-SZ-375 --login omo-bot-pcsz375 --permission write --apply`;

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			out._.push(a);
			continue;
		}
		const key = a.slice(2);
		if (["apply", "dry-run", "org-member", "delete-team", "selftest", "help"].includes(key)) {
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

/** 令牌只从文件/env 取；函数不打印、不外传 */
export function readToken(args, env = process.env) {
	if (args["token-file"] !== undefined) {
		const f = args["token-file"];
		const st = fs.statSync(f);
		if ((st.mode & 0o077) !== 0) throw new Error(`令牌文件权限过宽（应 0600）：${f} 当前 ${(st.mode & 0o777).toString(8)}`);
		return fs.readFileSync(f, "utf8").trim();
	}
	const t = env.OPS_KB_TOKEN;
	if (t === undefined || t.trim() === "") throw new Error("缺少令牌：用 --token-file（推荐，0600）或环境变量 OPS_KB_TOKEN");
	return t.trim();
}

function sha1(s) {
	return crypto.createHash("sha1").update(s).digest("hex");
}

/** 极简 Gitea API 客户端（只做本脚本需要的端点）；失败带上下文，绝不回显令牌 */
export function makeApi(base, token, fetchImpl = fetch) {
	const root = base.replace(/\/+$/, "");
	async function call(method, p, body) {
		const res = await fetchImpl(`${root}${p}`, {
			method,
			headers: { Authorization: `token ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
		get: (p) => call("GET", p),
		post: (p, b) => call("POST", p, b),
		put: (p, b) => call("PUT", p, b),
		del: (p, b) => call("DELETE", p, b),
	};
}

export function loadRegistry(file) {
	if (!fs.existsSync(file)) return { version: 1, entries: [] };
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveRegistry(file, reg) {
	fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

/** 团队名默认由 repo 派生：omo-kb-<repo 名> —— 一仓一团队，授信面最小 */
export function defaultTeam(repo) {
	return `omo-kb-${repo.split("/").pop()}`;
}

function fail(msg, detail) {
	console.error(`✗ ${msg}${detail === undefined ? "" : `：${detail}`}`);
	return 1;
}

/** 确保团队存在（不存在则建）；返回 {id, created} */
async function ensureTeam(api, org, team, permission, apply) {
	const found = await api.get(`/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(team)}`);
	const hit = (found.json?.data ?? []).find((t) => t.name === team);
	if (hit !== undefined) return { id: hit.id, created: false };
	if (!apply) return { id: undefined, created: true };
	const created = await api.post(`/orgs/${encodeURIComponent(org)}/teams`, {
		name: team,
		permission: permission === "write" ? "write" : "read",
		units_map: { "repo.code": permission === "write" ? "write" : "read" },
	});
	if (!created.ok) throw new Error(`建团队失败 HTTP ${created.status} ${created.text.slice(0, 200)}`);
	return { id: created.json.id, created: true };
}

async function teamId(api, org, team) {
	const found = await api.get(`/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(team)}`);
	return (found.json?.data ?? []).find((t) => t.name === team)?.id;
}

async function cmdGrant(args, apply) {
	const api = makeApi(args.api, readToken(args));
	const [org] = args.repo.split("/");
	const team = args.team ?? defaultTeam(args.repo);
	if (args.api === undefined || args.repo === undefined || args.device === undefined || args.login === undefined) throw new Error("grant 需要 --api --repo --device --login");

	// 前置守卫：bot 账号必须已存在（API 无法建号 —— 真机实测，须 Owner 在 UI/服务端 CLI 建）
	const user = await api.get(`/users/${encodeURIComponent(args.login)}`);
	if (user.status === 404) return fail(`bot 账号不存在：${args.login}`, "请先在 Gitea UI 创建该账号（API 无 write:admin，见设计文档实测表）");
	if (!user.ok) return fail(`查询账号失败 HTTP ${user.status}`, user.text.slice(0, 160));

	const t = await ensureTeam(api, org, team, args.permission ?? "write", apply);
	const steps = [];
	steps.push(`团队 ${team}：${t.created ? (apply ? "已创建" : "将创建") : `已存在(id=${t.id})`}`);
	const tid = t.id ?? (await teamId(api, org, team));
	if (tid !== undefined && apply) {
		const add = await api.put(`/teams/${tid}/members/${encodeURIComponent(args.login)}`);
		steps.push(`加入团队：${add.ok ? "✓ 204" : `✗ HTTP ${add.status} ${add.text.slice(0, 120)}`}`);
		if (!add.ok) return fail("加入团队失败", `HTTP ${add.status}`);
	} else if (tid !== undefined) {
		steps.push(`加入团队：将 PUT /teams/${tid}/members/${args.login}`);
	}
	if (args["org-member"] === true && apply) {
		const add = await api.put(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(args.login)}`);
		steps.push(`加入组织：${add.ok ? "✓ 204" : `✗ HTTP ${add.status}`}`);
	}

	const reg = loadRegistry(args.registry ?? "ops-kb-registry.json");
	const entry = {
		device: args.device,
		login: args.login,
		repo: args.repo,
		team,
		permission: args.permission ?? "write",
		// 令牌本体绝不入库；只留 sha1 供 Owner 在 UI 令牌列表对账（Gitea 令牌列表含 sha1）
		tokenSha1: sha1(readToken(args)),
		createdAt: new Date().toISOString(),
	};
	if (apply) {
		reg.entries = reg.entries.filter((e) => !(e.device === entry.device && e.login === entry.login));
		reg.entries.push(entry);
		saveRegistry(args.registry ?? "ops-kb-registry.json", reg);
		steps.push(`登记：${args.registry ?? "ops-kb-registry.json"}（0600，不含令牌本体）`);
	}

	for (const s of steps) console.log(`  · ${s}`);
	console.log(apply ? "✓ 授权完成" : "（dry-run：加 --apply 执行）");
	if (apply) {
		console.log("\n实例侧交付（在目标实例上执行，凭据 0600）：");
		console.log(`  mkdir -p ~/.omo/kb && cat > ~/.omo/kb/credential.json <<'EOF'`);
		console.log(`  {"repo":"${new URL(api.base).origin}${repoWebPath(api.base, args.repo)}","username":"${args.login}","token":"<在 UI 生成并粘贴>","createdAt":"${entry.createdAt}"}`);
		console.log(`  EOF\n  chmod 600 ~/.omo/kb/credential.json && omo kb status && omo kb sync`);
	}
	return 0;
}

/** 由 API base（可能是子路径部署，如 https://host/git/api/v1）推导仓库 HTTPS 地址 */
export function repoWebPath(apiBase, repo) {
	const u = new URL(apiBase);
	const idx = u.pathname.indexOf("/api/");
	const prefix = idx >= 0 ? u.pathname.slice(0, idx) : "";
	return `${prefix}/${repo}`;
}

async function cmdRevoke(args, apply) {
	const api = makeApi(args.api, readToken(args));
	const [org] = args.repo.split("/");
	const team = args.team ?? defaultTeam(args.repo);
	if (args.api === undefined || args.repo === undefined || args.login === undefined) throw new Error("revoke 需要 --api --repo --login");
	const tid = await teamId(api, org, team);
	if (tid !== undefined && apply) {
		const rm = await api.del(`/teams/${tid}/members/${encodeURIComponent(args.login)}`);
		console.log(`  · 撤团队成员：${rm.ok ? "✓ 204" : `✗ HTTP ${rm.status}`}`);
	} else {
		console.log(`  · 撤团队成员：${tid === undefined ? "（团队不存在，跳过）" : `将 DELETE /teams/${tid}/members/${args.login}`}`);
	}
	if (args["org-member"] === true && apply) {
		const rm = await api.del(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(args.login)}`);
		console.log(`  · 撤组织成员：${rm.ok ? "✓ 204" : `✗ HTTP ${rm.status}`}`);
	}
	if (args["delete-team"] === true) {
		const members = await api.get(`/teams/${tid}/members`);
		const others = (members.json ?? []).filter((m) => m.login !== args.login);
		if (others.length > 0) {
			console.log(`  · 解散团队：跳过（团队内还有 ${others.map((m) => m.login).join(", ")}，避免误伤）`);
		} else if (apply && tid !== undefined) {
			const d = await api.del(`/teams/${tid}`);
			console.log(`  · 解散团队 ${team}：${d.ok ? "✓ 204" : `✗ HTTP ${d.status}`}`);
		} else if (tid !== undefined) {
			console.log(`  · 解散团队 ${team}：将 DELETE /teams/${tid}`);
		}
	}
	if (apply) {
		const file = args.registry ?? "ops-kb-registry.json";
		const reg = loadRegistry(file);
		for (const e of reg.entries) if (e.login === args.login && e.device === args.device) e.revokedAt = new Date().toISOString();
		saveRegistry(file, reg);
		console.log(`  · 登记：已标记 revokedAt（${file}）`);
	}
	console.log(apply ? "✓ 撤权完成（Gitea 侧即时生效）" : "（dry-run：加 --apply 执行）");
	console.log("  提醒：令牌本体请在 Gitea UI 的「应用/令牌」里删除；撤权后即便令牌仍在也无仓库访问。");
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
		console.log(`  ${e.revokedAt === undefined ? "●" : "○"} ${e.device}  ${e.login}  ${e.repo}  团队=${e.team}(${e.permission})  令牌sha1=${String(e.tokenSha1).slice(0, 12)}…  ${e.revokedAt === undefined ? "有效" : `已撤 ${e.revokedAt}`}`);
	}
	return 0;
}

/** 自检：本地桩服务器，端到端跑 grant → list → revoke（无网络、无真令牌） */
async function selftest() {
	const seen = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			seen.push(`${req.method} ${u.pathname}`);
			const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
			if (u.pathname === "/api/v1/users/omo-bot") return json({ login: "omo-bot" });
			if (u.pathname === "/api/v1/users/ghost") return new Response('{"message":"user does not exist"}', { status: 404 });
			if (u.pathname === "/api/v1/orgs/acme/teams/search") return json({ data: [] });
			if (u.pathname === "/api/v1/orgs/acme/teams" && req.method === "POST") return json({ id: 7, name: "omo-kb-kb" });
			if (u.pathname === "/api/v1/teams/7/members/omo-bot") return new Response(null, { status: 204 });
			return new Response("{}", { status: 200 });
		},
	});
	const base = `http://127.0.0.1:${server.port}/api/v1`;
	const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ops-kb-provision-"));
	const tokenFile = path.join(dir, "t");
	fs.writeFileSync(tokenFile, "SELFTEST-TOKEN\n", { mode: 0o600 });
	const reg = path.join(dir, "registry.json");
	const common = ["--api", base, "--token-file", tokenFile, "--repo", "acme/kb", "--device", "node-1", "--registry", reg];
	const checks = [];
	// 必须用异步 spawn：spawnSync 会阻塞父进程事件循环，桩服务器无法应答子进程请求（自检会死等）
	const run = async (argv) => {
		const r = Bun.spawn({ cmd: [process.execPath, new URL(import.meta.url).pathname, ...argv], stdout: "pipe", stderr: "pipe" });
		const [out, err] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text()]);
		const code = await r.exited;
		return { code, out, err };
	};
	try {
		const g = await run(["grant", ...common, "--login", "omo-bot", "--apply"]);
		checks.push(["grant 成功", g.code === 0, g.out + g.err]);
		checks.push(["建团队→加成员 顺序正确", seen.join("|").includes("POST /api/v1/orgs/acme/teams|PUT /api/v1/teams/7/members/omo-bot"), seen.join("|")]);
		const r1 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["登记项落盘且无令牌本体", r1.entries.length === 1 && r1.entries[0].login === "omo-bot" && !JSON.stringify(r1).includes("SELFTEST-TOKEN"), JSON.stringify(r1)]);
		checks.push(["登记 0600", (fs.statSync(reg).mode & 0o777) === 0o600, (fs.statSync(reg).mode & 0o777).toString(8)]);
		checks.push(["输出含实例侧交付片段（仓库地址由 API 前缀推导）", g.out.includes("credential.json") && g.out.includes(`http://127.0.0.1:${server.port}/acme/kb`), g.out]);
		const ghost = await run(["grant", ...common, "--login", "ghost", "--apply"]);
		checks.push(["账号不存在即拒（非 0 退出 + 指引）", ghost.code !== 0 && ghost.err.includes("请先在 Gitea UI"), ghost.err]);
		const dry = await run(["grant", ...common, "--login", "omo-bot"]);
		checks.push(["默认 dry-run 不建团队", dry.code === 0 && !seen.slice(seen.lastIndexOf("GET /api/v1/orgs/acme/teams/search")).includes("POST /api/v1/orgs/acme/teams"), dry.out]);
		const rv = await run(["revoke", ...common, "--login", "omo-bot", "--apply"]);
		const r2 = JSON.parse(fs.readFileSync(reg, "utf8"));
		checks.push(["revoke 撤成员并标记", rv.code === 0 && r2.entries[0].revokedAt !== undefined, rv.out + rv.err]);
		const bad = fs.mkdtempSync(path.join(dir, "wide-"));
		const wideFile = path.join(bad, "t");
		fs.writeFileSync(wideFile, "X\n", { mode: 0o644 });
		const w = await run(["grant", "--api", base, "--token-file", wideFile, "--repo", "acme/kb", "--device", "n", "--login", "omo-bot", "--apply"]);
		checks.push(["令牌文件权限过宽即拒", w.code !== 0 && w.err.includes("权限过宽"), w.err]);
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
		if (cmd === "grant") process.exit(await cmdGrant(args, apply));
		if (cmd === "revoke") process.exit(await cmdRevoke(args, apply));
		if (cmd === "list") process.exit(cmdList(args));
		console.log(USAGE);
		process.exit(cmd === undefined ? 0 : 1);
	} catch (err) {
		console.error(`✗ ${err.message}`);
		process.exit(1);
	}
}
