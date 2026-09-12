import { READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";

/**
 * P0 只读工具：ops_file_read / ops_process_list（§7.4.1 read 档，三模式自动放行，X1/X8）。
 * ★ 全部经 registerOpsTool：强制 loadMode:"essential" + approval 档位（O8/X4–X6）。
 * ★ execute 首行 assertAuthorized：③ 权威复核（§7.4.4，X19）。
 */
export function registerReadOnlyTools(pi: ExtensionAPI, ctx: OpsContext): void {
	const z = pi.zod; // 宿主注入的原生 Zod 门面（ExtensionAPI 声明成员，O14）

	registerOpsTool(pi, {
		name: "ops_file_read",
		label: "File Read",
		loadMode: "essential",
		approval: READ,
		description:
			"读取本机文本文件内容（只读）。超过 2 MiB 或 3000 行时由宿主截断，完整内容存入 artifact。" +
			"路径边界由部署沙箱约束（方案 §7.1）。",
		parameters: z.object({
			path: z.string().describe("要读取的文件绝对路径"),
			maxBytes: z.number().optional().describe("读取上限（字节），缺省 2 MiB"),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _extensionCtx) {
			const request = toFileReadParams(params);
			assertAuthorized("ops_file_read", request, ctx.authzView);
			const text = await ctx.files.read(request.path, { maxBytes: request.maxBytes, signal });
			return { content: [{ type: "text", text }] };
		},
	});

	registerOpsTool(pi, {
		name: "ops_process_list",
		label: "Process List",
		loadMode: "essential",
		approval: READ,
		description: "列出本机进程快照（按 CPU 降序，只读）。可用 user 精确过滤、name 子串过滤，limit 缺省 50。",
		parameters: z.object({
			user: z.string().optional().describe("按用户名精确过滤"),
			name: z.string().optional().describe("按命令行子串过滤"),
			limit: z.number().optional().describe("返回条数上限（缺省 50）"),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _extensionCtx) {
			const request = toProcessListParams(params);
			assertAuthorized("ops_process_list", request, ctx.authzView);
			const rows = await ctx.process.list(
				{ user: request.user, name: request.name, limit: request.limit },
				{ signal, timeoutMs: 15_000 },
			);
			return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
		},
	});
}

// ── 参数边界：untrusted → 类型化（Object.entries 遍历，无 cast、无 shell 语义）

function toFileReadParams(params: unknown): { path: string; maxBytes?: number } {
	const pathValue = readStringField(params, "path");
	if (pathValue === undefined) throw new Error("[INTERNAL] 缺少必填参数 path");
	return { path: pathValue, maxBytes: readNumberField(params, "maxBytes") };
}

function toProcessListParams(params: unknown): { user?: string; name?: string; limit?: number } {
	return {
		user: readStringField(params, "user"),
		name: readStringField(params, "name"),
		limit: readNumberField(params, "limit"),
	};
}

function readStringField(source: unknown, key: string): string | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	for (const [field, value] of Object.entries(source)) {
		if (field === key && typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

function readNumberField(source: unknown, key: string): number | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	for (const [field, value] of Object.entries(source)) {
		if (field === key && typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}
