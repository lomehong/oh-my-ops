import { criticalReason, evaluateAuthorization, needsOwnerAuth, OpsError } from "@ops-pi/core";
import type { AuthzSource, AuthorizationVerdict, PolicyRequest, TargetPolicy, TokenStore } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { TIER_TABLE, requiresOwnerAuth, getRegisteredOpsToolDefs } from "./approvals.ts";
import { policyRequestFor } from "./request.ts";

export const RESERVED_TOOL_PREFIXES: readonly string[] = ["yuyi_", "yufu_"];

/** 授权判定视图：①-b 兜底层 / ③ execute 复核共用的最小接口 */
export interface AuthorizationView {
	/** 单一事实源判定（token → policy → production → none），无副作用 */
	evaluate(request: PolicyRequest): AuthorizationVerdict;
	/** 消费命中的批准令牌（单次批准语义）——只能在 ③ 复核通过后调用 */
	consume(request: PolicyRequest): void;
}

/** 便捷构造：给定 policy + tokens 的标准视图（OpsContext.authzView 内部同构） */
export function standardAuthzView(policy: TargetPolicy, tokens: TokenStore): AuthorizationView {
	return {
		evaluate: (request) => evaluateAuthorization(policy, tokens, request),
		consume: (request) => tokens.consume(request),
	};
}

export interface RegistryCheckReport {
	failures: string[];
	/** 被外部扩展覆盖（sourceInfo 指向本扩展之外）的 ops_ 工具——可经重注册自愈（O11 last-wins） */
	hijacked: string[];
}

/**
 * 工具清单检查（方案 §5 Contract ②③；session_start 触发，X15）。检查四项：
 *   ① TIER_TABLE 声明的工具全部在册
 *   ② 不在 TIER_TABLE 中的 ops_ 前缀工具 = 命名空间入侵
 *   ③ ops_ 工具的 sourceInfo 指向本扩展之外 = 被共载扩展覆盖（O11 last-wins 劫持）
 *   ④ yuyi_*、yufu_* 前缀与 ops_ 精确冲突
 */
export function checkToolRegistry(pi: ExtensionAPI): RegistryCheckReport {
	const tools = pi.getAllTools() as ReadonlyArray<{ name: string; sourceInfo?: { path?: string } }>;
	const failures: string[] = [];
	const hijacked: string[] = [];

	// ① TIER_TABLE 声明的工具全部在册
	for (const name of Object.keys(TIER_TABLE)) {
		let found = false;
		for (const tool of tools) { if (tool.name === name) { found = true; break; } }
		if (!found) failures.push(`  · ${name}：已在档位表声明但未注册`);
	}

	for (const tool of tools) {
		const isComm = RESERVED_TOOL_PREFIXES.some((prefix) => tool.name.startsWith(prefix));
		if (isComm && tool.name.startsWith("ops_")) failures.push(`  · ${tool.name}：ops_ 与通信前缀冲突`);
		if (!tool.name.startsWith("ops_")) continue;

		// ② 冒名的 ops_ 工具（不在 TIER_TABLE 中）
		if (!Object.hasOwn(TIER_TABLE, tool.name)) {
			failures.push(`  · ${tool.name}：冒名的 ops_ 工具`);
			continue;
		}
		// ③ 覆盖劫持检测：宿主提供了 sourceInfo 且明确指向本扩展之外 → 记为可自愈劫持。
		//    sourceInfo 缺失（部分宿主版本不填充）→ 无法判定，放行（不产生误报）。
		const source = tool.sourceInfo?.path;
		if (typeof source === "string" && source !== "" && !isOwnSourcePath(source)) {
			hijacked.push(tool.name);
			failures.push(`  · ${tool.name}：被外部扩展覆盖（${source}）`);
		}
	}

	return { failures, hijacked };
}

/** 本扩展源码路径特征：源码树（packages/ops-extension）与安装目录（~/.ops-pi）均含标识串 */
function isOwnSourcePath(path: string): boolean {
	return path.includes("ops-extension") || path.includes("ops-pi");
}

