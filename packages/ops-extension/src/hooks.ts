import { assertToolRegistryIntegrity, onToolCall } from "./guards.ts";
import { assertPlatformAtSessionStart } from "./platform.ts";
import { buildomoSystemPrompt } from "./commands.ts";
import { probeBwrap } from "./sandbox.ts";
import { LOCAL_HOST } from "@ops-pi/core";
import type { OpsContext } from "./context.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function setupHooks(pi: ExtensionAPI, ctx: OpsContext): void {
	// ── session_start ──
	pi.on("session_start", async (_event, sessionCtx) => {
		// ① 平台 ctx 侧能力校验（X15）
		assertPlatformAtSessionStart(sessionCtx);

		// ② 工具清单断言（O11/X15）——被共载扩展覆盖的 ops_ 工具先自愈（重注册 last-wins），复检失败才拒启
		const repaired = assertToolRegistryIntegrity(pi);
		if (repaired.length > 0) {
			sessionCtx.ui.notify(`omo：检测到 ${repaired.length} 个 ops_* 工具被共载扩展覆盖，已重新注册自愈（${repaired.join(", ")}）`, "warning");
		}

		// ③ 降级可发现性（§7.4.3）
		if (!ctx.targetPolicy.isConfigured) {
			sessionCtx.ui.notify(`omo：未配置目标策略（${ctx.config.policyPath}）——变更类操作一律拒绝`, "warning");
		}
		if (process.env.OPS_PI_SANDBOX === "1") {
			sessionCtx.ui.notify(probeBwrap() ? "omo：沙箱已启用（bubblewrap）" : "omo：沙箱已启用但 bwrap 不可用——本地 shell 命令将被 fail-closed 拒绝", probeBwrap() ? "info" : "warning");
		} else {
			sessionCtx.ui.notify("omo：沙箱未启用——运行于进程级隔离（§7.1）", "warning");
		}

		// ④ 品牌标识
		// 品牌标识：omp TUI 由宿主控制，ops-pi 通过 notify 展示身份
		sessionCtx.ui.notify("omo 运维智能体已加载", "info");

		// ④½ vault 解锁（口令仅来自环境变量 OPS_VAULT_PASSPHRASE，§7.7）
		if (ctx.vault && process.env.OPS_VAULT_PASSPHRASE) {
			const okUnlock = ctx.vault.unlock(process.env.OPS_VAULT_PASSPHRASE);
			sessionCtx.ui.notify(
				okUnlock ? "vault 已解锁（OPS_VAULT_PASSPHRASE）" : "vault 解锁失败（OPS_VAULT_PASSPHRASE 口令错误）",
				okUnlock ? "info" : "warning",
			);
		}

		// ⑤ 巡检轮询（受管定时器，session_shutdown 自动清理）
		// 说明：命令为硬编码只读本地探针，不经 LLM、不经审批流；仍落审计条目保证可发现性。
		if (ctx.config?.health?.autoPollIntervalMs) {
			sessionCtx.setInterval(async () => {
				const report = await ctx.shell.exec(
					["sh", "-c", "uptime && free -h | head -3 && df -h / | tail -1"],
					{ timeoutMs: 30_000 },
				);
				pi.appendEntry("ops_audit", {
					tool: "ops_health_poll(auto)",
					host: LOCAL_HOST,
					isError: report.exitCode !== 0,
					ts: new Date().toISOString(),
					authz: "read",
				});
				if (report.exitCode === 0) {
					pi.sendUserMessage(`[自动巡检] ${report.stdout}`, { deliverAs: "followUp" });
				}
			}, ctx.config.health.autoPollIntervalMs);
		}
	});

	// ── before_agent_start：omo 身份注入（覆盖 omp 编码助手身份）──
	pi.on("before_agent_start", async (event) => {
		const opsPrompt = buildomoSystemPrompt(ctx);
		const base = Array.isArray(event.systemPrompt)
			? event.systemPrompt.join("\n\n")
			: String(event.systemPrompt ?? "");
		// ★ 前插 omo 身份（优先级高于 AGENTS.md 等全局上下文文件）
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
			// authz 来源由 assertAuthorized 返回值落 details（read|policy|token）；被拒调用记 blocked
			authz: (details?.authz as string) ?? (event.isError ? "blocked" : "unknown"),
			reasonClass: reason?.startsWith("[ERR_PERMISSION]") ? "ERR_PERMISSION"
				: reason?.startsWith("[ERR_POLICY]") ? "ERR_POLICY"
				: undefined,
			reason: reason ?? undefined,
		});
	});
}
