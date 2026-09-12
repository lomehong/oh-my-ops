import { assertToolRegistryIntegrity, onToolCall } from "./guards.ts";
import { assertPlatformAtSessionStart } from "./platform.ts";
import type { OpsContext } from "./context.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * P0 钩子装配（方案 §7.4 / §7.4.5 / §5 Contract ②⑤）。
 * —— session_start：平台 ctx 侧能力校验（X15）→ 工具清单断言（O11/X15）→ 沙箱降级提示（§7.4.3）
 * —— tool_call：② 内容硬拒 + ①-b 无人值守兜底（均同步、模式无关，O6/X10）
 * —— tool_execution_end：审计（R-4：被阻断调用只有该事件；N-4/RR-3：原因从结果文本提取，X23）
 */
export function setupHooks(pi: ExtensionAPI, ctx: OpsContext, uiState: { hasUI: boolean }): void {
	pi.on("session_start", async (_event, sessionCtx) => {
		assertPlatformAtSessionStart(sessionCtx);
		assertToolRegistryIntegrity(pi);

		// §7.4.3 降级可发现：策略未配置 = 变更类操作全拒（P0 为全拒基线）
		if (!ctx.targetPolicy.isConfigured) {
			sessionCtx.ui.notify("ops-pi：未配置目标策略（.ops-pi/policy.json）——变更类操作一律拒绝", "warning");
		}
		// §7.4.3 降级可发现：沙箱未检测到（P0 以环境标记判定）
		if (process.env.OPS_PI_SANDBOX !== "1") {
			sessionCtx.ui.notify("ops-pi：未检测到沙箱——运行于进程级隔离（§7.1），路径边界无额外限制", "warning");
		}
	});

	pi.on("tool_call", async (event, sessionCtx) => {
		uiState.hasUI = sessionCtx.hasUI; // 同步兜底层所需的交互态（X10）
		return onToolCall(event, ctx, uiState);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!event.toolName.startsWith("ops_")) return;
		const reason = reasonText(event.result);
		pi.appendEntry("ops_audit", {
			tool: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			ts: new Date().toISOString(),
			authz: ctx.lastAuthzSource(),
			reasonClass: reason === undefined ? undefined : reasonClass(reason),
			reason,
		});
	});
}

/** 拒绝原因提取（X23：结果文本携带宿主/钩子拒绝原因） */
function reasonText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
	const content: unknown = result.content;
	if (!Array.isArray(content)) return undefined;
	const first: unknown = content[0];
	if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
	const text: unknown = first.text;
	return typeof text === "string" && text !== "" ? text : undefined;
}

function reasonClass(reason: string): string | undefined {
	if (reason.startsWith("[ERR_PERMISSION]")) return "ERR_PERMISSION";
	if (reason.startsWith("[ERR_POLICY]")) return "ERR_POLICY";
	if (reason.includes("is blocked by tool policy")) return "host-policy";
	return undefined;
}
