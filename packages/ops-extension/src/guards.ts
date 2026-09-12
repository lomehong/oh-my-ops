import { criticalReason, needsOwnerAuth, OpsError } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TIER_TABLE, requiresOwnerAuth } from "./approvals.ts";
import type { PolicyRequest, TargetPolicy } from "@ops-pi/core";

/** 授权判定视图：①-b 兜底层 / ③ execute 复核共用的最小接口（接口隔离，便于测试桩） */
export interface AuthorizationView {
	targetPolicy: Pick<TargetPolicy, "isProduction" | "allows" | "check">;
	preauthorized(request: PolicyRequest): boolean;
}

export const RESERVED_TOOL_PREFIXES: readonly string[] = ["yuyi_", "yufu_"];

/**
 * 工具清单断言（方案 §5 Contract ②③；断言时机 = `session_start` 首次触发，X15）。
 * `ownMarker`：本扩展文件路径的特征子串，用于检测 ops_* 工具是否被共载扩展**静默覆盖**（O11 last-wins）。
 * 命中即 `throw`——性质为「检测 + 拒绝继续运行」；覆盖在断言前已定格，无法「阻止」（宿主已知限制，§6 第 9 项）。
 */
export function assertToolRegistryIntegrity(pi: ExtensionAPI, ownMarker: string): void {
	const tools = pi.getAllTools() as ReadonlyArray<ToolRegistryEntry>;
	const failures: string[] = [];

	// ① 本扩展应注册的工具全部在册，且归属未被覆盖（O11 last-wins 静默覆盖的检测）
	for (const name of Object.keys(TIER_TABLE)) {
		const info = tools.find((tool) => tool.name === name);
		if (info === undefined) {
			failures.push(`  · ${name}：已注册但不在工具清单中（被覆盖或注册失败）`);
			continue;
		}
		const origin = String(info.sourceInfo?.path ?? "");
		if (!origin.includes(ownMarker)) failures.push(`  · ${name}：被其他来源覆盖（origin=${origin}）`);
	}

	// ② 冒名的 ops_* 工具（非本扩展注册的 ops_ 前缀工具 = 命名空间入侵）
	for (const tool of tools) {
		if (!tool.name.startsWith("ops_")) continue;
		if (Object.hasOwn(TIER_TABLE, tool.name)) continue;
		const origin = String(tool.sourceInfo?.path ?? "");
		if (!origin.includes(ownMarker)) failures.push(`  · ${tool.name}：冒名的 ops_ 工具（origin=${origin}）`);
	}

	if (failures.length > 0) {
		throw new Error(`[ops-pi] 工具清单断言失败（共载覆盖为静默 last-wins，O11）：\n${failures.join("\n")}\n拒绝继续运行。`);
	}
}

interface ToolRegistryEntry {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

/**
 * `tool_call` 钩子：第 ①-b 层（无人值守兜底，模式无关）+ 第 ② 层（内容硬拒）。
 * ★ 只读判定，不改写 `event.input`（§7.4.4 规范 2）；★ 同步执行，不 await 交互（O6 30s 上限）。
 * 返回 `{block, reason}` 表示拦截；undefined 表示放行。
 */
export function onToolCall(
	event: { toolName: string; input: unknown },
	authz: AuthorizationView,
	uiState: { hasUI: boolean },
): { block: true; reason: string } | undefined {
	if (!event.toolName.startsWith("ops_")) return undefined;

	// ② 内容硬拒：灾难性命令（对含 command 字段的工具）
	const command = readString(event.input, "command");
	if (command !== undefined) {
		const reason = criticalReason(command);
		if (reason !== null) return { block: true, reason: `[ERR_POLICY] ${reason}` };
	}

	// ①-b 无人值守兜底：非 read 档且未预授权 → 拒绝（不读 approvalMode，yolo 下依然生效，X10）
	if (!uiState.hasUI && requiresOwnerAuth(event.toolName, event.input)) {
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

/**
 * 第 ③ 层：execute 首行的权威校验（§7.4.4 规范 4）。
 * execute 收到的就是**实际要执行的值**，故必须在此独立重算全部维度——不信任 approval 的判定结果（X19：仅 ③ 能拦住的场景已实证）。
 */
export function assertAuthorized(toolName: string, input: unknown, authz: AuthorizationView): void {
	const command = readString(input, "command");
	if (command !== undefined) {
		const reason = criticalReason(command);
		if (reason !== null) throw new OpsError("POLICY_DENIED", reason);
	}
	if (!needsOwnerAuth(toolName, input, TIER_TABLE)) return; // read 档无变更面

	const request = toRequest(input);
	authz.targetPolicy.check(request); // defaultDeny：未命中即抛 POLICY_DENIED
	if (!authz.preauthorized(request)) {
		throw new OpsError("PERMISSION_DENIED", "无人值守且未预授权（须 Owner 明示批准后方可执行）");
	}
}

function toRequest(input: unknown): { host?: string; service?: string; action?: string; command?: string } {
	return {
		host: readString(input, "host"),
		service: readString(input, "service"),
		action: readString(input, "action"),
		command: readString(input, "command"),
	};
}

function readString(input: unknown, key: string): string | undefined {
	const value = asRecord(input)?.[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
