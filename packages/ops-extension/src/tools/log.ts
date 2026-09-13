import { READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";

/** P1：ops_log_tail / ops_log_journalctl / ops_log_grep — 只读日志采集 */
export function registerLogTools(pi: ExtensionAPI, ctx: OpsContext): void {
	const z = pi.zod;

	// ops_log_tail：读日志文件末尾 N 行
	registerOpsTool(pi, {
		name: "ops_log_tail",
		label: "Log Tail",
		loadMode: "essential",
		approval: READ,
		description: "读取日志文件末尾 N 行。适合快速查看最新错误/状态。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			path: z.string().describe("日志文件绝对路径"),
			lines: z.number().optional().describe("读取行数（缺省 100，上限 5000）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const path = String(p.path ?? "");
			const lines = Math.min(Number(p.lines ?? 100), 5000);
			if (!path) throw new Error("[INTERNAL] 缺少 path");
			// ★ 此前漏接 assertAuthorized——补齐统一授权接线（read 档免判定，但保持单一入口与审计一致性）
			const authz = assertAuthorized("ops_log_tail", p, ctx.authzView);
			const result = await ctx.log.tailFile(path, { lines }, { signal, timeoutMs: 15_000 });
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { authz },
			};
		},
	});

	// ops_log_journalctl：systemd 日志查询
	registerOpsTool(pi, {
		name: "ops_log_journalctl",
		label: "Journalctl",
		loadMode: "essential",
		approval: READ,
		description: "查询 systemd journal 日志。可用 unit/since/priority 过滤。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			unit: z.string().optional().describe("服务单元名（如 nginx）"),
			since: z.string().optional().describe("起始时间（如 '1 hour ago'）"),
			priority: z.number().optional().describe("最低优先级（0=emerg..7=debug，缺省 4=err）"),
			lines: z.number().optional().describe("最大行数（缺省 200）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_log_journalctl", p, ctx.authzView);
			const result = await ctx.log.journalctl({
				unit: p.unit as string | undefined,
				since: p.since as string | undefined,
				priority: p.priority !== undefined ? Number(p.priority) : 4,
				lines: p.lines !== undefined ? Number(p.lines) : 200,
			}, { signal });
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { authz },
			};
		},
	});

	// ops_log_grep：多文件正则搜索
	registerOpsTool(pi, {
		name: "ops_log_grep",
		label: "Log Grep",
		loadMode: "essential",
		approval: READ,
		description: "在指定路径中按正则搜索日志内容。返回匹配文件、行号、文本。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			pattern: z.string().describe("正则表达式"),
			paths: z.array(z.string()).describe("搜索路径列表（文件或目录）"),
			maxCount: z.number().optional().describe("最大匹配数（缺省 200）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_log_grep", p, ctx.authzView);
			const result = await ctx.log.grep(
				String(p.pattern ?? ""),
				(p.paths ?? []) as string[],
				{ maxCount: p.maxCount !== undefined ? Number(p.maxCount) : 200 },
				{ signal, timeoutMs: 30_000 },
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { authz },
			};
		},
	});
}
