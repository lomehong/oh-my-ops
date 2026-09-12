import { READ, tierOf, needsOwnerAuth } from "@ops-pi/core";
import type { Tier, ApprovalDecision } from "@ops-pi/core";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

/**
 * §7.4.1 档位表（决策 D4）：工具名 → 档位（或按参数返档）。
 * P0 仅注册两个只读工具；表随 P1/P2 扩充（SSH/Process/Log/File 全量只读 + 变更类）。
 */
export const TIER_TABLE: Readonly<Record<string, Tier | ((args: unknown) => Tier)>> = {
	ops_file_read: READ,
	ops_process_list: READ,
};

export function tierFor(toolName: string, args: unknown): Tier {
	return tierOf(toolName, args, TIER_TABLE);
}

export function requiresOwnerAuth(toolName: string, args: unknown): boolean {
	return needsOwnerAuth(toolName, args, TIER_TABLE);
}

/**
 * 工具注册统一入口（方案 §7.3）：
 * ★ 直接使用宿主 ToolDefinition（写宿主契约，不造平行类型），
 * ★ 运行期强制 loadMode:"essential"（O8/X4–X6：缺省 discoverable 会使 approval 声明失效），
 * ★ 强制声明 approval 档位（O2），
 * ★ 强制 name 以 ops_ 前缀（防与其他扩展/内建工具语义混淆）。
 * 违反任一即在加载期抛错（fail-fast），不静默。
 */
export function registerOpsTool(pi: ExtensionAPI, def: ToolDefinition): void {
	if (!def.name.startsWith("ops_")) throw new Error(`[ops-pi] 工具名必须以 ops_ 前缀：${def.name}`);
	if (def.loadMode !== "essential") throw new Error(`[ops-pi] ${def.name} 缺少 loadMode:"essential"（O8/X4–X6）`);
	if (def.approval === undefined) throw new Error(`[ops-pi] ${def.name} 缺少 approval 档位（O2）`);
	pi.registerTool(def);
}
