/**
 * 第②层：内容级硬拒（方案 §7.4）。
 * 纯同步判定——绝不 await 人工交互（避开宿主 tool_call 30s fail-closed 上限，O6）。
 * 模式集以宿主 CRITICAL_BASH_PATTERNS（bash.ts:178-225）为下界，并补绝对路径锚点降低误报。
 */
const CRITICAL_PATTERNS: readonly RegExp[] = [
	// 递归破坏：仅锚定绝对路径目标，避免误伤 `rm -rf ./dist` 这类合法清理
	/\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i,
	/\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
	/\bsudo\s+rm\b/i,
	/\bchmod\s+-R\s+[0-7]{3,4}\s+\//i,
	/\bchown\s+-R\s+\S+\s+\//i,
	// 磁盘/文件系统破坏
	/\bmkfs(?:\.[a-z0-9]+)?\b/i,
	/\bcryptsetup\b/i,
	/\bdd\s+if=.+of=\/dev\//i,
	/>\s*\/dev\/sd[a-z]/i,
	// 系统配置破坏
	/>\s*\/etc\/(?:passwd|shadow|sudoers|group)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers|group)\b/i,
	// 远程拉取即执行
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:ba|z|)sh\b/i,
	/(?:^|[\s;&|(])(?:ba|z|)sh\s+<\(\s*(?:curl|wget|fetch)\b/i,
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b/i,
	// 进程/主机控制（命令位锚定，避免 `npm run reboot-tests` 误报）
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,
	/\bkill\s+-9\s+1\b/,
	// 网络壳
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
] as const;

/** 命中灾难性命令模式时返回原因；否则返回 null。供 ①-b 兜底层与 ③ execute 复核共用。 */
export function criticalReason(command: string): string | null {
	for (const pattern of CRITICAL_PATTERNS) {
		if (pattern.test(command)) return `命中灾难性命令模式，已拒绝`;
	}
	return null;
}
