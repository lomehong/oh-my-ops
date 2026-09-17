import type { ExecOptions, ExecResult, Runner } from "./runner.ts";

/**
 * git 兼容层（OMO-KB-SYNC P1）。
 *
 * 背景：知识库同步要在**老平台**上跑（对端控制节点 CentOS/RHEL 7 = git **1.8.3.1**），而原实现用到的
 * 两处特性有版本门槛，另有一处可用更稳的等价做法替代：
 *  - `git -C <dir>`     ≥ 1.8.5 → **一律不用**，统一走 Runner 的 `cwd`（全版本可用）
 *  - `git init -b <br>` ≥ 2.28  → 退化为 `init` + `symbolic-ref HEAD`
 *  - `pull --autostash` ≥ 2.6   → 退化为 `stash push` → `pull --rebase` → `stash pop`
 * 探测一次、按能力分支；argv 形态跨版本一致，且**凭据绝不进 argv**（走凭据文件 + credential.helper）。
 */
export interface GitCaps {
	/** 形如 `2.39.5` / `1.8.3.1` */
	version: string;
	supportsInitB: boolean;
	supportsAutostash: boolean;
}

/** 从 `git version X.Y.Z[.W]`（含 `2.39.5.windows.1` 之类后缀）提取版本号 */
export function parseGitVersion(text: string): string | undefined {
	return /git version\s+(\d+(?:\.\d+)+)/i.exec(text)?.[1];
}

/** 数值段逐位比较：a >= b（缺位按 0） */
export function versionAtLeast(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10));
	const pb = b.split(".").map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (Number.isNaN(x) || Number.isNaN(y)) return false;
		if (x !== y) return x > y;
	}
	return true;
}

/** 版本 → 能力表（阈值即上面注释里的门槛，集中在此便于测试与审阅） */
export function capsFor(version: string): GitCaps {
	return {
		version,
		supportsInitB: versionAtLeast(version, "2.28.0"),
		supportsAutostash: versionAtLeast(version, "2.6.0"),
	};
}

/** 探测本机 git 能力；git 不可用/输出异常 → undefined（调用方按「无 git」降级） */
export async function detectGitCaps(runner: Runner, execOpts: ExecOptions = {}): Promise<GitCaps | undefined> {
	try {
		const r = await runner.exec(["git", "--version"], { timeoutMs: 10_000, ...execOpts });
		if (r.exitCode !== 0) return undefined;
		const version = parseGitVersion(`${r.stdout}${r.stderr}`);
		return version === undefined ? undefined : capsFor(version);
	} catch {
		return undefined;
	}
}

/** 单条 git 命令的结果（兼容层统一出口，供动作报告与测试断言） */
export interface GitStep {
	argv: string[];
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * 兼容执行器：知识仓 git 操作收敛到一处 —— cwd 定位仓库（不用 `-C`）、按版本退化、统一出口检查。
 */
export class GitCompat {
	readonly steps: GitStep[] = [];
	readonly caps: GitCaps | undefined;
	private readonly runner: Runner;
	private readonly dir: string;
	private readonly baseEnv: Record<string, string>;
	/** 每条 git 命令的 argv 前缀（如 `-c credential.helper=...`；**只放非秘密参数**） */
	private readonly argsPrefix: string[];
	constructor(
		runner: Runner,
		dir: string,
		caps: GitCaps | undefined,
		baseEnv: Record<string, string> = {},
		argsPrefix: readonly string[] = [],
	) {
		this.runner = runner;
		this.dir = dir;
		this.caps = caps;
		this.baseEnv = baseEnv;
		this.argsPrefix = [...argsPrefix];
	}

