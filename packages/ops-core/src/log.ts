import { ShellExec, type ExecOptions } from "./exec.ts";

export interface TailResult {
	file: string;
	lines: string[];
	totalLines: number;
}

export interface JournalctlResult {
	lines: string[];
	query: string;
}

export interface GrepResult {
	matches: Array<{ file: string; line: number; text: string }>;
	totalMatches: number;
}

/**
 * 日志采集（只读）：tail / journalctl / grep，通过 exec 远端/本地执行。
 * 设计 §3.8：日志类工具统一走 ShellExec，不依赖特定日志库。
 */
export class LogCollector {
	private readonly shell: ShellExec;
	constructor(shell: ShellExec = new ShellExec()) {
		this.shell = shell;
	}

	/** 读取日志文件末尾 N 行 */
	async tailFile(path: string, opts: { lines?: number }, execOpts: ExecOptions = {}): Promise<TailResult> {
		const n = opts.lines ?? 100;
		const result = await this.shell.exec(["tail", "-n", String(n), path], { timeoutMs: 15_000, ...execOpts });
		if (result.exitCode !== 0 && result.stderr.includes("No such file")) {
			return { file: path, lines: [], totalLines: 0 };
		}
		const lines = result.stdout.split("\n").filter((line) => line !== "");
		return { file: path, lines, totalLines: lines.length };
	}

	/** journalctl 查询 */
	async journalctl(opts: { unit?: string; since?: string; priority?: number; lines?: number }, execOpts: ExecOptions = {}): Promise<JournalctlResult> {
		const argv = ["journalctl", "--no-pager", "-q"];
		if (opts.unit !== undefined) argv.push("-u", opts.unit);
		if (opts.since !== undefined) argv.push("--since", opts.since);
		if (opts.priority !== undefined) argv.push("-p", String(opts.priority));
		if (opts.lines !== undefined) argv.push("-n", String(opts.lines));
		const result = await this.shell.exec(argv, { timeoutMs: 30_000, ...execOpts });
		return {
			lines: result.stdout.split("\n").filter((line) => line !== ""),
			query: argv.join(" "),
		};
	}

	/** 多文件 grep（正则） */
	async grep(pattern: string, paths: readonly string[], opts: { context?: number; maxCount?: number } = {}, execOpts: ExecOptions = {}): Promise<GrepResult> {
		const argv = ["grep", "-rn", "--include=*", pattern, ...paths];
		if (opts.maxCount !== undefined) argv.splice(3, 0, "-m", String(opts.maxCount));
		const result = await this.shell.exec(argv, { timeoutMs: 30_000, ...execOpts });
		const matches: GrepResult["matches"] = [];
		for (const line of result.stdout.split("\n")) {
			const match = line.match(/^(.+?):(\d+):(.+)$/);
			if (match !== null) {
				matches.push({ file: match[1]!, line: Number.parseInt(match[2]!, 10), text: match[3]!.trim() });
			}
		}
		return { matches, totalMatches: matches.length };
	}
}
