import { LOCAL_HOST, OpsError, READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";

/**
 * P1：只读工具注册——process_list / file_read / file_ls / health_* / vault_list
 * 全部经 registerOpsTool 强制 loadMode:"essential" + approval（P0 Contract ③）。
 * health_check/health_poll 走 shell exec 收集基础指标，L1 不依赖 omp（设计 §7.1）。
 *
 * ★ hostname 诚实化：health_* 的 hostname 参数仅接受省略或 "@local"——
 *   此前填任何值都静默返回本机指标（「巡检 web-01 实为本机」误导，现明确拒绝）。
 */
export function registerReadOnlyTools(pi: ExtensionAPI, ctx: OpsContext): void {
	const z = pi.zod;

	/** hostname 诚实化守卫（health_* 共用） */
	const assertLocalHostname = (raw: unknown): void => {
		const value = typeof raw === "string" ? raw.trim() : "";
		if (value !== "" && value !== LOCAL_HOST) {
			throw new OpsError(
				"POLICY_DENIED",
				`[ERR_POLICY] 远程巡检尚未实现（P1 经 SshPool 引入）：当前仅支持本机。hostname 请省略或填 '${LOCAL_HOST}'，收到：'${value}'`,
			);
		}
	};

	// ── Process ──
	registerOpsTool(pi, {
		name: "ops_process_list",
		label: "Process List",
		loadMode: "essential",
		approval: READ,
		description: "列出本机进程快照（按 CPU 降序）。可用 user/name 过滤，limit 缺省 50。",
		parameters: z.object({
			user: z.string().optional().describe("按用户名精确过滤"),
			name: z.string().optional().describe("按命令行子串过滤"),
			limit: z.number().optional().describe("返回条数上限（缺省 50）"),
		}),
		async execute(_toolCallId, params, signal) {
			const authz = assertAuthorized("ops_process_list", params, ctx.authzView);
			const p = params as Record<string, unknown>;
			const rows = await ctx.process.list(
				{ user: p.user as string | undefined, name: p.name as string | undefined, limit: p.limit !== undefined ? Number(p.limit) : undefined },
				{ signal, timeoutMs: 15_000 },
			);
			return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { authz } };
		},
	});

	// ── File Read ──
	registerOpsTool(pi, {
		name: "ops_file_read",
		label: "File Read",
		loadMode: "essential",
		approval: READ,
		description: "读取本机文本文件内容（只读）。超过 2 MiB 或 3000 行时由宿主截断并存入 artifact。路径边界由沙箱约束。",
		parameters: z.object({
			path: z.string().describe("文件绝对路径"),
			maxBytes: z.number().optional().describe("读取上限（字节），缺省 2 MiB"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const path = String(p.path ?? "");
			if (!path) throw new Error("[INTERNAL] 缺少 path");
			const authz = assertAuthorized("ops_file_read", p, ctx.authzView);
			const text = await ctx.files.read(path, { maxBytes: p.maxBytes !== undefined ? Number(p.maxBytes) : undefined, signal });
			return { content: [{ type: "text", text }], details: { authz } };
		},
	});

	// ── File Ls ──
	registerOpsTool(pi, {
		name: "ops_file_ls",
		label: "File List",
		loadMode: "essential",
		approval: READ,
		description: "列出目录内容（文件名、大小、修改时间）。仅返回目录下直接条目（非递归）。",
		parameters: z.object({
			path: z.string().describe("目录绝对路径"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const path = String(p.path ?? "");
			if (!path) throw new Error("[INTERNAL] 缺少 path");
			const authz = assertAuthorized("ops_file_ls", p, ctx.authzView);
			const result = await ctx.shell.exec(["ls", "-lh", "--time-style=full-iso", path], { signal, timeoutMs: 10_000 });
			return { content: [{ type: "text", text: result.stdout }], details: { authz } };
		},
	});

	// ── Health Check ──
	registerOpsTool(pi, {
		name: "ops_health_check",
		label: "Health Check",
		loadMode: "essential",
		approval: READ,
		description: "本机快速健康检查：CPU 负载、内存使用、磁盘空间、关键进程。超时 30s。",
		parameters: z.object({
			hostname: z.string().optional().describe("主机标识：留空或 '@local'（当前仅本机；远程支持 P1 引入）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			assertLocalHostname(p.hostname);
			const authz = assertAuthorized("ops_health_check", p, ctx.authzView);
			const commands = [
				"echo '=== CPU ===' && uptime && mpstat 1 1 2>/dev/null | tail -1 || top -bn1 | head -3",
				"echo '=== MEMORY ===' && free -h | head -3",
				"echo '=== DISK ===' && df -h / 2>/dev/null | tail -1",
				"echo '=== TOP PROCESSES ===' && ps aux --sort=-%cpu | head -6",
			].join(" && ");
			const result = await ctx.shell.exec(["sh", "-c", commands], { signal, timeoutMs: 30_000 });
			return {
				content: [{ type: "text", text: result.stdout }],
				details: { authz, host: LOCAL_HOST },
			};
		},
	});

	// ── Health Poll ──
	registerOpsTool(pi, {
		name: "ops_health_poll",
		label: "Health Poll",
		loadMode: "essential",
		approval: READ,
		description: "本机连续健康检查（单次快照）。返回与 health_check 相同格式，供定期轮询使用。",
		parameters: z.object({
			hostname: z.string().optional().describe("主机标识：留空或 '@local'"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			assertLocalHostname(p.hostname);
			const authz = assertAuthorized("ops_health_poll", p, ctx.authzView);
			const commands = [
				"echo '=== LOAD ===' && uptime",
				"echo '=== MEM ===' && free -h | head -3",
				"echo '=== DISK ===' && df -h / 2>/dev/null | tail -1",
				"echo '=== TOP3 ===' && ps aux --sort=-%cpu | head -4",
			].join(" && ");
			const result = await ctx.shell.exec(["sh", "-c", commands], { signal, timeoutMs: 30_000 });
			return { content: [{ type: "text", text: result.stdout }], details: { authz, host: LOCAL_HOST } };
		},
	});

	// ── Vault List ──
	registerOpsTool(pi, {
		name: "ops_vault_list",
		label: "Vault List",
		loadMode: "essential",
		approval: READ,
		description: "列出 vault 中存储的凭据名称（仅名称，不显示内容）。vault 未解锁时返回提示信息。",
		parameters: z.object({}),
		async execute(_toolCallId, params, _signal) {
			const authz = assertAuthorized("ops_vault_list", params, ctx.authzView);
			// P1 stub：vault 未实现，返回引导信息
			const items = ctx.config.vault?.dbPath
				? ["ops_vault 配置已检测，请实现 CredentialVault 存储后使用此工具"]
				: ["未配置 vault（.ops-pi/config.json 中 vault.dbPath 未设置）"];
			return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }], details: { authz } };
		},
	});
}