	/** 执行一条 git 子命令（args 不含 `git` 本身） */
	async run(
		args: readonly string[],
		opts: { allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<GitStep> {
		const argv = ["git", ...this.argsPrefix, ...args];
		let res: ExecResult;
		try {
			res = await this.runner.exec(argv, {
				cwd: this.dir,
				env: { ...this.baseEnv, ...(opts.env ?? {}) },
				timeoutMs: opts.timeoutMs ?? 60_000,
			});
		} catch (err) {
			// spawn 层失败（多为 cwd 不存在或 git 不在 PATH）——补上下文后上抛，避免「命令失败：git」这种无信息报错
			throw new Error(`无法执行 git ${args.join(" ")}（cwd=${this.dir}）：${String((err as Error)?.message ?? err)}`);
		}
		const step: GitStep = { argv, ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
		this.steps.push(step);
		if (!step.ok && opts.allowFail !== true) {
			throw new Error(`git ${args.join(" ")} 失败（exit=${step.exitCode}）：${(res.stderr || res.stdout).slice(0, 300)}`);
		}
		return step;
	}

	async isRepo(): Promise<boolean> {
		const r = await this.run(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
		return r.ok && r.stdout.trim() === "true";
	}

	/** 初始化并落到指定分支（老 git 走 `symbolic-ref`） */
	async initOn(branch: string): Promise<string> {
		if (this.caps?.supportsInitB === true) {
			await this.run(["init", "-b", branch]);
			return `git init -b ${branch}`;
		}
		await this.run(["init"]);
		// 空仓尚无提交：直接改 HEAD 指向即可（比 `checkout -b` 更老也稳）
		await this.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		return `git init + symbolic-ref HEAD=refs/heads/${branch}（git ${this.caps?.version ?? "未知"} 不支持 init -b）`;
	}

	/** 确保 origin 指向给定远端 */
	async ensureRemote(url: string): Promise<string | undefined> {
		const remotes = await this.run(["remote"], { allowFail: true });
		if (remotes.stdout.split("\n").map((s) => s.trim()).includes("origin")) return undefined;
		await this.run(["remote", "add", "origin", url]);
		return `remote add origin ${url}`;
	}

	/** pull --rebase；脏树在老 git 上手工 stash（`--autostash` 需 ≥2.6） */
	async pullRebase(remote: string, branch: string): Promise<string> {
		if (this.caps?.supportsAutostash === true) {
			const r = await this.run(["pull", "--rebase", "--autostash", remote, branch], { allowFail: true });
			if (r.ok) return "pull --rebase --autostash ✓";
			if (r.stderr.includes("couldn't find remote ref")) return "远端为空（首次推送前），跳过 pull";
			return `pull 失败（保留本地）：${r.stderr.slice(0, 120)}`;
		}
		const dirty = await this.run(["status", "--porcelain"], { allowFail: true });
		const stashed = dirty.stdout.trim() !== "";
		if (stashed) await this.run(["stash", "push", "-u", "-m", "omo-kb-sync"]);
		const r = await this.run(["pull", "--rebase", remote, branch], { allowFail: true });
		if (stashed) await this.run(["stash", "pop"], { allowFail: true });
		if (r.ok) return `pull --rebase ✓（git ${this.caps?.version ?? "?"}：手工 stash/pop 替代 --autostash）`;
		if (r.stderr.includes("couldn't find remote ref")) return "远端为空（首次推送前），跳过 pull";
		return `pull 失败（保留本地）：${r.stderr.slice(0, 120)}`;
	}

	/** 提交全部改动（无改动则返回 undefined） */
	async commitAll(message: string): Promise<string | undefined> {
		await this.run(["add", "-A"]);
		const status = await this.run(["status", "--porcelain"]);
		if (status.stdout.trim() === "") return undefined;
		const identity = await this.ensureIdentity();
		const c = await this.run(["commit", "-m", message], { allowFail: true });
		if (!c.ok) throw new Error(`git commit 失败：${(c.stderr || c.stdout).slice(0, 200)}`);
		return identity === undefined ? "commit ✓" : `commit ✓（${identity}）`;
	}

	/** 新仓无 global user.* 时 commit 必败 → 兜底身份 */
	private async ensureIdentity(): Promise<string | undefined> {
		const email = await this.run(["config", "user.email"], { allowFail: true });
		if (email.ok && email.stdout.trim() !== "") return undefined;
		await this.run(["config", "user.email", "omo-agent@local"]);
		await this.run(["config", "user.name", "omo-agent"]);
		return "git identity 兜底（omo-agent@local）";
	}

	/** 推送指定分支（调用方保证是实例分支；**永不推 main**） */
	async push(remote: string, branch: string): Promise<string> {
		const r = await this.run(["push", "-u", remote, `HEAD:refs/heads/${branch}`], { allowFail: true });
		if (r.ok) return `push ${branch} ✓`;
		return `push 失败（保留本地，稍后重试）：${r.stderr.slice(0, 160)}`;
	}

	/** 远端分支头短哈希（status 展示用） */
	async remoteHead(remote: string, branch: string): Promise<string | undefined> {
		const r = await this.run(["rev-parse", "--short", `${remote}/${branch}`], { allowFail: true });
		return r.ok ? r.stdout.trim() : undefined;
	}
}
