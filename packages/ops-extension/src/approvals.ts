import { READ, EXEC, tierOf, needsOwnerAuth } from "@ops-pi/core";
import type { Tier } from "@ops-pi/core";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

/**
 * §7.4.1 完整档位表（决策 D4）。
 * P0 只读 2 条；P1 补齐 Shell/SSH/Process/File/Log + Health/Vault 列表；P2/P3 补 Docker/K8s（未实现）。
 */
export const TIER_TABLE: Readonly<Record<string, Tier | ((args: unknown) => Tier)>> = {
	// P0（只读）
	ops_file_read: READ,
	ops_process_list: READ,

	// P1 · read
	ops_file_ls: READ,
	ops_log_tail: READ,
	ops_log_journalctl: READ,
	ops_log_grep: READ,
	ops_health_check: READ,
	ops_health_poll: READ,
	ops_vault_list: READ,

	// P2 · action 多态
	ops_service: (args: unknown) => {
		const a = (args as Record<string, unknown> | null)?.action;
		return a === "status" ? READ : EXEC;
	},

	// P1 · exec
	ops_shell_exec: EXEC,
	ops_shell_script: EXEC,
	// P3 · Docker
	ops_docker_ps: READ,
	ops_docker_logs: READ,
	ops_docker_exec: EXEC,
	ops_docker_compose: (args: unknown) => {
		const a = (args as Record<string, unknown> | null)?.action;
		return a === "ps" || a === "logs" ? READ : EXEC;
	},

	// P3 · K8s
	ops_k8s_pods: READ,
	ops_k8s_logs: READ,
	ops_k8s_exec: EXEC,
	ops_k8s_rollout: (args: unknown) => {
		const a = (args as Record<string, unknown> | null)?.action;
		return a === "status" ? READ : EXEC;
	},

	// P2/P3 的工具在实现时才会加入本表（assertion 只检查已注册工具）
};

/** P1 新增工具的名称集合，用于启动期断言（验证这些工具在 getAllTools 中出现） */
export const P1_READ_TIER_NAMES = [
	"ops_file_ls",
	"ops_log_tail",
	"ops_log_journalctl",
	"ops_log_grep",
	"ops_health_check",
	"ops_health_poll",
	"ops_vault_list",
] as const;

export function tierFor(toolName: string, args: unknown): Tier {
	return tierOf(toolName, args, TIER_TABLE);
}

export function requiresOwnerAuth(toolName: string, args: unknown): boolean {
	return needsOwnerAuth(toolName, args, TIER_TABLE);
}

/**
 * 工具注册统一入口（方案 §7.3）。
 * ★ 直接使用宿主 ToolDefinition，不造平行类型；★ 强制 loadMode/approval/前缀（fail-fast）。
 */
export function registerOpsTool(pi: ExtensionAPI, def: ToolDefinition): void {
	if (!def.name.startsWith("ops_")) throw new Error(`[ops-pi] 工具名必须以 ops_ 前缀：${def.name}`);
	if (def.loadMode !== "essential") throw new Error(`[ops-pi] ${def.name} 缺少 loadMode:"essential"（O8/X4–X6）`);
	if (def.approval === undefined) throw new Error(`[ops-pi] ${def.name} 缺少 approval 档位（O2）`);
	pi.registerTool(def);
}
