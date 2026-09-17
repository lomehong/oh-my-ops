import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enroll } from "../src/kb-enroll.ts";
import { kbCredentialPath, kbGitCredentialsPath, loadKbCredential } from "../src/kb-credential.ts";

/**
 * P3 端到端：一次性码签发（供给 CLI）→ enroll 服务（真子进程，真 HTTP）→ 客户端兑换落盘。
 * 依赖：桩 Gitea（本测试内起，无网络）、bun 运行时（服务用到 @ops-pi/core 的 AuditLog）。
 */
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SERVICE = path.join(REPO_ROOT, "scripts/ops-kb-enroll-server.mjs");
const PROVISION = path.join(REPO_ROOT, "scripts/ops-kb-provision.mjs");

interface FakeGitea {
	port: number;
	calls: string[];
	botAuthSeen: string[];
	stop: () => void;
}

/** 桩 Gitea：覆盖 enroll 服务用到的端点；记录调用序与 bot 凭据头（用于断言服务真用了该凭据） */
function startFakeGitea(): FakeGitea {
	const calls: string[] = [];
	const botAuthSeen: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			calls.push(`${req.method} ${u.pathname}`);
			const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
			if (u.pathname === "/api/v1/admin/users" && req.method === "POST") return json({ id: 11, login: "created" }, 201);
			if (u.pathname.startsWith("/api/v1/admin/users/") && req.method === "PATCH") return json({ ok: true });
			if (u.pathname.startsWith("/api/v1/admin/users/") && req.method === "DELETE") return new Response(null, { status: 204 });
			if (u.pathname === "/api/v1/orgs/acme/teams/search") return json({ data: [{ id: 5, name: "omo-kb-kb" }] });
			if (u.pathname.startsWith("/api/v1/teams/5/repos/") && req.method === "PUT") return new Response(null, { status: 204 });
			if (u.pathname.startsWith("/api/v1/teams/5/members/") && req.method === "PUT") return new Response(null, { status: 204 });
			if (u.pathname.startsWith("/api/v1/teams/5/members/") && req.method === "DELETE") return new Response(null, { status: 204 });
			if (u.pathname.startsWith("/api/v1/repos/acme/kb") && req.method === "GET") {
				botAuthSeen.push(req.headers.get("authorization") ?? "");
				return json({ full_name: "acme/kb" });
			}
			return json({}, 200);
		},
	});
	return { port: server.port ?? 0, calls, botAuthSeen, stop: () => server.stop(true) };
}

