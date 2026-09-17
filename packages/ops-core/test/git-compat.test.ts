import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { capsFor, detectGitCaps, GitCompat, parseGitVersion, versionAtLeast } from "../src/git-compat.ts";
import { ShellExec } from "../src/exec.ts";
import type { ExecOptions, ExecResult, Runner } from "../src/runner.ts";

/** 记录型 Runner：记录 argv/options 并按脚本返回结果 */
class RecordingRunner implements Runner {
	calls: Array<{ cmd: string[]; options: ExecOptions | undefined }> = [];
	private readonly replies: Array<Partial<ExecResult>>;
	constructor(replies: Array<Partial<ExecResult>> = []) {
		this.replies = replies;
	}
	async exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ cmd: [...cmd], options });
		const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] ?? {};
		return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, ...r } as ExecResult;
	}
	argvs(): string[][] {
		return this.calls.map((c) => c.cmd);
	}
}

describe("git 版本解析与能力表（el7 = 1.8.3.1 是本次兼容层的主要目标）", () => {
	it("parseGitVersion 支持各类版式", () => {
		assert.equal(parseGitVersion("git version 2.39.5"), "2.39.5");
		assert.equal(parseGitVersion("git version 1.8.3.1"), "1.8.3.1");
		assert.equal(parseGitVersion("git version 2.39.5.windows.1"), "2.39.5");
		assert.equal(parseGitVersion("git version 2.28.0-rc1"), "2.28.0");
		assert.equal(parseGitVersion("not a git output"), undefined);
	});

	it("versionAtLeast 逐段数值比较（含缺位）", () => {
		assert.equal(versionAtLeast("1.8.3.1", "1.8.5"), false);
		assert.equal(versionAtLeast("1.8.5", "1.8.5"), true);
		assert.equal(versionAtLeast("2.39.5", "2.28"), true);
		assert.equal(versionAtLeast("2.28", "2.28.0"), true);
		assert.equal(versionAtLeast("2.5.9", "2.6.0"), false);
	});

	it("capsFor：el7 1.8.3.1 两侧皆不支持；现代 git 全支持", () => {
		assert.deepStrictEqual(capsFor("1.8.3.1"), { version: "1.8.3.1", supportsInitB: false, supportsAutostash: false });
		assert.deepStrictEqual(capsFor("2.39.5"), { version: "2.39.5", supportsInitB: true, supportsAutostash: true });
	});

	it("detectGitCaps：git 不可用（抛错）→ undefined", async () => {
		const runner: Runner = {
			exec: async () => {
				throw new Error("[EXEC_FAILED] 命令执行失败：git");
			},
		};
		assert.equal(await detectGitCaps(runner), undefined);
	});

	it("detectGitCaps：解析真实输出", async () => {
		const caps = await detectGitCaps(new RecordingRunner([{ stdout: "git version 1.8.3.1\n" }]));
		assert.equal(caps?.version, "1.8.3.1");
	});
});

describe("GitCompat：按能力退化（argv 形态断言）", () => {
	it("★ el7（不支持 init -b）：init + symbolic-ref；且全程用 cwd、不用 -C", async () => {
		const runner = new RecordingRunner([{ stdout: "" }, { stdout: "" }]);
		const g = new GitCompat(runner, "/kb", capsFor("1.8.3.1"));
		const desc = await g.initOn("main");
		assert.deepStrictEqual(runner.argvs(), [
			["git", "init"],
			["git", "symbolic-ref", "HEAD", "refs/heads/main"],
		]);
		assert.ok(desc.includes("symbolic-ref"));
		assert.ok(!runner.argvs().some((a) => a.includes("init") && a.includes("-b")), "不得出现 init -b");
		assert.ok(!runner.argvs().some((a) => a.includes("-C")), "不得使用 git -C（应走 cwd）");
		assert.ok(runner.calls.every((c) => c.options?.cwd === "/kb"), "每条命令都必须带 cwd");
	});

	it("现代 git（≥2.28）：init -b 一步到位", async () => {
		const runner = new RecordingRunner();
		await new GitCompat(runner, "/kb", capsFor("2.39.5")).initOn("main");
		assert.deepStrictEqual(runner.argvs(), [["git", "init", "-b", "main"]]);
	});

	it("★ el7：脏树 pull 用 stash/pull/pop（无 --autostash）", async () => {
		const runner = new RecordingRunner([{ stdout: " M entry.md\n" }, {}, { stdout: "" }, {}]);
		const msg = await new GitCompat(runner, "/kb", capsFor("1.8.3.1")).pullRebase("origin", "main");
		const argvs = runner.argvs().map((a) => a.join(" "));
		assert.ok(argvs[0]?.startsWith("git status --porcelain"), argvs.join(" | "));
		assert.ok(argvs.some((a) => a.startsWith("git stash push")), "脏树应先 stash");
		assert.ok(argvs.some((a) => a === "git pull --rebase origin main"), "再 pull --rebase");
		assert.ok(argvs.some((a) => a === "git stash pop"), "最后恢复工作树");
		assert.ok(!argvs.some((a) => a.includes("--autostash")), "不得使用 --autostash");
		assert.ok(msg.includes("手工 stash/pop"));
	});

	it("现代 git：pull --rebase --autostash 一步到位", async () => {
		const runner = new RecordingRunner();
		await new GitCompat(runner, "/kb", capsFor("2.39.5")).pullRebase("origin", "main");
		assert.deepStrictEqual(runner.argvs(), [["git", "pull", "--rebase", "--autostash", "origin", "main"]]);
	});

	it("push：只推实例分支的 refspec，永不出现 main", async () => {
		const runner = new RecordingRunner();
		await new GitCompat(runner, "/kb", capsFor("1.8.3.1")).push("origin", "instance/dev-01");
		assert.deepStrictEqual(runner.argvs(), [["git", "push", "-u", "origin", "HEAD:refs/heads/instance/dev-01"]]);
	});
});

