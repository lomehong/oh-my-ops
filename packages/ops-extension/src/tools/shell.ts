import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { LOCAL_HOST } from "@ops-pi/core";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import { normalizeTargetHost } from "@ops-pi/core";
import type { OpsContext } from "../context.ts";

/** P1：ops_shell_exec / ops_shell_script — 本地 shell 执行（exec 档） */
export function registerShellTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_shell_exec",
		label: "Shell Exec",
		loadMode: "essential",
		approval: approval("ops_shell_exec"),
		description:
			"执行本地 shell 命令并返回 stdout/stderr。命令通过 shell 解析（支持管道、重定向）。" +
			"高危命令会被第②层内容硬拒拦截。须 Owner 预授权（policy.json 的 @local 规则或批准令牌）。" +
			"输出超 3000 行/50KB 时由宿主截断并存入 artifact。",
		parameters: z.object({
			command: z.string().describe("要执行的 shell 命令（支持管道、重定向）"),
			timeout: z.number().optional().describe("超时秒数（缺省 30，上限 600）"),
			host: z.string().optional().describe("目标主机（留空 = 本机；远程须 policy 预授权 + SSH 密钥可达）"),
		}),
		async execute(_toolCallId, params, signal) {
			const cmd = readField(params, "command");
			const timeout = clampTimeout(readField(params, "timeout", "30"), 600);
			const host = normalizeTargetHost(readField(params, "host") || undefined) ?? LOCAL_HOST;
			const ops = ctx.forHost(host === LOCAL_HOST ? undefined : host);
			// ③ 权威复核：返回授权来源（read|policy|token），原样落 details.authz 供审计
			const authz = assertAuthorized("ops_shell_exec", { command: cmd, host }, ctx.authzView);
			const result = await ops.shell.exec(["sh", "-c", cmd], { timeoutMs: timeout * 1000, signal });
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { authz },
			};
		},
	});

	registerOpsTool(pi, {
		name: "ops_shell_script",
		label: "Shell Script",
		loadMode: "essential",
		approval: approval("ops_shell_script"),
		description:
			"执行一段 shell 脚本（多行命令）。脚本通过 sh -c 解析。须 Owner 预授权。输出超 3000 行/50KB 时由宿主截断。",
		parameters: z.object({
			script: z.string().describe("要执行的 shell 脚本内容"),
			timeout: z.number().optional().describe("超时秒数（缺省 60）"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_toolCallId, params, signal) {
			const script = readField(params, "script");
			const timeout = clampTimeout(readField(params, "timeout", "60"), 600);
			const host = normalizeTargetHost(readField(params, "host") || undefined) ?? LOCAL_HOST;
			const ops = ctx.forHost(host === LOCAL_HOST ? undefined : host);
			// ★ 修复：此前误用 "ops_shell_exec" 复核——档位相同但审计归属错误
			const authz = assertAuthorized("ops_shell_script", { script, host }, ctx.authzView);
			const result = await ops.shell.exec(["sh", "-c", script], { timeoutMs: timeout * 1000, signal });
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { authz },
			};
		},
	});
}

function readField(source: unknown, key: string, fallback = ""): string {
	if (typeof source !== "object" || source === null) return fallback;
	for (const [k, v] of Object.entries(source)) { if (k === key && typeof v === "string") return v; }
	return fallback;
}
function clampTimeout(raw: string, max: number): number {
	const n = Number(raw);
	return Number.isFinite(n) ? Math.min(n, max) : 30;
}
