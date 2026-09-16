import { ShellExec, type ExecOptions } from "./exec.ts";
import type { Runner } from "./runner.ts";

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
	private readonly shell: Runner;
	constructor(shell: Runner = new ShellExec()) {
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
		// -H 强制每条匹配都带文件名前缀：部分 grep 实现（或环境差异）在单文件路径时不加前缀，
		// 会让下方解析锚到行内容里的 `:数字:` 产出错位数据（2026-09-16 对端实测）
		const argv = ["grep", "-rnH", "--include=*", pattern, ...paths];
		if (opts.maxCount !== undefined) argv.splice(3, 0, "-m", String(opts.maxCount));
		const result = await this.shell.exec(argv, { timeoutMs: 30_000, ...execOpts });
		const matches: GrepResult["matches"] = [];
		// 已知路径锚定：file 必须落在给定 paths（自身或其后代）之内，否则视为不可信
		const underGiven = (file: string): boolean =>
			paths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
		for (const line of result.stdout.split("\n")) {
			if (line === "") continue;
			const match = line.match(/^(.+?):(\d+):(.*)$/);
			if (match === null) continue;
			let file = match[1]!;
			let lineNo = Number.parseInt(match[2]!, 10);
			let text = match[3]!.trim();
			if (!underGiven(file)) {
				// 兜底：输出无文件名前缀（单路径且实现未加 -H）→ 首段是行号、其余是行内容
				const only = paths.length === 1 ? paths[0] : undefined;
				const plain = only === undefined ? null : line.match(/^(\d+):(.*)$/);
				if (plain === null) continue; // 无法锚定 → 丢弃（宁缺勿错，不产出貌似合理的错位数据）
				file = only!;
				lineNo = Number.parseInt(plain[1]!, 10);
				text = plain[2]!.trim();
			}
			matches.push({ file, line: lineNo, text });
		}
		return { matches, totalMatches: matches.length };
	}
}
