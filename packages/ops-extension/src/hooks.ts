import { assertToolRegistryIntegrity, onToolCall } from "./guards.ts";
import { assertPlatformAtSessionStart } from "./platform.ts";
import { buildomoSystemPrompt } from "./commands.ts";
import { probeBwrap } from "./sandbox.ts";
import { LOCAL_HOST } from "@ops-pi/core";
import { recordAudit } from "./audit-sink.ts";
import { healthProbeScript } from "./tools/read-only.ts";
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

		// ④¼ 独立审计可写性探测（写失败不阻断业务，但必须可发现）
		// 注意：AuditLog.lastError 采用「只记不清」语义（成功写入不抹除历史失败），
		// 因此本探测成功不会掩盖此前真实的写入失败；失败时则如实记入并告警。
		const probe = ctx.audit.append({ tool: "session_start", host: LOCAL_HOST, isError: false, ts: new Date().toISOString(), authz: "read" });
		if (probe === undefined) {
			sessionCtx.ui.notify(`omo：独立审计文件不可写（${ctx.audit.path}）：${ctx.audit.lastError ?? "未知错误"}——本次运行仅有会话内审计`, "warning");
		}

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
			// 重入保护：单轮执行耗时可能超过间隔（远端健康检查 30s 超时而间隔更短时），
			// 无保护会并发叠加巡检并放大负载（审查 5.5）。异常一并捕获——
			// 未处理的 Promise rejection 会终止宿主事件循环，属隐性可用性风险。
			let polling = false;
			sessionCtx.setInterval(async () => {
				if (polling) return;
				polling = true;
				try {
					const report = await ctx.shell.exec(
						["sh", "-c", healthProbeScript("slim")],
						{ timeoutMs: 30_000 },
					);
					recordAudit(pi, ctx, {
						tool: "ops_health_poll(auto)",
						host: LOCAL_HOST,
						isError: report.exitCode !== 0,
						ts: new Date().toISOString(),
						authz: "read",
					});
					if (report.exitCode === 0) {
						pi.sendUserMessage(`[自动巡检] ${report.stdout}`, { deliverAs: "followUp" });
					}
				} catch (error) {
					// 巡检失败不影响会话；记审计让中断可发现
					recordAudit(pi, ctx, {
						tool: "ops_health_poll(auto)",
						host: LOCAL_HOST,
						isError: true,
						ts: new Date().toISOString(),
						authz: "read",
						reasonClass: "EXEC_FAILED",
						reason: String((error as Error)?.message ?? error),
					});
				} finally {
					polling = false;
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

		recordAudit(pi, ctx, {
			tool: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			ts: new Date().toISOString(),
			// authz 来源由 assertAuthorized 返回值落 details（read|policy|token）；被拒调用记 blocked
			authz: (details?.authz as string) ?? (event.isError ? "blocked" : "unknown"),
			host: typeof details?.host === "string" ? details.host : undefined,
			reasonClass: reason?.startsWith("[ERR_PERMISSION]") ? "ERR_PERMISSION"
				: reason?.startsWith("[ERR_POLICY]") ? "ERR_POLICY"
				: undefined,
			reason: reason ?? undefined,
		});
	});
}
