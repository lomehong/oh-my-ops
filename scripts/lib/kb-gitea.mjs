/**
 * kb-gitea.mjs —— 知识库 bot 供给所需的 Gitea API 原语（供给 CLI 与 enroll 服务**共用一份实现**）
 *
 * 真机（Gitea 1.27.3）验证过的口径：
 *   - 管理员鉴权：`all`/admin 作用域令牌 **或** 站点管理员「账号+密码」基本认证（后者绕过 scope 检查）；
 *   - 凭据形态 = **密码**（API 签发的令牌拿不到明文，1.27.3 实测）；
 *   - 团队必须 `PUT /teams/{id}/repos/{org}/{repo}` **挂仓库**，否则成员无任何仓库权限；
 *   - 授权后以 bot 凭据 `GET /repos/{org}/{repo}` 自证（200 = 授权+凭据同时生效）。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { assertSecretFilePerm } from "./secret-perm.mjs";

export function readSecretFile(file, what = "秘密") {
	assertSecretFilePerm(file, what);
	return fs.readFileSync(file, "utf8").trim();
}

/** 管理员凭据：令牌 或「账号+密码」 */
export function readAdminAuth(args, env = process.env) {
	if (args["admin-token-file"] !== undefined) return { kind: "token", token: readSecretFile(args["admin-token-file"], "管理员令牌") };
	const pw = args["admin-password-file"] !== undefined ? readSecretFile(args["admin-password-file"], "管理员密码") : env.OPS_KB_ADMIN_PASSWORD;
	if (args["admin-user"] !== undefined && pw !== undefined && pw !== "") return { kind: "basic", user: args["admin-user"], password: pw.trim() };
	throw new Error("缺少管理员凭据：--admin-token-file 或 --admin-user + --admin-password-file/env OPS_KB_ADMIN_PASSWORD");
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

/** 由 API base（可能是子路径部署，如 https://host/git/api/v1）推导仓库 HTTPS 地址 */
export function repoWebPath(apiBase, repo) {
	const u = new URL(apiBase);
	const idx = u.pathname.indexOf("/api/");
	return `${idx >= 0 ? u.pathname.slice(0, idx) : ""}/${repo}`;
}

export function defaultTeam(repo) {
	return `omo-kb-${repo.split("/").pop()}`;
}

export function randomPassword() {
	return `omo-${crypto.randomBytes(18).toString("base64url")}`;
}

export function sha1(s) {
	return crypto.createHash("sha1").update(s).digest("hex");
}

export function credentialJson(apiBase, repo, login, secret, kind = "password") {
	return { repo: `${new URL(apiBase).origin}${repoWebPath(apiBase, repo)}`, username: login, secret, kind, createdAt: new Date().toISOString() };
}

/** 团队 id（不存在 → undefined） */
export async function teamId(api, org, team) {
	const found = await api.get(`/orgs/${encodeURIComponent(org)}/teams/search?q=${encodeURIComponent(team)}`);
	return (found.json?.data ?? []).find((t) => t.name === team)?.id;
}

/** 确保团队存在；返回 {id, created} */
export async function ensureTeam(api, org, team, permission, apply = true) {
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

/**
 * 建号 / 幂等改密。
 * @returns {{login: string, secret: string, created: boolean}}
 */
export async function ensureUser(api, login, secret, log = () => {}) {
	const created = await api.post("/admin/users", { username: login, password: secret, email: `${login}@omo.local`, must_change_password: false, visibility: "private" });
	if (created.status === 201) {
		log(`建号 ${login} ✓ 201（id=${created.json?.id}）`);
		return { login, secret, created: true };
	}
	if (created.status === 422 || created.status === 409) {
		const patched = await api.patch(`/admin/users/${encodeURIComponent(login)}`, { password: secret, must_change_password: false });
		if (!patched.ok) throw new Error(`改密失败 HTTP ${patched.status} ${patched.text.slice(0, 200)}`);
		log(`账号 ${login} 已存在 → 改密（幂等）✓`);
		return { login, secret, created: false };
	}
	throw new Error(`建号失败 HTTP ${created.status} ${created.text.slice(0, 200)}`);
}

/** 授权：team（团队+挂仓库+加成员）或 collab（仓库协作者） */
export async function grantAccess(api, repo, login, grant, team, permission, log = () => {}) {
	const [org, rname] = repo.split("/");
	if (grant === "none") return;
	if (grant === "collab") {
		const r = await api.put(`/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { permission });
		if (!r.ok) throw new Error(`加协作者失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
		log(`加协作者(${permission}) ✓ ${r.status}`);
		return;
	}
	const t = await ensureTeam(api, org, team, permission, true);
	log(`团队 ${team}：${t.created ? "已创建" : `已存在(id=${t.id})`}`);
	const attach = await api.put(`/teams/${t.id}/repos/${encodeURIComponent(org)}/${encodeURIComponent(rname)}`);
	if (!attach.ok) throw new Error(`团队挂仓库失败 HTTP ${attach.status} ${attach.text.slice(0, 160)}`);
	log(`团队挂仓库 ${repo} ✓ ${attach.status}`);
	const add = await api.put(`/teams/${t.id}/members/${encodeURIComponent(login)}`);
	if (!add.ok) throw new Error(`加团队成员失败 HTTP ${add.status} ${add.text.slice(0, 160)}`);
	log(`加入团队 ✓ ${add.status}`);
}

/** 撤权：撤团队成员/协作者（即时生效；令牌/密码本体由调用方按需处理） */
export async function revokeAccess(api, repo, login, grant, team, log = () => {}) {
	const [org] = repo.split("/");
	if (grant === "collab") {
		const r = await api.del(`/repos/${repo}/collaborators/${encodeURIComponent(login)}`);
		log(`撤协作者：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
		return;
	}
	const id = await teamId(api, org, team);
	if (id === undefined) {
		log("撤团队成员：（团队不存在，跳过）");
		return;
	}
	const r = await api.del(`/teams/${id}/members/${encodeURIComponent(login)}`);
	log(`撤团队成员：${r.ok ? `✓ ${r.status}` : `✗ HTTP ${r.status}`}`);
}

/** 改乱密码 = 凭据即时失效（撤销凭据本体；账号保留以便审计/复用） */
export async function scramblePassword(api, login, log = () => {}) {
	const scram = `revoked-${crypto.randomBytes(18).toString("base64url")}`;
	const r = await api.patch(`/admin/users/${encodeURIComponent(login)}`, { password: scram, must_change_password: false });
	if (!r.ok) throw new Error(`改乱密码失败 HTTP ${r.status} ${r.text.slice(0, 160)}`);
	log(`改乱密码（凭据即时失效）✓ ${r.status}`);
}

/** 以 bot 凭据自证：能读到仓库即代表「授权 + 凭据」同时生效 */
export async function verifyBotCredential(api, repo, login, secret) {
	const probe = await api.get(`/repos/${repo}`, { user: login, password: secret });
	return { ok: probe.ok, status: probe.status };
}
