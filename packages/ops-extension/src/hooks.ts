import { assertToolRegistryIntegrity, onToolCall } from "./guards.ts";
import { assertPlatformAtSessionStart } from "./platform.ts";
import { buildOpsPiSystemPrompt } from "./commands.ts";
import type { OpsContext } from "./context.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function setupHooks(pi: ExtensionAPI, ctx: OpsContext): void {
	// ── session_start ──
	pi.on("session_start", async (_event, sessionCtx) => {
		// ① 平台 ctx 侧能力校验（X15）
		assertPlatformAtSessionStart(sessionCtx);

		// ② 工具清单断言（O11/X15）
		assertToolRegistryIntegrity(pi);

		// ③ 降级可发现性（§7.4.3）
		if (!ctx.targetPolicy.isConfigured) {
			sessionCtx.ui.notify("ops-pi：未配置目标策略（.ops-pi/policy.json）——变更类操作一律拒绝", "warning");
		}
		if (process.env.OPS_PI_SANDBOX !== "1") {
			sessionCtx.ui.notify("ops-pi：未检测到沙箱——运行于进程级隔离（§7.1）", "warning");
		}

		// ④ 品牌标识
		// 品牌标识：omp TUI 由宿主控制，ops-pi 通过 notify 展示身份
		sessionCtx.ui.notify("OpsPi 运维智能体已加载", "info");

		// ⑤ 巡检轮询（受管定时器，session_shutdown 自动清理）
		if (ctx.config?.health?.autoPollIntervalMs) {
			sessionCtx.setInterval(async () => {
				const report = await ctx.shell.exec(
					["sh", "-c", "uptime && free -h | head -3 && df -h / | tail -1"],
					{ timeoutMs: 30_000 },
				);
				if (report.exitCode === 0) {
					pi.sendUserMessage(`[自动巡检] ${report.stdout}`, { deliverAs: "followUp" });
				}
			}, ctx.config.health.autoPollIntervalMs);
		}
	});

	// ── before_agent_start：OpsPi 身份注入（覆盖 omp 编码助手身份）──
	pi.on("before_agent_start", async (event) => {
		const opsPrompt = buildOpsPiSystemPrompt(ctx);
		const base = Array.isArray(event.systemPrompt)
			? event.systemPrompt.join("\n\n")
			: String(event.systemPrompt ?? "");
		// ★ 前插 OpsPi 身份（优先级高于 AGENTS.md 等全局上下文文件）
		return { systemPrompt: `${opsPrompt}\n\n${base}` };
	});

	// ── tool_call：①-b 兜底 + ② 内容硬拒（同步、模式无关）──
	pi.on("tool_call", async (event, sessionCtx) => {
		if (!event.toolName.startsWith("ops_")) return;
		return onToolCall(event, ctx.authzView, { hasUI: sessionCtx.hasUI });
	});

	// ── tool_execution_end：审计（R-4：被阻断调用只有此事件）──
	pi.on("tool_execution_end", async (event) => {
		if (!event.toolName.startsWith("ops_")) return;
		const result = event.result as Record<string, unknown> | undefined;
		const contentArr = result?.content as Array<{ text?: string }> | undefined;
		const reason = event.isError && Array.isArray(contentArr) ? contentArr[0]?.text : undefined;
		const details = result?.details as Record<string, unknown> | undefined;

		pi.appendEntry("ops_audit", {
			tool: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			ts: new Date().toISOString(),
			authz: (details?.authz as string) ?? (event.isError ? "blocked" : "unknown"),
			reasonClass: reason?.startsWith("[ERR_PERMISSION]") ? "ERR_PERMISSION"
				: reason?.startsWith("[ERR_POLICY]") ? "ERR_POLICY"
				: undefined,
			reason: reason ?? undefined,
		});
	});
}
