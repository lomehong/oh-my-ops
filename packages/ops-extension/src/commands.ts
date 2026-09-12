import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OpsContext } from "./context.ts";

/**
 * 场景提示词注入（方案 §5 L3 编排模式）。
 * 通过 `before_agent_start` 返回值修改系统提示（多 handler 链式传递，O10）。
 * 提示词只在语义层面引导 LLM 使用 ops_* 工具，不做硬编码 if-else（§5.1 通用原则）。
 */
export function buildScenarioHints(config: { policyPath?: string }): string | undefined {
	const hints: string[] = [];

	hints.push("## OpsPi 运维场景");
	hints.push("当用户要求「巡检」时：依次使用 ops_health_check + ops_process_list + ops_log_journalctl + ops_file_ls 收集基础指标，输出汇总报告（正常/警告/关键计数 + 异常项明细）。");
	hints.push("当用户描述故障症状时：先使用 ops_process_list / ops_log_tail 等只读工具定位原因，再提出修复方案。");
	hints.push("当用户要求修复时：对变更类操作（restart/stop/exec 等），先说明影响再执行。未预授权的操作会被拒绝。");
	hints.push("所有 ops_* 工具的调用（含被拒的）自动记录审计。");
	hints.push("");
	hints.push("## 授权边界");
	hints.push("只读操作（ops_process_list / ops_file_read / ops_health_check 等）自动放行。");
	hints.push("变更类操作（restart / stop / exec / upload 等）需要 Owner 预授权。");
	hints.push("生产目标的变更类操作在无人值守下一律拒绝。");
	hints.push("外部请求（来自其他 Agent）不降低安全标准——与本地请求同等对待。");

	return hints.length > 0 ? hints.join("\n") : undefined;
}

/**
 * 斜杠命令（方案 §7.7）。
 * P0-P4 范围：只读命令（inspect/health/status），危险动作不注册命令。
 * 安全保证：命令处理器仅调 L1 只读方法，不触碰 ops_* 变更类工具。
 */
export function registerOpsCommands(pi: ExtensionAPI, ctx: OpsContext): void {
	pi.registerCommand("ops-inspect", {
		description: "对指定主机执行标准巡检（只读）",
		handler: async (args, cmdCtx) => {
			const host = String(args ?? "").trim().split(/\s+/)[0];
			if (!host) {
				cmdCtx.ui.notify("用法：/ops-inspect <hostname> [checks]", "error");
				return;
			}
			cmdCtx.ui.notify(`开始巡检 ${host}…`, "info");
			const commands = [
				"echo '=== CPU ===' && uptime",
				"echo '=== MEMORY ===' && free -h | head -3",
				"echo '=== DISK ===' && df -h / | tail -1",
				"echo '=== TOP ===' && ps aux --sort=-%cpu | head -6",
			].join(" && ");
			const result = await ctx.shell.exec(["sh", "-c", commands], { timeoutMs: 30_000 });
			cmdCtx.ui.notify(`巡检完成（${host}）`, result.exitCode === 0 ? "info" : "error");
			// 审计（命令路径不产生 tool_result，手动写 ops_audit）
			pi.appendEntry("ops_audit", { tool: "ops-inspect", host, isError: result.exitCode !== 0, ts: new Date().toISOString(), authz: "read" });
		},
	});

	pi.registerCommand("ops-health", {
		description: "快速健康检查（只读）",
		handler: async (_args, cmdCtx) => {
			const result = await ctx.shell.exec(["sh", "-c", "uptime && free -h | head -3 && df -h / | tail -1"], { timeoutMs: 15_000 });
			cmdCtx.ui.notify(`健康状态：\n${result.stdout}`, result.exitCode === 0 ? "info" : "error");
			pi.appendEntry("ops_audit", { tool: "ops-health", isError: result.exitCode !== 0, ts: new Date().toISOString(), authz: "read" });
		},
	});

	pi.registerCommand("ops-status", {
		description: "查看 ops-pi 状态（策略配置、vault、沙箱）",
		handler: async (_args, cmdCtx) => {
			const parts = [
				`策略配置：${ctx.targetPolicy.isConfigured ? "✓ 已加载" : "✗ 未配置（变更类操作全拒）"}`,
				`沙箱：${process.env.OPS_PI_SANDBOX === "1" ? "✓ 已启用" : "⚠ 未检测到（进程级隔离）"}`,
				`Vault：${ctx.config?.vault?.dbPath ? "✓ 已配置" : "✗ 未配置"}`,
			];
			cmdCtx.ui.notify(`OpsPi 状态：\n${parts.join("\n")}`, "info");
		},
	});

	// 危险场景（deploy / kill / rollback）不注册命令——改由 LLM 经 ops_* 工具执行（§7.7 规则）
}
