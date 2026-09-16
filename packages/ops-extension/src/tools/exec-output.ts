import type { ExecResult } from "@ops-pi/core";

/**
 * 统一命令输出回显（read/变更档工具共用）。
 *
 * 背景（2026-09-16 对端实测）：`ops_docker_ps` 在 docker daemon 不可达时回显 "(no containers)"——
 * 把「命令失败」显示成「零结果」，足以误导排障；同文件另有 3 种不同口径。
 *
 * 语义（2026-09-16 二轮修正：**成功但 stderr 非空同样要可见**——journalctl 权限提示、systemctl 警告
 * 等都在 exit=0 时走 stderr，丢弃会让使用者无法区分「真没输出」与「输出受限」）：
 * - `exitCode !== 0` → 回显 `exit=N` + stderr（stderr 空则退回 stdout），限 5 行防 usage 转储淹没上下文；
 * - `exitCode === 0` 且 stdout 非空 → stdout；stderr 非空时追加 `(stderr)` 段；
 * - `exitCode === 0` 且 stdout 为空 → stderr 非空则回显 stderr 段，否则用 emptyLabel 占位（默认 `(no output)`）。
 */
export function fmtExecResult(
	result: Pick<ExecResult, "stdout" | "stderr" | "exitCode">,
	emptyLabel = "(no output)",
): string {
	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();
	const head = (s: string): string => s.split("\n").slice(0, 5).join("\n").trim();
	if (result.exitCode !== 0) {
		const detail = stderr === "" ? stdout : stderr;
		const top = head(detail);
		return `exit=${result.exitCode}${top === "" ? "" : `\n${top}`}`;
	}
	if (stdout === "") return stderr === "" ? emptyLabel : `(stderr)\n${head(stderr)}`;
	return stderr === "" ? stdout : `${stdout}\n\n(stderr)\n${head(stderr)}`;
}
