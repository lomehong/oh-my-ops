import { ShellExec } from "@ops-pi/core";
import { rmTempSync } from "./tmp-cleanup.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * git 测试夹具（Windows 跨平台性）。
 *
 * 背景：Windows 上**任何**新进程的创建都要 1.3–2.5 秒（Defender 实时扫描 + DLL 加载）。
 * 实测 `node -e "0"` 同样耗时 ⇒ 与 git 内部逻辑无关；GIT_OPTIONAL_LOCKS / 隔离 HOME /
 * core.fsmonitor 等开关最多省 10%，git 侧无优化空间。而 kb-sync 每个用例要 spawn
 * 20–30 次 git（init/clone/config×2/add/commit/push…），累计必然突破 bun 默认的
 * 60s 用例超时——表现为「用例超时失败」而**断言其实全绿**，属纯环境性假红。
 *
 * 本夹具从两个方向削减 spawn / 放宽超时，**均不放宽任何断言**：
 *  1. 不再跑两次 `git config user.email` + `user.name`（Windows 上约 3 秒），
 *     改为在夹具的 git() 出口统一注入 git 的 GIT_AUTHOR / GIT_COMMITTER 系列
 *     环境变量——**0 次 spawn**，且更贴近真实语义（测试要的是「提交有身份」，
 *     不是「仓库配置了什么」）。实测提交作者正确写入。
 *  2. 超时按平台区分：Windows 放宽到能覆盖进程创建开销，POSIX 保持原值——
 *     避免「为迁就慢环境而让快环境的挂死也被放过」。
 *
 * 已排除的方案（实测无效或不可行，勿再尝试）：
 *  - `git config a b c d` 一次写多键 → 实测报 "no action specified"（需 --add/--replace-all）
 *  - `git config -f -` 从 stdin 写 → 实测 "writing to stdin is not supported"
 *  - 手写 `.git/config` → 可行但脆弱，依赖 git 内部格式，不采用
 */

/** Windows 上进程创建成本远高于 POSIX，按平台区分超时 */
const WINDOWS = process.platform === "win32";

/** 单条 git 命令超时：POSIX 沿用 30s；Windows 需覆盖 spawn + Defender 开销 */
export const GIT_TIMEOUT_MS = WINDOWS ? 120_000 : 30_000;
/** 整组夹具操作超时（init+clone+commit+push 串行，spawn 次数最多） */
export const GIT_SETUP_TIMEOUT_MS = WINDOWS ? 300_000 : 120_000;

/** 提交身份：走环境变量注入，不spawn git config */
const IDENTITY_ENV = {
	GIT_AUTHOR_NAME: "omo-test",
	GIT_AUTHOR_EMAIL: "omo-test@local",
	GIT_COMMITTER_NAME: "omo-test",
	GIT_COMMITTER_EMAIL: "omo-test@local",
} as const;

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GitFixture {
	/** 带身份注入与平台感知超时的 git 执行出口 */
	git(args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult>;
	/** 同上但不抛错（用于断言非零退出码的路径） */
	gitAllowFail(args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult>;
	/** 建裸仓（-b 指定初始分支，兼容 git <2.28） */
	initBare(target: string, branch?: string): Promise<void>;
	clone(from: string, to: string): Promise<void>;
	/** 裸仓 → 首次提交并推到 main，返回 seed 的 clone 路径（已登记清理） */
	seedWithMain(remote: string): Promise<string>;
	/** add -A + commit（身份由环境注入，无需 config） */
	commitAll(repo: string, message: string): Promise<void>;
	/** 建一个已登记清理的临时目录 */
	tmpDir(prefix?: string): string;
	cleanup(): void;
}

export function gitFixture(label = "omo-git"): GitFixture {
	const shell = new ShellExec();
	const roots: string[] = [];

	const track = (p: string): string => {
		roots.push(p);
		return p;
	};

	const raw = async (
		args: readonly string[],
		opts?: { cwd?: string; timeoutMs?: number },
	): Promise<GitResult> =>
		await shell.exec(["git", ...args], {
			// ★ 身份注入：替代原先两次 `git config user.email/user.name`（Windows 上 3 秒）
			env: { ...IDENTITY_ENV },
			...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
			timeoutMs: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
		});

	const must = async (args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GitResult> => {
		const r = await raw(args, opts);
		if (r.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} 失败（exit=${r.exitCode}）：${(r.stderr || r.stdout).slice(0, 300)}`);
		}
		return r;
	};

	return {
		git: must,
		gitAllowFail: raw,

		async initBare(target, branch = "main") {
			// 用 `-b` 而非 `--initial-branch`：后者需 git ≥2.28，`-b` 更早且等价
			await must(["init", "--bare", "-b", branch, target], { timeoutMs: GIT_SETUP_TIMEOUT_MS });
		},

		async clone(from, to) {
			await must(["clone", from, to], { timeoutMs: GIT_SETUP_TIMEOUT_MS });
		},

		async seedWithMain(remote) {
			const seed = track(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-seed-`)));
			await must(["clone", remote, seed], { timeoutMs: GIT_SETUP_TIMEOUT_MS });
			// 空提交即可建立 main（身份来自环境注入）
			await must(["-C", seed, "commit", "--allow-empty", "-m", "seed"], { timeoutMs: GIT_TIMEOUT_MS });
			await must(["-C", seed, "push", "origin", "main"], { timeoutMs: GIT_SETUP_TIMEOUT_MS });
			return seed;
		},

		async commitAll(repo, message) {
			await must(["-C", repo, "add", "-A"], { timeoutMs: GIT_TIMEOUT_MS });
			await must(["-C", repo, "commit", "-m", message], { timeoutMs: GIT_TIMEOUT_MS });
		},

		tmpDir(prefix = label) {
			return track(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
		},

		cleanup() {
			for (const p of roots) rmTempSync(p);
		},
	};
}
