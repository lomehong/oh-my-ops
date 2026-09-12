import type { PolicyRequest, TargetPolicy } from "./policy.ts";
import type { TokenStore } from "./tokens.ts";

export type Tier = "read" | "write" | "exec";
export const READ: Tier = "read";
export const WRITE: Tier = "write";
export const EXEC: Tier = "exec";

/** 宿主 ToolApprovalDecision 的结构化子集（避免依赖宿主类型：ToolApproval 未从包根导出） */
export type ApprovalDecision =
	| Tier
	| {
			tier: Tier;
			reason?: string;
			override?: boolean;
			policy?: "allow" | "deny" | "prompt";
			policyKey?: string;
	  };

/** 参数多态档位：同一工具按 action 返档（方案 §7.4.1） */
export function byAction(readonlyActions: readonly string[], readKey = "action"): (args: unknown) => Tier {
	return (args) => {
		const value = (args as Record<string, unknown> | null)?.[readKey];
		return typeof value === "string" && readonlyActions.includes(value) ? READ : EXEC;
	};
}

/** §7.4.1 档位表：工具名 → 档位或按参数返档。P0 仅需 read 档；表随 P1/P2 扩充。 */
export function tierOf(toolName: string, args: unknown, table: Readonly<Record<string, Tier | ((args: unknown) => Tier)>>): Tier {
	const entry = table[toolName];
	if (entry === undefined) return EXEC; // 未登记的 ops_* 工具按最严档处理
	return typeof entry === "function" ? entry(args) : entry;
}

/** ①-b 判定：非 read 档在无人值守下需要 Owner 预授权（方案 §7.4 ①-b） */
export function needsOwnerAuth(toolName: string, args: unknown, table: Readonly<Record<string, Tier | ((args: unknown) => Tier)>>): boolean {
	return tierOf(toolName, args, table) !== READ;
}

/**
 * 高危工具授权判定（方案 §7.4.2，§7.4.4 规范 1/2）。
 * ★ 纯函数：宿主一次调用会求值 3 次（X21），不得有副作用/令牌消耗——消费在 ③ execute 复核通过后进行。
 *  命中预授权/令牌 → { policy:"allow" } 任何模式放行
 *  生产目标        → { policy:"deny"  } 任何模式硬拒（X3/X8）
 *  其他            → { tier:"exec" }   交平台审批；无人值守由 ①-b 兜底拒绝
 */
export function createAuthorizedExec(policy: TargetPolicy, tokens: TokenStore): (args: unknown) => ApprovalDecision {
	return (args: unknown): ApprovalDecision => {
		const request = toPolicyRequest(args);
		if (request === null) return { tier: "exec" };
		const found = tokens.find(request);
		if (found.valid) return { tier: "exec", policy: "allow", reason: `Owner 批准令牌 ${found.token.id}` };
		if (policy.allows(request)) return { tier: "exec", policy: "allow", reason: `命中预授权 ${describeTarget(request)}` };
		if (policy.isProduction(request)) return { tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更" };
		return { tier: "exec" };
	};
}

export function toPolicyRequest(args: unknown): PolicyRequest | null {
	if (args === null || typeof args !== "object") return null;
	const record = args as Record<string, unknown>;
	const host = str(record.host);
	const service = str(record.service);
	const action = str(record.action);
	const command = str(record.command);
	if (host === undefined && service === undefined && action === undefined && command === undefined) return null;
	return { host, service, action, command };
}

function describeTarget(request: PolicyRequest): string {
	return [request.host, request.service].filter((x) => x !== undefined).join("/");
}
function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