/**
 * 注册表自愈（O11：宿主重名 last-wins）。
 * 对被覆盖的 ops_ 工具按注册顺序**重新注册本扩展的定义**，使其成为 last-wins 的最后写入者。
 * 返回自愈成功的工具名；失败项由调用方复检兜底（throw 拒绝运行）。
 */
export function repairToolRegistry(pi: ExtensionAPI): string[] {
	const defs = getRegisteredOpsToolDefs();
	const { hijacked } = checkToolRegistry(pi);
	const repaired: string[] = [];
	for (const name of hijacked) {
		const def = defs.get(name);
		if (def === undefined) continue;
		try {
			pi.registerTool(def);
			repaired.push(name);
		} catch {
			// 自愈失败：留给复检报告
		}
	}
	return repaired;
}

/**
 * 工具清单断言（session_start 入口）：先检查 → 可自愈项自动修复 → 复检仍有失败即 throw 拒绝运行。
 */
export function assertToolRegistryIntegrity(pi: ExtensionAPI): string[] {
	const report = checkToolRegistry(pi);
	if (report.hijacked.length > 0) repairToolRegistry(pi);
	const after = checkToolRegistry(pi);
	if (after.failures.length > 0) {
		throw new Error(`[ops-pi] 工具清单断言失败：\n${after.failures.join("\n")}\n拒绝继续运行。`);
	}
	return after.hijacked; // 自愈成功的清单（供 session_start 通知）
}

/**
 * `tool_call` 钩子：①-b 无人值守兜底 + ② 内容硬拒。
 * ★ 只读判定不改写 event.input（§7.4.4 规范 2）；★ 同步不 await（O6 30s 上限）；
 * ★ 判定走 evaluateAuthorization 单一事实源，与审批层/③ 复核逐字段一致。
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

	// ①-b 无人值守兜底（含令牌放行：明示批准 > 默认拒绝，与审批层语义一致）
	if (!uiState.hasUI && requiresOwnerAuth(event.toolName, event.input)) {
		const verdict = authz.evaluate(policyRequestFor(event.toolName, event.input));
		if (!verdict.allowed) {
			return { block: true, reason: `[ERR_PERMISSION] ${verdict.reason ?? "guard-unattended"}` };
		}
	}
	return undefined;
}

/**
 * ③ execute 首行的权威校验（§7.4.4 规范 4，X19）。
 * @returns 授权来源（"read" | "policy" | "token"）——调用方须原样落 details.authz 供审计
 * @throws OpsError("POLICY_DENIED")（内容硬拒）或 OpsError("PERMISSION_DENIED")（未授权）
 */
export function assertAuthorized(toolName: string, input: unknown, authz: AuthorizationView): AuthzSource {
	// ② 内容硬拒在 ③ 同样成立（①-b 可能被绕过的最后一道闸）
	const command = readString(input, "command");
	if (command !== undefined) {
		const reason = criticalReason(command);
		if (reason !== null) throw new OpsError("POLICY_DENIED", reason);
	}

	// read 档免授权判定
	if (!requiresOwnerAuth(toolName, input)) return "read";

	// 单一事实源判定 + 令牌消费（仅在此处消费——approval 求值期间严禁副作用，X21 规范 3）
	const request = policyRequestFor(toolName, input);
	const verdict = authz.evaluate(request);
	if (verdict.allowed) {
		authz.consume(request);
		return verdict.source;
	}

	const detail = verdict.reason === "guard-production"
		? "生产目标禁止变更（如需放行须 Owner 签发批准令牌）"
		: "变更类操作未获预授权（policy.json 白名单或 Owner 批准令牌）";
	throw new OpsError("PERMISSION_DENIED", `[ERR_PERMISSION] ${verdict.reason ?? "guard-unattended"}：${detail}`);
}

function readString(input: unknown, key: string): string | undefined {
	if (typeof input !== "object" || input === null || !(key in input)) return undefined;
	const value: unknown = (input as Record<string, unknown>)[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}
