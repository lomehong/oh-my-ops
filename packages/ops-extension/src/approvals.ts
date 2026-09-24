import { restoreToolInput } from "./redact.ts";
import { evaluateAuthorization, READ, WRITE, EXEC, tierOf, needsOwnerAuth } from "@ops-pi/core";
import type { ApprovalDecision, Tier, TargetPolicy, TokenStore } from "@ops-pi/core";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { policyRequestFor } from "./request.ts";

/**
 * §7.4.1 完整档位表（决策 D4）——本表是「工具清单」的唯一事实源：
 * 系统提示词、启动期清单断言均由本表生成（防止提示词宣告未实现的工具）。
 * 只登记**已实现**的工具；SSH/vault 写路径等未实现项于实现时加入本表。
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

	// P2 · action 多态（readActions 由 READ_ACTIONS 单独声明，供提示词渲染）
	ops_service: (args: unknown) => {
		const a = (args as Record<string, unknown> | null)?.action;
		return a === "status" ? READ : EXEC;
	},

	// P8 · write
	ops_file_write: WRITE,
	ops_vault_store: WRITE,

	// P15 · 知识库
	ops_kb_list: READ,
	// P1 · read：部署后真实浏览器验证（只访问/断言/截图，不提交表单、不改远端）
	ops_web_verify: READ,
	ops_kb_search: READ,
	ops_kb_save: WRITE,
	ops_kb_sync: WRITE,
	ops_kb_status: READ,

	// P14 · write（vault 口令轮换）
	ops_vault_rekey: WRITE,

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
};

/** action 多态工具的 read 动作清单（仅用于提示词渲染与一致性测试；档位判定以 TIER_TABLE 为准） */
export const READ_ACTIONS: Readonly<Record<string, readonly string[]>> = {
	ops_service: ["status"],
	ops_docker_compose: ["ps", "logs"],
	ops_k8s_rollout: ["status"],
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

// ── 注册清单（供工具注册表自愈；registerOpsTool 唯一写入点）──

const REGISTERED_DEFS = new Map<string, ToolDefinition>();

/** 已注册的 ops_* 工具定义（名称 → 定义），供注册表自愈（repairToolRegistry）使用 */
export function getRegisteredOpsToolDefs(): ReadonlyMap<string, ToolDefinition> {
	return REGISTERED_DEFS;
}

/**
 * 工具注册统一入口（方案 §7.3）。
 * ★ 直接使用宿主 ToolDefinition，不造平行类型；★ 强制 loadMode/approval/前缀（fail-fast）。
 */
export function registerOpsTool(pi: ExtensionAPI, def: ToolDefinition): void {
	if (!def.name.startsWith("ops_")) throw new Error(`[ops-pi] 工具名必须以 ops_ 前缀：${def.name}`);
	if (def.loadMode !== "essential") throw new Error(`[ops-pi] ${def.name} 缺少 loadMode:"essential"（O8/X4–X6）`);
	if (def.approval === undefined) throw new Error(`[ops-pi] ${def.name} 缺少 approval 档位（O2）`);
	// 入站还原收口：模型回填的占位符一律在此还原为真实值（工具以真实值执行）。
	// 宿主事件层的 `tool_call` 结果契约是「原始执行入参」，对部分工具不生效（真机实测）；
	// 这里是我们自己工具的唯一入口，还原在此保证生效（未启用脱敏时 restoreToolInput 为 no-op）。
	const wrapped: ToolDefinition = {
		...def,
		execute: (toolCallId, params, signal, onUpdate, ctx) => def.execute(toolCallId, restoreToolInput(params), signal, onUpdate, ctx),
	};
	REGISTERED_DEFS.set(def.name, wrapped);
	pi.registerTool(wrapped);
}

// ── 审批层工厂（①-a）：把授权判定接进宿主 approval ──

export type ApprovalFn = (args: unknown) => ApprovalDecision;

/**
 * ★ 审批层授权工厂（§7.4.4 规范 1：预授权必须以 defaultDeny 表达在审批层）。
 * 返回每个工具的 approval 函数：
 *   read 档              → 返回 "read"（宿主自动放行）
 *   令牌/预授权命中      → { tier, policy:"allow", reason }（任何模式放行，含无人值守）
 *   生产目标无令牌       → { tier, policy:"deny",  reason }（任何模式硬拒，X3/X8）
 *   其余                 → { tier }（交平台审批；无人值守由 ①-b 兜底拒绝）
 * 判定与 ①-b / ③ 复核共用 evaluateAuthorization + policyRequestFor（单一事实源）。
 * ★ 纯函数：宿主一次调用会求值 3 次（X21），严禁在此消费令牌——消费只在 ③ assertAuthorized。
 */
export function makeApprovalFactory(policy: TargetPolicy, tokens: TokenStore): (toolName: string) => ApprovalFn {
	return (toolName: string) => (args: unknown): ApprovalDecision => {
		const tier = tierFor(toolName, args);
		if (tier === READ) return READ;
		const request = policyRequestFor(toolName, args);
		const verdict = evaluateAuthorization(policy, tokens, request);
		if (verdict.allowed) {
			return {
				tier,
				policy: "allow",
				reason: verdict.source === "token"
					? `Owner 批准令牌 ${verdict.tokenId}`
					: `命中预授权 ${[request.host, request.service, request.action].filter((x) => x !== undefined).join("/")}`,
			};
		}
		if (verdict.reason === "guard-production") {
			return { tier, policy: "deny", reason: "生产目标禁止无人值守变更（如需放行须 Owner 批准令牌）" };
		}
		return { tier };
	};
}

// ── 提示词能力清单（由 TIER_TABLE 生成，保证「提示词 = 注册表」零漂移）──

export interface CapabilityLists {
	read: string[];
	write: string[];
	exec: string[];
}

/** 从 TIER_TABLE 渲染能力清单；action 多态工具渲染为 name(action|…) 形式 */
export function buildCapabilityLists(): CapabilityLists {
	const read: string[] = [];
	const write: string[] = [];
	const exec: string[] = [];
	for (const name of Object.keys(TIER_TABLE)) {
		const entry = TIER_TABLE[name];
		const readActions = READ_ACTIONS[name];
		if (typeof entry === "function" && readActions !== undefined) {
			read.push(`${name}(${readActions.join("|")})`);
			exec.push(`${name}(除 ${readActions.join("/")})`);
		} else if (entry === READ) {
			read.push(name);
		} else if (entry === WRITE) {
			write.push(name);
		} else {
			exec.push(name);
		}
	}
	return { read, write, exec };
}
