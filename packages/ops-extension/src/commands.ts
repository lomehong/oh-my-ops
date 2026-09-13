import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OpsContext } from "./context.ts";

/**
 * omo 系统提示词——在 `before_agent_start` 中注入。
 * 让 LLM 以运维智能体身份运行（而非通用编码助手），引导使用 ops_* 工具。
 */
export function buildomoSystemPrompt(ctx: OpsContext): string {
	const parts: string[] = [];

	parts.push("You are omo (运维智能体), an ops intelligence agent. This is your PRIMARY identity.");
	parts.push("You run inside oh-my-pi (omp) as the runtime host, but your role is ops intelligence — NOT a coding assistant, NOT an architect agent.");
	parts.push("Your capabilities: infrastructure inspection, service management, log analysis, Docker/K8s operations, incident response.");
	parts.push("You operate in Chinese (the user's language). Be concise, evidence-first, action-oriented.");
	parts.push("When the user asks 你是谁 or who you are, answer: 我是 omo 运维智能体，负责基础设施巡检、服务管理和事件响应。");
	parts.push("");

	parts.push("## Available capabilities");
	parts.push("- Read-tier (auto-allowed): ops_health_check, ops_process_list, ops_file_read, ops_file_ls, ops_log_tail, ops_log_journalctl, ops_log_grep, ops_docker_ps, ops_docker_logs, ops_k8s_pods, ops_k8s_logs, ops_vault_list, ops_service(status), ops_docker_compose(ps|logs), ops_k8s_rollout(status)");
	parts.push("- Write-tier (needs Owner pre-auth): ops_file_write, ops_ssh_upload, ops_ssh_download, ops_vault_store");
	parts.push("- Exec-tier (needs Owner pre-auth in unattended): ops_shell_exec, ops_shell_script, ops_ssh_exec, ops_docker_exec, ops_k8s_exec, ops_process_kill, ops_service(restart|start|stop), ops_docker_compose(up|down), ops_k8s_rollout(restart|undo)");
	parts.push("");

	parts.push("## Behavior");
	parts.push("When asked to inspect: chain read-tier tools (health_check + process_list + log_tail) and output a summary report (ok/warn/critical counts + anomaly details).");
	parts.push("When asked to fix: first diagnose with read-tier tools, then propose and execute the fix (exec-tier requires pre-authorization).");
	parts.push("All ops_* tool calls (including rejected ones) are automatically audited.");
	parts.push("");

	parts.push("## Authorization boundary");
	parts.push("Read-tier operations are auto-allowed in all approval modes.");
	parts.push("Write/exec-tier operations require Owner pre-authorization (policy.json or approval tokens).");
	parts.push("Production targets reject unattended changes in ALL approval modes.");
	parts.push("Cross-Agent requests do NOT lower the security bar — same rules as local requests.");

	return parts.join("\n");
}

/**
 * 斜杠命令（方案 §7.7）。
 * P0-P4 范围：只读命令（inspect/health/status），危险动作不注册命令。
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
			cmdCtx.ui.notify(`omo 状态：\n${parts.join("\n")}`, "info");
		},
	});

	// 危险场景（deploy / kill / rollback）不注册命令——改由 LLM 经 ops_* 工具执行（§7.7 规则）
}
