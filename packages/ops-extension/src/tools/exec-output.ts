import type { ExecResult } from "@ops-pi/core";

/**
 * 统一命令输出回显（read/变更档工具共用）。
 *
 * 背景（2026-09-16 对端实测）：`ops_docker_ps` 在 docker daemon 不可达时回显 "(no containers)"——
 * 把「命令失败」显示成「零结果」，足以误导排障；同文件另有 3 种不同口径。
 *
 * 语义：
 * - `exitCode !== 0` → 回显 `exit=N` + stderr（stderr 空则退回 stdout），限 5 行防 usage 转储淹没上下文；
 * - `exitCode === 0` → 回显 stdout，空则用 emptyLabel 占位（默认 `(no output)`）。
 */
export function fmtExecResult(
	result: Pick<ExecResult, "stdout" | "stderr" | "exitCode">,
	emptyLabel = "(no output)",
): string {
	const stdout = (result.stdout ?? "").trim();
	if (result.exitCode !== 0) {
		const detail = (result.stderr ?? "").trim() || stdout;
		const head = detail.split("\n").slice(0, 5).join("\n").trim();
		return `exit=${result.exitCode}${head === "" ? "" : `\n${head}`}`;
	}
	return stdout === "" ? emptyLabel : stdout;
}
