import { READ, EXEC } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";

/**
 * P2：ops_service — systemd 服务操作（§7.4.1）。
 * approval 为函数式：按 action 返档（status → READ，其余 → EXEC）。
 * execute 首行 assertAuthorized（③ 权威复核），独立重算目标策略（defaultDeny）。
 */
export function registerServiceTools(pi: ExtensionAPI, ctx: OpsContext): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_service",
		label: "Service",
		loadMode: "essential",
		approval: (args: unknown) => {
			const action = (args as Record<string, unknown> | null)?.action;
			return action === "status" ? READ : EXEC;
		},
		description:
			"管理 systemd 服务。status 为只读（自动放行）；start/stop/restart/enable/disable 为变更类" +
			"（须 Owner 预授权，生产目标禁止无人值守）。目标策略由 policy.json 的 targets[] 控制。",
		parameters: z.object({
			host: z.string().describe("目标主机 hostname（用于目标策略匹配）"),
			service: z.string().describe("服务名（如 nginx）"),
			action: z.enum(["start", "stop", "restart", "status", "enable", "disable"]).describe("操作"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const host = String(p.host ?? "");
			const service = String(p.service ?? "");
			const action = String(p.action ?? "status");

			// ③ 权威复核：assertAuthorized 独立重算目标策略（不看 approval 判定结果）
			assertAuthorized(
				"ops_service",
				{ host, service, action, command: `systemctl ${action} ${service}` },
				ctx.authzView,
			);

			if (action === "status") {
				const result = await ctx.shell.exec(
					["systemctl", "status", service, "--no-pager", "-l"],
					{ signal, timeoutMs: 10_000 },
				);
				return {
					content: [{ type: "text", text: result.stdout || `(no output, exit=${result.exitCode})` }],
					details: { authz: "read", service, host, action },
				};
			}

			// 变更类操作：systemctl <action> <service>
			const result = await ctx.shell.exec(
				["systemctl", action, service],
				{ signal, timeoutMs: 30_000 },
			);
			ctx.markAuthzSource("preauth");
			return {
				content: [{ type: "text", text: result.stdout || `exit=${result.exitCode}` }],
				details: { authz: "preauth", service, host, action },
			};
		},
	});
}
