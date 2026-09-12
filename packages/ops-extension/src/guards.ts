import { EXEC, criticalReason, needsOwnerAuth, OpsError } from "@ops-pi/core";
import type { PolicyRequest, TargetPolicy } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TIER_TABLE, requiresOwnerAuth } from "./approvals.ts";

export const RESERVED_TOOL_PREFIXES: readonly string[] = ["yuyi_", "yufu_"];

/** 授权判定视图：①-b 兜底层 / ③ execute 复核共用的最小接口 */
export interface AuthorizationView {
	targetPolicy: Pick<TargetPolicy, "isProduction" | "allows" | "check">;
	preauthorized(request: PolicyRequest): boolean;
}

/**
 * 工具清单断言（方案 §5 Contract ②③；session_start 首次触发，X15）。
 * 检查三项：
 *   ① TIER_TABLE 声明的工具全部在册
 *   ② 不在 TIER_TABLE 中的 ops_ 前缀工具 = 命名空间入侵
 *   ③ yuyi_* 或 yufu_* 与 ops_* 精确重名
 * 命中即 throw——检测 + 拒绝继续运行；覆盖已定格无法阻止（宿主限制 §6 第 9 项）。
 */
export function assertToolRegistryIntegrity(pi: ExtensionAPI): void {
	const tools = pi.getAllTools() as ReadonlyArray<{ name: string }>;
	const failures: string[] = [];

	// ① TIER_TABLE 声明的工具全部在册
	for (const name of Object.keys(TIER_TABLE)) {
		let found = false;
		for (const tool of tools) { if (tool.name === name) { found = true; break; } }
		if (!found) failures.push(`  · ${name}：已在档位表声明但未注册`);
	}

	// ② 冒名的 ops_ 工具（不在 TIER_TABLE 中）
	for (const tool of tools) {
		if (tool.name.startsWith("ops_") && !Object.hasOwn(TIER_TABLE, tool.name)) {
			failures.push(`  · ${tool.name}：冒名的 ops_ 工具`);
		}
	}

	// ③ 通信工具精确重名
	for (const tool of tools) {
		const isComm = RESERVED_TOOL_PREFIXES.some((prefix) => tool.name.startsWith(prefix));
		if (isComm && tool.name.startsWith("ops_")) failures.push(`  · ${tool.name}：ops_ 与通信前缀冲突`);
	}

	if (failures.length > 0) {
		throw new Error(`[ops-pi] 工具清单断言失败：\n${failures.join("\n")}\n拒绝继续运行。`);
	}
}

/**
 * `tool_call` 钩子：①-b 无人值守兜底 + ② 内容硬拒。
 * ★ 只读判定不改写 event.input（§7.4.4 规范 2）；★ 同步不 await（O6 30s 上限）。
 */
export function onToolCall(
	event: { toolName: string; input: unknown },
	authz: AuthorizationView,
	uiState: { hasUI: boolean },
): { block: true; reason: string } | undefined {
	if (!event.toolName.startsWith("ops_")) return undefined;

	// ② 内容硬拒
	const command = readString(event.input, "command");
	if (command !== undefined) {
		const reason = criticalReason(command);
		if (reason !== null) return { block: true, reason: `[ERR_POLICY] ${reason}` };
	}

	// ①-b 无人值守兜底
	if (!uiState.hasUI && needsOwnerAuth(event.toolName, event.input, TIER_TABLE)) {
		const request = toRequest(event.input);
		const layer = authz.targetPolicy.isProduction(request)
			? "guard-production"
			: authz.preauthorized(request)
				? null
				: "guard-unattended";
		if (layer !== null) return { block: true, reason: `[ERR_PERMISSION] ${layer}` };
	}
	return undefined;
}

/** ③ execute 首行的权威校验（§7.4.4 规范 4，X19） */
export function assertAuthorized(toolName: string, input: unknown, authz: AuthorizationView): void {
	const command = readString(input, "command");
	if (command !== undefined) {
		const reason = criticalReason(command);
		if (reason !== null) throw new OpsError("POLICY_DENIED", reason);
	}
	if (!needsOwnerAuth(toolName, input, TIER_TABLE)) return;

	const request = toRequest(input);
	authz.targetPolicy.check(request);
	if (!authz.preauthorized(request)) {
		throw new OpsError("PERMISSION_DENIED", "无人值守且未预授权（须 Owner 明示批准后方可执行）");
	}
}

function toRequest(input: unknown): PolicyRequest {
	return {
		host: readString(input, "host"),
		service: readString(input, "service"),
		action: readString(input, "action"),
		command: readString(input, "command"),
	};
}
function readString(input: unknown, key: string): string | undefined {
	if (typeof input !== "object" || input === null || !(key in input)) return undefined;
	const value: unknown = (input as Record<string, unknown>)[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}
