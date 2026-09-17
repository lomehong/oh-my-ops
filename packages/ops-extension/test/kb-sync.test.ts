import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ShellExec } from "@ops-pi/core";
import { syncKb, instanceBranchFor } from "../src/kb-sync.ts";
import { daysUntilExpiry, kbCredentialPath, kbGitCredentialsPath, loadKbCredential, omoHomeDir, redactUrl, saveGitCredentialsFile, saveKbCredential, secretPrefix, KbCredentialError, ensureGitCredentialsFile } from "../src/kb-credential.ts";

/**
 * OMO-KB-SYNC P1 守卫：分支纪律 + 凭据文件（真 git、file:// 裸仓，无网络）。
 *
 * 分支纪律（主人决策）：实例**只 pull main**、**只推 instance/<device>**；`main` 由中心合流（PR）。
 */

function fixture(): { bare: string; dirs: { a: string; b: string; coord: string }; cleanup: () => void } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-sync-"));
	const bare = path.join(base, "origin.git");
	fs.mkdirSync(bare, { recursive: true });
	const dirs = {
		a: path.join(base, "node-a"),
		b: path.join(base, "node-b"),
		coord: path.join(base, "coordinator"),
	};
	for (const d of Object.values(dirs)) fs.mkdirSync(path.join(d, "knowledge"), { recursive: true });
	return { bare, dirs, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function initBare(shell: ShellExec, bare: string): Promise<void> {
	await shell.exec(["git", "init", "--bare", "--initial-branch=main", bare], { timeoutMs: 30_000 });
}

async function branchesOf(shell: ShellExec, bare: string): Promise<string> {
	const r = await shell.exec(["git", "--git-dir", bare, "branch", "--list", "--format=%(refname:short)"], { timeoutMs: 30_000 });
	return r.stdout;
}

describe("instanceBranchFor：分支名安全化", () => {
	test("设备名含非法字符 → 归一；空名 → unknown", () => {
		expect(instanceBranchFor("PC-SZ-375")).toBe("instance/PC-SZ-375");
		expect(instanceBranchFor("host name/with:bad")).toBe("instance/host-name-with-bad");
		expect(instanceBranchFor("")).toBe("instance/unknown");
	});
});

describe("syncKb：分支纪律（真 git + file:// 裸仓）", () => {
	test("★ 实例只推 instance/<device>，绝不推 main；main 由中心合流后才对他人可见", async () => {
		const shell = new ShellExec();
		const { bare, dirs, cleanup } = fixture();
		try {
			await initBare(shell, bare);
			// A 节点：写条目 → sync(push) → 应推自己的实例分支
			fs.writeFileSync(path.join(dirs.a, "knowledge", "runbook-502.md"), "# Runbook 502\n现象/根因/处置\n");
			const ra = await syncKb({ omoDir: dirs.a, kbDir: path.join(dirs.a, "knowledge"), repo: bare, branch: "main", device: "node-a", runner: shell, push: true });
			expect(ra.ok).toBe(true);
			expect(ra.actions.join(" ")).toContain("push instance/node-a ✓");
			expect(ra.actions.join(" ")).not.toContain("push main");

			const branches1 = await branchesOf(shell, bare);
			expect(branches1).toContain("instance/node-a");
			expect(branches1).not.toContain("main"); // A 的提交没有进 main

			// B 节点：只拉 main → 看不到 A 的条目（符合「main 由中心合流」模型）
			const rb = await syncKb({ omoDir: dirs.b, kbDir: path.join(dirs.b, "knowledge"), repo: bare, branch: "main", device: "node-b", runner: shell, push: false });
			expect(rb.ok).toBe(true);
			expect(fs.existsSync(path.join(dirs.b, "knowledge", "runbook-502.md"))).toBe(false);

			// 中心合流：把 A 的实例分支合进 main（模拟 Owner/协调者审阅后的 PR 合并）
			// 克隆到**全新空目录**（fixture 里的 coord 目录已含 knowledge/，非空 → clone 会失败）
			const coordClone = path.join(path.dirname(bare), "coordinator-clone");
			const cloned = await shell.exec(["git", "clone", bare, coordClone], { timeoutMs: 30_000 });
			expect(cloned.exitCode, cloned.stderr).toBe(0);
			const fetched = await shell.exec(["git", "fetch", "origin", "instance/node-a"], { cwd: coordClone, timeoutMs: 30_000 });
			expect(fetched.exitCode).toBe(0);
			// 直接把取到的提交推进 main（等价于 PR 合并；空裸仓克隆无本地分支，避免 checkout 分支纠缠）
			const pushMain = await shell.exec(["git", "push", "origin", "FETCH_HEAD:refs/heads/main"], { cwd: coordClone, timeoutMs: 30_000 });
			expect(pushMain.exitCode, pushMain.stderr).toBe(0);

			// B 再同步 → 见到条目
			const rb2 = await syncKb({ omoDir: dirs.b, kbDir: path.join(dirs.b, "knowledge"), repo: bare, branch: "main", device: "node-b", runner: shell, push: false });
			expect(rb2.ok).toBe(true);
			expect(fs.existsSync(path.join(dirs.b, "knowledge", "runbook-502.md"))).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("重复同步：无改动 → 不提交；状态落盘可读", async () => {
		const shell = new ShellExec();
		const { bare, dirs, cleanup } = fixture();
		try {
			await initBare(shell, bare);
			fs.writeFileSync(path.join(dirs.a, "knowledge", "x.md"), "# x\n");
			await syncKb({ omoDir: dirs.a, kbDir: dirs.a, repo: bare, branch: "main", device: "node-a", runner: shell, push: true });
			const again = await syncKb({ omoDir: dirs.a, kbDir: dirs.a, repo: bare, branch: "main", device: "node-a", runner: shell, push: true });
			expect(again.actions.join(" ")).toContain("无本地改动，无需提交");
			const state = JSON.parse(fs.readFileSync(path.join(dirs.a, "kb", "state.json"), "utf8")) as { ok: boolean; instanceBranch: string };
			expect(state.ok).toBe(true);
			expect(state.instanceBranch).toBe("instance/node-a");
		} finally {
			cleanup();
		}
	});

	test("无远端 → 本地模式（ok=true 且不抛错）", async () => {
		const shell = new ShellExec();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-local-"));
		try {
			const r = await syncKb({ omoDir: dir, kbDir: dir, repo: undefined, branch: "main", device: "node-x", runner: shell });
			expect(r.ok).toBe(true);
			expect(r.actions.join(" ")).toContain("本地模式");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("实例分支不得等于主线（守卫）", async () => {
		const shell = new ShellExec();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-guard-"));
		try {
			const r = await syncKb({ omoDir: dir, kbDir: dir, repo: "/nonexistent", branch: "instance/dev", device: "dev", runner: shell });
			expect(r.ok).toBe(false);
			expect(String(r.error)).toContain("分支纪律");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("kb-credential：凭据落盘与展示纪律", () => {
	test("★ 凭据文件与 git 凭据文件均为 0600；展示只到前缀", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-cred-"));
		try {
			const cred = { repo: "https://twin.hzins.com/git/hzins-ops/ops-kb", username: "omo-bot", secret: "abcdef1234567890", kind: "token" as const, createdAt: new Date().toISOString() };
			await saveKbCredential(dir, cred);
			await saveGitCredentialsFile(dir, cred);
			const loaded = await loadKbCredential(dir);
			expect(loaded?.username).toBe("omo-bot");
			expect(fs.statSync(kbCredentialPath(dir)).mode & 0o777).toBe(0o600);
			expect(fs.statSync(kbGitCredentialsPath(dir)).mode & 0o777).toBe(0o600);
			// git store 格式：scheme://user:token@host（供 credential.helper=store --file 读取）
			expect(fs.readFileSync(kbGitCredentialsPath(dir), "utf8").trim()).toBe("https://omo-bot:abcdef1234567890@twin.hzins.com");
			expect(secretPrefix("abcdef1234567890")).toBe("abcdef12…");
			expect(kbGitCredentialsPath(dir)).toContain(path.join("home", ".git-credentials")); // store canonical 路径（实测）
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("redactUrl 去掉内嵌凭据；daysUntilExpiry 计算天数", () => {
		expect(redactUrl("https://user:tok@host/git/a/b")).toBe("https://host/git/a/b");
		const base = Date.now();
		expect(daysUntilExpiry(new Date(base + 10 * 86_400_000).toISOString(), base)).toBe(10);
		expect(daysUntilExpiry(undefined)).toBeUndefined();
	});
});

describe("凭据绝不入库（含 kbDir 与 $OMO_DIR/kb 误配的场景）", () => {
	test("★ kbDir 与私有域重叠时，credential/state 仍不会被 commit", async () => {
		const shell = new ShellExec();
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-nested-"));
		try {
			const bare = path.join(base, "origin.git");
			fs.mkdirSync(bare, { recursive: true });
			await initBare(shell, bare);
			const omo = path.join(base, "omo");
			fs.mkdirSync(omo, { recursive: true });
			await saveKbCredential(omo, { repo: bare, username: "bot", secret: "SECRET-TOKEN-VALUE", kind: "password" as const, createdAt: new Date().toISOString() });
			fs.writeFileSync(path.join(omo, "real-entry.md"), "# 真条目\n");
			// 故意把 kbDir 配成私有域根（最坏误配）
			const r = await syncKb({ omoDir: omo, kbDir: omo, repo: bare, branch: "main", device: "node-nested", runner: shell, push: true });
			expect(r.ok).toBe(true);
			const tracked = await shell.exec(["git", "ls-files"], { cwd: omo, timeoutMs: 30_000 });
			expect(tracked.stdout).toContain("real-entry.md");
			expect(tracked.stdout).not.toContain("credential.json");
			expect(tracked.stdout).not.toContain("state.json");
			expect(tracked.stdout).not.toContain("git-credentials");
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("凭据注入机制（真机实测口径）：credential.helper=store + 私有 HOME", () => {
	test("★ 凭据文件落在 omo 私有 HOME 下；git credential fill 能从该文件取到（离线可判）", async () => {
		const shell = new ShellExec();
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-cred-"));
		try {
			fs.mkdirSync(omoHomeDir(omo), { recursive: true });
			const cred = { repo: "https://twin.hzins.com/git/hzins-ops/ops-kb", username: "omo-bot", secret: "TOKEN-VALUE-1234", kind: "token" as const, createdAt: new Date().toISOString() };
			const file = await saveGitCredentialsFile(omo, cred);
			expect(file).toBe(path.join(omo, "home", ".git-credentials"));
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			// 与 syncKb 完全同款：-c credential.helper=store + HOME=私有 HOME
			const r = await shell.exec(["git", "-c", "credential.helper=store", "credential", "fill"], {
				cwd: omo,
				env: { HOME: omoHomeDir(omo), GIT_TERMINAL_PROMPT: "0" },
				stdin: "protocol=https\nhost=twin.hzins.com\n\n",
				timeoutMs: 20_000,
			});
			expect(r.stdout).toContain("username=omo-bot");
			expect(r.stdout).toContain("password=TOKEN-VALUE-1234");
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("未配置凭据时不注入 helper、不改 HOME（本地模式不受影响）", async () => {
		const shell = new ShellExec();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-nocred-"));
		try {
			const r = await syncKb({ omoDir: dir, kbDir: path.join(dir, "knowledge"), repo: undefined, branch: "main", device: "node-n", runner: shell });
			expect(r.ok).toBe(true);
			expect(r.actions.join(" ")).toContain("本地模式");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("凭据文件损坏/旧格式必须大声失败（禁止静默降级为本地模式）", () => {
	test("★ 旧格式（token 字段）→ 抛 KbCredentialError 并指向重新签发", async () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-legacy-"));
		try {
			fs.mkdirSync(path.join(omo, "kb"), { recursive: true });
			fs.writeFileSync(kbCredentialPath(omo), JSON.stringify({ repo: "https://h/g/o", username: "u", token: "old", createdAt: new Date().toISOString() }), { mode: 0o600 });
			await expect(loadKbCredential(omo)).rejects.toThrow(KbCredentialError);
			await expect(loadKbCredential(omo)).rejects.toThrow(/旧格式|重新签发/);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ 非 JSON / 缺 kind / 空值 → 抛错；文件不存在 → undefined（合法本地模式）", async () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-badcred-"));
		try {
			fs.mkdirSync(path.join(omo, "kb"), { recursive: true });
			await expect(loadKbCredential(omo)).resolves.toBeUndefined();
			fs.writeFileSync(kbCredentialPath(omo), "{not json", { mode: 0o600 });
			await expect(loadKbCredential(omo)).rejects.toThrow(/不是合法 JSON/);
			fs.writeFileSync(kbCredentialPath(omo), JSON.stringify({ repo: "https://h/g/o", username: "u", secret: "s" }), { mode: 0o600 });
			await expect(loadKbCredential(omo)).rejects.toThrow(/字段不完整/);
			fs.writeFileSync(kbCredentialPath(omo), JSON.stringify({ repo: "", username: "u", secret: "s", kind: "password" }), { mode: 0o600 });
			await expect(loadKbCredential(omo)).rejects.toThrow(/空值/);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});
});

describe("凭据轮换后 git store 文件必须刷新（真机教训：旧密码导致同步失败）", () => {
	test("★ 同凭据不重复写；凭据变更（轮换）即刷新", async () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-rotate-"));
		try {
			const base = { repo: "https://git.example.com/o/r", username: "bot", kind: "password" as const, createdAt: new Date().toISOString() };
			const first = await ensureGitCredentialsFile(omo, { ...base, secret: "pw-v1" });
			expect(first).toBe(true);
			expect(await ensureGitCredentialsFile(omo, { ...base, secret: "pw-v1" })).toBe(false); // 幂等
			expect(await ensureGitCredentialsFile(omo, { ...base, secret: "pw-v2" })).toBe(true); // 轮换后刷新
			const line = fs.readFileSync(kbGitCredentialsPath(omo), "utf8");
			expect(line).toContain("bot:pw-v2@git.example.com");
			expect(line).not.toContain("pw-v1");
			expect(fs.statSync(kbGitCredentialsPath(omo)).mode & 0o777).toBe(0o600);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});
});

describe("★ 同设备名的新克隆：远端已有实例分支时必须能推送（真机 fetch first 被拒的回归）", () => {
	test("新克隆 push 前并入远端实例分支 → 快进成功，两个条目都在", async () => {
		const shell = new ShellExec();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-rejoin-"));
		const remote = path.join(root, "remote.git");
		const seed = path.join(root, "seed");
		const cloneA = path.join(root, "cloneA");
		const cloneB = path.join(root, "cloneB");
		try {
			await shell.exec(["git", "init", "--bare", "-b", "main", remote]);
			await shell.exec(["git", "clone", remote, seed]);
			await shell.exec(["git", "-C", seed, "config", "user.email", "t@t"]); await shell.exec(["git", "-C", seed, "config", "user.name", "t"]);
			fs.writeFileSync(path.join(seed, "README.md"), "kb\n");
			await shell.exec(["git", "-C", seed, "add", "-A"]); await shell.exec(["git", "-C", seed, "commit", "-m", "init"]);
			await shell.exec(["git", "-C", seed, "push", "origin", "main"]);

			// cloneA：设备 node-1 先推一个条目
			await shell.exec(["git", "clone", remote, cloneA]);
			fs.writeFileSync(path.join(cloneA, "a.md"), "from A\n");
			const rA = await syncKb({ omoDir: root, kbDir: cloneA, repo: remote, branch: "main", device: "node-1", runner: shell, push: true });
			expect(rA.actions.join(" ")).toContain("push instance/node-1 ✓");

			// cloneB：**同名设备**、全新克隆、不同条目 → 以前会被 fetch first 拒绝
			await shell.exec(["git", "clone", remote, cloneB]);
			fs.writeFileSync(path.join(cloneB, "b.md"), "from B\n");
			const rB = await syncKb({ omoDir: root, kbDir: cloneB, repo: remote, branch: "main", device: "node-1", runner: shell, push: true });
			expect(rB.actions.join(" ")).toContain("已并入远端实例分支");
			expect(rB.actions.join(" ")).toContain("push instance/node-1 ✓");
			expect(rB.ok).toBe(true);

			// 远端实例分支应同时含两个条目
			const ls = await shell.exec(["git", "--git-dir", remote, "ls-tree", "-r", "--name-only", "instance/node-1"]);
			expect(ls.stdout).toContain("a.md");
			expect(ls.stdout).toContain("b.md");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("★ 已有本地提交但本轮无新改动时，也必须推送（真机漏推回归）", () => {
	test("手工 commit 后 sync（无新文件改动）→ 仍推送到实例分支", async () => {
		const shell = new ShellExec();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-ahead-"));
		const remote = path.join(root, "remote.git");
		const seed = path.join(root, "seed");
		const clone = path.join(root, "clone");
		try {
			await shell.exec(["git", "init", "--bare", "-b", "main", remote]);
			await shell.exec(["git", "clone", remote, seed]);
			await shell.exec(["git", "-C", seed, "config", "user.email", "t@t"]); await shell.exec(["git", "-C", seed, "config", "user.name", "t"]);
			fs.writeFileSync(path.join(seed, "README.md"), "kb\n");
			await shell.exec(["git", "-C", seed, "add", "-A"]); await shell.exec(["git", "-C", seed, "commit", "-m", "init"]);
			await shell.exec(["git", "-C", seed, "push", "origin", "main"]);
			await shell.exec(["git", "clone", remote, clone]);
			await shell.exec(["git", "-C", clone, "config", "user.email", "t@t"]); await shell.exec(["git", "-C", clone, "config", "user.name", "t"]);
			// 模拟「上次 push 失败的残留」：本地已提交但未推送
			fs.writeFileSync(path.join(clone, "stale.md"), "stranded\n");
			await shell.exec(["git", "-C", clone, "add", "-A"]);
			await shell.exec(["git", "-C", clone, "commit", "-m", "stale（上次推送失败留下）"]);
			// 本轮没有任何新改动
			const r = await syncKb({ omoDir: root, kbDir: clone, repo: remote, branch: "main", device: "node-9", runner: shell, push: true });
			expect(r.actions.join(" ")).toContain("无本地改动，无需提交");
			expect(r.actions.join(" ")).toContain("push instance/node-9 ✓");
			const ls = await shell.exec(["git", "--git-dir", remote, "ls-tree", "-r", "--name-only", "instance/node-9"]);
			expect(ls.stdout).toContain("stale.md");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