async function startService(opts: { api: string; repo: string; dir: string; extra?: string[] }): Promise<{ base: string; stop: () => void; out: () => string }> {
	const tokenFile = path.join(opts.dir, "admin.token");
	fs.writeFileSync(tokenFile, "FAKE-ADMIN-TOKEN\n", { mode: 0o600 });
	const proc = Bun.spawn({
		cmd: [
			"bun",
			SERVICE,
			"--api", opts.api,
			"--repo", opts.repo,
			"--admin-token-file", tokenFile,
			"--registry", path.join(opts.dir, "registry.json"),
			"--audit", path.join(opts.dir, "audit.jsonl"),
			"--host", "127.0.0.1",
			"--port", "0",
			"--allow-insecure-http", // 测试用明文回环；生产由 --tls-cert/--tls-key 直连 TLS
			...(opts.extra ?? []),
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value);
		if (buffered.includes("LISTEN ")) break;
	}
	const listen = /LISTEN (https?):\/\/([^\s]+)/.exec(buffered);
	if (listen === null) throw new Error(`服务未就绪：${buffered}\n${await new Response(proc.stderr).text()}`);
	return {
		base: `${listen[1]}://${listen[2]}`,
		stop: () => proc.kill(),
		out: () => buffered,
	};
}

/** 用供给 CLI 签发一次性码（真子进程），返回明文码 */
async function issueCode(dir: string, args: string[]): Promise<{ code: string; out: string }> {
	const proc = Bun.spawn({ cmd: ["bun", PROVISION, "code", "--registry", path.join(dir, "registry.json"), ...args], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`签发码失败：${err}`);
	const code = /码（\*\*只显示这一次\*\*）：(\S+)/.exec(out)?.[1];
	if (code === undefined) throw new Error(`未能解析码：${out}`);
	return { code, out };
}

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omo-enroll-"));
}

describe("P3 · 凭据自注册端到端（服务真 HTTP + 客户端真兑换）", () => {
	test("★ 一次性码 → 建号+授权+自证 → 客户端落盘 0600 → 登记/审计不含秘密", async () => {
		const gitea = startFakeGitea();
		const dir = tmpdir();
		const omo = tmpdir();
		const svc = await startService({ api: `http://127.0.0.1:${gitea.port}/api/v1`, repo: "acme/kb", dir });
		try {
			const { code } = await issueCode(dir, ["--op", "enroll", "--device", "node-1"]);
			const r = await enroll({ server: svc.base, code, device: "node-1", allowInsecureHttp: true }, omo);
			expect(r.ok).toBe(true);
			expect(r.message).toContain("凭据已发放");

			// 凭据落盘：0600 + 内容正确（repo 指向桩 Gitea）
			const cred = await loadKbCredential(omo);
			expect(cred?.kind).toBe("password");
			expect(cred?.username).toBe("omo-bot-node-1");
			expect(cred?.repo).toBe(`http://127.0.0.1:${gitea.port}/acme/kb`);
			expect(fs.statSync(kbCredentialPath(omo)).mode & 0o777).toBe(0o600);
			expect(fs.statSync(kbGitCredentialsPath(omo)).mode & 0o777).toBe(0o600);
			const storeLine = fs.readFileSync(kbGitCredentialsPath(omo), "utf8");
			expect(storeLine).toContain(`omo-bot-node-1:${cred?.secret}@127.0.0.1`);

			// 服务侧：真按 bot 凭据自证（Basic 头解出的用户名 = bot 账号）
			expect(gitea.botAuthSeen.length).toBeGreaterThan(0);
			const decoded = Buffer.from(gitea.botAuthSeen.at(-1)!.replace(/^Basic /, ""), "base64").toString("utf8");
			expect(decoded).toBe(`omo-bot-node-1:${cred?.secret}`);

			// 秘密不落登记表/审计：码明文、bot 密码都不得出现
			const reg = fs.readFileSync(path.join(dir, "registry.json"), "utf8");
			const audit = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
			for (const blob of [reg, audit]) {
				expect(blob).not.toContain(code);
				expect(blob).not.toContain(cred!.secret);
			}
			expect(reg).toContain("secretSha1");
			expect(audit).toContain("enroll.enroll");
		} finally {
			svc.stop();
			gitea.stop();
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ 码是一次性的：重放 → 409；设备不匹配 → 403；过期 → 410", async () => {
		const gitea = startFakeGitea();
		const dir = tmpdir();
		const omo = tmpdir();
		const svc = await startService({ api: `http://127.0.0.1:${gitea.port}/api/v1`, repo: "acme/kb", dir });
		try {
			const { code } = await issueCode(dir, ["--op", "enroll", "--device", "node-1"]);
			await enroll({ server: svc.base, code, device: "node-1", allowInsecureHttp: true }, omo);
			await expect(enroll({ server: svc.base, code, device: "node-1", allowInsecureHttp: true }, omo)).rejects.toThrow(/已被使用/);

			const { code: c2 } = await issueCode(dir, ["--op", "enroll", "--device", "node-1"]);
			await expect(enroll({ server: svc.base, code: c2, device: "other-node", allowInsecureHttp: true }, omo)).rejects.toThrow(/不匹配/);

			const { code: c3 } = await issueCode(dir, ["--op", "enroll", "--device", "node-1", "--ttl", "0"]);
			await expect(enroll({ server: svc.base, code: c3, device: "node-1", allowInsecureHttp: true }, omo)).rejects.toThrow(/已过期/);
		} finally {
			svc.stop();
			gitea.stop();
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ revoke 码：服务改乱密码 + 撤权，客户端删除本地凭据", async () => {
		const gitea = startFakeGitea();
		const dir = tmpdir();
		const omo = tmpdir();
		const svc = await startService({ api: `http://127.0.0.1:${gitea.port}/api/v1`, repo: "acme/kb", dir });
		try {
			const { code } = await issueCode(dir, ["--op", "enroll", "--device", "node-1"]);
			await enroll({ server: svc.base, code, device: "node-1", allowInsecureHttp: true }, omo);
			expect(fs.existsSync(kbCredentialPath(omo))).toBe(true);

			const { code: rc } = await issueCode(dir, ["--op", "revoke", "--device", "node-1"]);
			const r = await enroll({ server: svc.base, code: rc, device: "node-1", allowInsecureHttp: true }, omo);
			expect(r.revoked).toBe(true);
			expect(fs.existsSync(kbCredentialPath(omo))).toBe(false);
			expect(gitea.calls.some((c) => c.startsWith("PATCH /api/v1/admin/users/"))).toBe(true);
			expect(gitea.calls.some((c) => c.startsWith("DELETE /api/v1/teams/5/members/"))).toBe(true);
		} finally {
			svc.stop();
			gitea.stop();
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ 安全默认：明文 HTTP 未显式允许 → 客户端拒绝；服务未配 TLS → 拒绝启动", async () => {
		const gitea = startFakeGitea();
		const dir = tmpdir();
		try {
			await expect(enroll({ server: "http://127.0.0.1:1", code: "x", device: "d" }, tmpdir())).rejects.toThrow(/拒绝以明文 HTTP/);

			const noTls = Bun.spawn({
				cmd: ["bun", SERVICE, "--api", `http://127.0.0.1:${gitea.port}/api/v1`, "--repo", "acme/kb", "--admin-token-file", path.join(dir, "t"), "--registry", path.join(dir, "r.json"), "--port", "0"],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			});
			fs.writeFileSync(path.join(dir, "t"), "TOKEN\n", { mode: 0o600 });
			const err = await new Response(noTls.stderr).text();
			expect(await noTls.exited).not.toBe(0);
			expect(err).toContain("拒绝以明文 HTTP 启动");
		} finally {
			gitea.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("/healthz 可用且不回显任何秘密", async () => {
		const gitea = startFakeGitea();
		const dir = tmpdir();
		const svc = await startService({ api: `http://127.0.0.1:${gitea.port}/api/v1`, repo: "acme/kb", dir });
		try {
			const res = await fetch(`${svc.base}/healthz`);
			const body = (await res.json()) as { ok: boolean; repo: string; tls: boolean };
			expect(res.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.repo).toBe("acme/kb");
			expect(body.tls).toBe(false);
			expect(JSON.stringify(body)).not.toContain("FAKE-ADMIN-TOKEN");
		} finally {
			svc.stop();
			gitea.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
