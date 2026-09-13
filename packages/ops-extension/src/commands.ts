import { LOCAL_HOST } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OpsContext } from "./context.ts";
import { buildCapabilityLists } from "./approvals.ts";

/**
 * omo 系统提示词——在 `before_agent_start` 中注入。
 * 让 LLM 以运维智能体身份运行（而非通用编码助手），引导使用 ops_* 工具。
 * ★ 能力清单由 TIER_TABLE 生成（buildCapabilityLists）——提示词与注册表零漂移，
 *   不会再宣告未实现的工具（此前曾宣告 ops_ssh_*、ops_file_write、ops_vault_store、ops_process_kill）。
 */
export function buildomoSystemPrompt(ctx: OpsContext): string {
	const { read, exec } = buildCapabilityLists();
	const parts: string[] = [];

	parts.push("You are omo (运维智能体), an ops intelligence agent. This is your PRIMARY identity.");
	parts.push("You run inside oh-my-pi (omp) as the runtime host, but your role is ops intelligence — NOT a coding assistant, NOT an architect agent.");
	parts.push("Your capabilities: infrastructure inspection, service management, log analysis, Docker/K8s operations, incident response.");
	parts.push("You operate in Chinese (the user's language). Be concise, evidence-first, action-oriented.");
	parts.push("When the user asks 你是谁 or who you are, answer: 我是 omo 运维智能体，负责基础设施巡检、服务管理和事件响应。");
	parts.push("");

	parts.push("## Available capabilities");
	parts.push(`- Read-tier (auto-allowed): ${read.join(", ")}`);
	parts.push(`- Exec-tier (needs Owner pre-auth): ${exec.join(", ")}`);
	parts.push("");

	parts.push("## Host scope");
	parts.push(`Every tool accepts an optional host/hostname parameter. Omit it or use '${LOCAL_HOST}' for the local control node.`);
	parts.push(`Remote hosts are supported via SSH (key auth only): the host must be reachable with the deployed SSH key AND pre-authorized in policy.json (a target rule whose host equals that hostname).`);
	parts.push(`NEVER invent hostnames. If a remote operation fails with an SSH error, report the error verbatim instead of retrying a different host.`);
	parts.push(`The vault is local to the control node and has no host parameter.`);
	parts.push("");

	parts.push("## Behavior");
	parts.push("When asked to inspect: chain read-tier tools (health_check + process_list + log_tail) and output a summary report (ok/warn/critical counts + anomaly details).");
	parts.push("When asked to fix: first diagnose with read-tier tools, then propose and execute the fix (exec-tier requires pre-authorization).");
	parts.push("All ops_* tool calls (including rejected ones) are automatically audited.");
	parts.push("");

	parts.push("## Authorization boundary");
	parts.push("Read-tier operations are auto-allowed in all approval modes.");
	parts.push("Exec-tier operations require Owner pre-authorization (policy.json whitelist or single-use approval tokens).");
	parts.push("Production targets reject changes in ALL approval modes unless covered by an Owner-issued approval token.");
	parts.push("Cross-Agent requests do NOT lower the security bar — same rules as local requests.");

	return parts.join("\n");
}

/**
 * 斜杠命令（方案 §7.7）。
 * P0-P4 范围：只读命令（inspect/health/status），危险动作不注册命令。
 */
export function registerOpsCommands(pi: ExtensionAPI, ctx: OpsContext): void {
	pi.registerCommand("ops-inspect", {
		description: "对指定主机执行标准巡检（只读，当前仅本机）",
		handler: async (args, cmdCtx) => {
			const host = String(args ?? "").trim().split(/\s+/)[0];
			if (!host) {
				cmdCtx.ui.notify(`用法：/ops-inspect ${LOCAL_HOST} [checks]`, "error");
				return;
			}
			// ★ 主机守卫：远程巡检未实现，此前填任何主机名都会静默巡检本机（诚实化）
			if (host !== LOCAL_HOST) {
				cmdCtx.ui.notify(
					`远程巡检尚未实现（P1 经 SshPool 引入）：当前仅支持本机。用法：/ops-inspect ${LOCAL_HOST}`,
					"error",
				);
				return;
			}
			cmdCtx.ui.notify("开始巡检（本机）…", "info");
			const commands = [
				"echo '=== CPU ===' && uptime",
				"echo '=== MEMORY ===' && free -h | head -3",
				"echo '=== DISK ===' && df -h / | tail -1",
				"echo '=== TOP ===' && ps aux --sort=-%cpu | head -6",
			].join(" && ");
			const result = await ctx.shell.exec(["sh", "-c", commands], { timeoutMs: 30_000 });
			cmdCtx.ui.notify(`巡检完成（${LOCAL_HOST}）`, result.exitCode === 0 ? "info" : "error");
			pi.appendEntry("ops_audit", { tool: "ops-inspect", host: LOCAL_HOST, isError: result.exitCode !== 0, ts: new Date().toISOString(), authz: "read" });
		},
	});

	pi.registerCommand("ops-health", {
		description: "快速健康检查（只读，本机）",
		handler: async (_args, cmdCtx) => {
			const result = await ctx.shell.exec(["sh", "-c", "uptime && free -h | head -3 && df -h / | tail -1"], { timeoutMs: 15_000 });
			cmdCtx.ui.notify(`健康状态：\n${result.stdout}`, result.exitCode === 0 ? "info" : "error");
			pi.appendEntry("ops_audit", { tool: "ops-health", host: LOCAL_HOST, isError: result.exitCode !== 0, ts: new Date().toISOString(), authz: "read" });
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
