import { LOCAL_HOST, normalizeTargetHost } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";

/**
 * P2：ops_service — systemd 服务操作（§7.4.1）。
 * approval 由 approvalFor 工厂构造：status → read 自动放行；变更类按单一事实源判定
 * （令牌/预授权 → policy:"allow"；生产目标 → policy:"deny"；其余交平台审批/①-b 兜底）。
 * execute 首行 assertAuthorized（③ 权威复核），并消费命中的批准令牌。
 *
 * ★ host 支持远程目标（P7 SshPool）：host 经规范化后进入策略匹配（真实主机名需
 *   policy.json 对应 host 规则），执行经 SshPool 远程通道。
 */
export function registerServiceTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_service",
		label: "Service",
		loadMode: "essential",
		approval: approval("ops_service"),
		description:
			"管理 systemd 服务（支持远程主机）。status 为只读（自动放行）；start/stop/restart/enable/disable 为变更类" +
			"（须 Owner 预授权：policy.json 对应 host 规则或批准令牌；生产标记目标禁止变更）。",
		parameters: z.object({
			host: z.string().optional().describe("目标主机（留空 = 本机；远程须 policy 预授权 + SSH 密钥可达）"),
			service: z.string().describe("服务名（如 nginx）"),
			action: z.enum(["start", "stop", "restart", "status", "enable", "disable"]).describe("操作"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const service = String(p.service ?? "");
			const action = String(p.action ?? "status");

			// host 规范化：@local/空 → 本机；真实主机名 → SshPool 远程通道
			const host = normalizeTargetHost(typeof p.host === "string" ? p.host.trim() : "") ?? LOCAL_HOST;
			const ops = ctx.forHost(host === LOCAL_HOST ? undefined : host);

			// ③ 权威复核：policyRequestFor 统一映射（host, service, action），独立重算，不看 approval 判定结果
			const authz = assertAuthorized("ops_service", { host, service, action, command: `systemctl ${action} ${service}` }, ctx.authzView);

			if (action === "status") {
				const result = await ops.shell.exec(
					["systemctl", "status", service, "--no-pager", "-l"],
					{ signal, timeoutMs: 10_000 },
				);
				return {
					content: [{ type: "text", text: result.stdout || `(no output, exit=${result.exitCode})` }],
					details: { authz, service, host, action },
				};
			}

			// 变更类操作：systemctl <action> <service>
			const result = await ops.shell.exec(
				["systemctl", action, service],
				{ signal, timeoutMs: 30_000 },
			);
			return {
				content: [{ type: "text", text: result.stdout || `exit=${result.exitCode}` }],
				details: { authz, service, host, action },
			};
		},
	});
}
