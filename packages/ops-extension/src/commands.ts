import { LOCAL_HOST, normalizeTargetHost } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OpsContext } from "./context.ts";
import { buildCapabilityLists } from "./approvals.ts";
import { probeBwrap } from "./sandbox.ts";
import { formatAuditReport, parseAuditLimit, toAuditViews } from "./audit-view.ts";

/**
 * omo 系统提示词——在 `before_agent_start` 中注入。
 * 让 LLM 以运维智能体身份运行（而非通用编码助手），引导使用 ops_* 工具。
 * ★ 能力清单由 TIER_TABLE 生成（buildCapabilityLists）——提示词与注册表零漂移，
 *   不会再宣告未实现的工具（此前曾宣告 ops_ssh_*、ops_file_write、ops_vault_store、ops_process_kill）。
 */
export function buildomoSystemPrompt(ctx: OpsContext): string {
	const { read, write, exec } = buildCapabilityLists();
	const parts: string[] = [];

	parts.push("You are omo (运维智能体), an ops intelligence agent. This is your PRIMARY identity.");
	parts.push("You run inside oh-my-pi (omp) as the runtime host, but your role is ops intelligence — NOT a coding assistant, NOT an architect agent.");
	parts.push("Your capabilities: infrastructure inspection, service management, log analysis, Docker/K8s operations, incident response.");
	parts.push("You operate in Chinese (the user's language). Be concise, evidence-first, action-oriented.");
	parts.push("When the user asks 你是谁 or who you are, answer: 我是 omo 运维智能体，负责基础设施巡检、服务管理和事件响应。");
	parts.push("");

	parts.push("## Available capabilities");
	parts.push(`- Read-tier (auto-allowed): ${read.join(", ")}`);
	parts.push(`- Write-tier (needs Owner pre-auth): ${write.join(", ")}`);
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
		description: "对指定主机执行标准巡检（只读；留空/@local = 本机，远程主机经 SshPool）",
		handler: async (args, cmdCtx) => {
			const raw = String(args ?? "").trim().split(/\s+/)[0] ?? "";
			// P12：host 规范化（非法主机名在此诚实拒绝）；@local/留空 → 本机，真实主机名 → SshPool 远程探针
			let host: string;
			try {
				host = normalizeTargetHost(raw === "" || raw === LOCAL_HOST ? undefined : raw) ?? LOCAL_HOST;
			} catch (error) {
				cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const ops = ctx.forHost(host === LOCAL_HOST ? undefined : host);
			cmdCtx.ui.notify(`开始巡检（${host}）…`, "info");
			const commands = [
				"echo '=== CPU ===' && uptime",
				"echo '=== MEMORY ===' && free -h | head -3",
				"echo '=== DISK ===' && df -h / | tail -1",
				"echo '=== TOP ===' && ps aux --sort=-%cpu | head -6",
			].join(" && ");
			const result = await ops.shell.exec(["sh", "-c", commands], { timeoutMs: 30_000 });
			cmdCtx.ui.notify(`巡检完成（${host}）\n${result.stdout}`, result.exitCode === 0 ? "info" : "error");
			// 只读命令自落审计（命令路径不产生 tool_execution_end，§7.7）；host 记录真实目标
			pi.appendEntry("ops_audit", { tool: "ops-inspect", host, isError: result.exitCode !== 0, ts: new Date().toISOString(), authz: "read" });
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
				`沙箱：${process.env.OPS_PI_SANDBOX === "1" ? (probeBwrap() ? "✓ 已启用（bubblewrap）" : "✗ 已启用但 bwrap 不可用（本地 shell 将 fail-closed 拒绝）") : "⚠ 未启用（进程级隔离）"}`,
				`Vault：${ctx.config?.vault?.dbPath ? "✓ 已配置" : "✗ 未配置"}`,
			];
			cmdCtx.ui.notify(`omo 状态：\n${parts.join("\n")}`, "info");
		},
	});

	pi.registerCommand("ops-audit", {
		description: "回看当前会话分支最近 n 条 ops_audit 审计条目（只读；留空=20，上限 200）",
		handler: async (args, cmdCtx) => {
			const parsed = parseAuditLimit(args);
			// 自审计（B6/E2 先例）：命令路径不产生 tool_execution_end；先读后写——本次输出不含本条目
			const auditSelf = (isError: boolean) =>
				pi.appendEntry("ops_audit", { tool: "ops-audit", isError, ts: new Date().toISOString(), authz: "read" });
			if (!parsed.ok) {
				cmdCtx.ui.notify(parsed.reason, "error");
				auditSelf(true);
				return;
			}
			try {
				const branch = cmdCtx.sessionManager.getBranch();
				const views = toAuditViews(Array.isArray(branch) ? branch : []);
				cmdCtx.ui.notify(formatAuditReport(views, parsed.n, parsed.truncated), "info");
			} catch (error) {
				// fail-soft（方案 §4 异常行）：读取面任何异常显式提示，不崩会话
				const msg = error instanceof Error ? error.message : String(error);
				cmdCtx.ui.notify(`ops-audit 读取失败：${msg}`, "error");
				auditSelf(true);
				return;
			}
			auditSelf(false);
		},
	});

	// 危险场景（deploy / kill / rollback）不注册命令——改由 LLM 经 ops_* 工具执行（§7.7 规则）
}