describe("GitCompat：真实 git 端到端（本地裸仓当远端，无网络）", () => {
	const hasGit = (() => {
		try {
			return fs.existsSync("/usr/bin/git") || fs.existsSync("/bin/git") || fs.existsSync("/usr/local/bin/git");
		} catch {
			return false;
		}
	})();
	const SKIP = hasGit ? false : "环境无 git 二进制";

	/** 建一个临时「远端」裸仓 + 工作目录 */
	function fixture(): { bare: string; work: string; cleanup: () => void } {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-git-"));
		const bare = path.join(base, "origin.git");
		const work = path.join(base, "kb");
		fs.mkdirSync(bare, { recursive: true });
		fs.mkdirSync(work, { recursive: true });
		return { bare, work, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
	}

	/** 用真实 git 初始化裸仓（--initial-branch 在 2.28+，测试环境为现代 git） */
	async function initBare(shell: ShellExec, bare: string): Promise<void> {
		await shell.exec(["git", "init", "--bare", "--initial-branch=main", bare], { timeoutMs: 30_000 });
	}

	it("★ 强制 el7 能力（真 git + 退化分支）：init/symbolic-ref → 提交 → 推实例分支 → 拉取", { skip: SKIP }, async () => {
		const shell = new ShellExec();
		const { bare, work, cleanup } = fixture();
		try {
			await initBare(shell, bare);
			// 强制走老 git 分支（caps 声明 1.8.3.1）——真实 git 执行，验证退化路径可用
			const g = new GitCompat(shell, work, capsFor("1.8.3.1"), { GIT_TERMINAL_PROMPT: "0" });
			await g.initOn("main");
			await g.ensureRemote(bare);
			fs.writeFileSync(path.join(work, "entry.md"), "# 条目\n内容\n");
			const committed = await g.commitAll("kb: test entry");
			assert.ok(committed !== undefined, "应有提交");
			const push = await g.push("origin", "instance/dev-01");
			assert.ok(push.includes("✓"), push);

			// 远端应存在实例分支，且 main 未被实例推送
			const branches = await shell.exec(["git", "--git-dir", bare, "branch", "--list", "--format=%(refname:short)"], { timeoutMs: 30_000 });
			assert.ok(branches.stdout.includes("instance/dev-01"), branches.stdout);
			assert.ok(!branches.stdout.includes("main"), `实例不得推 main：${branches.stdout}`);

			// 远端内容可达：从裸仓读出提交内容
			const show = await shell.exec(["git", "--git-dir", bare, "show", "instance/dev-01:entry.md"], { timeoutMs: 30_000 });
			assert.ok(show.stdout.includes("条目"), show.stdout);
		} finally {
			cleanup();
		}
	});

	it("现代能力路径：init -b + autostash 真跑一遍（确保退化分支未破坏主路径）", { skip: SKIP }, async () => {
		const shell = new ShellExec();
		const { bare, work, cleanup } = fixture();
		try {
			await initBare(shell, bare);
			const caps = await detectGitCaps(shell);
			assert.ok(caps !== undefined, "应探测到 git 能力");
			const g = new GitCompat(shell, work, caps, { GIT_TERMINAL_PROMPT: "0" });
			await g.initOn("main");
			await g.ensureRemote(bare);
			fs.writeFileSync(path.join(work, "a.md"), "x\n");
			await g.commitAll("kb: a");
			assert.ok((await g.push("origin", "instance/dev-02")).includes("✓"));
			// 远端为空时 pull 应被识别（而非抛错）
			const pull = await g.pullRebase("origin", "instances-missing");
			assert.ok(pull.includes("远端为空") || pull.includes("跳过"), pull);
		} finally {
			cleanup();
		}
	});
});
