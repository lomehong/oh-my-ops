import { LOCAL_HOST, OpsError } from "@ops-pi/core";
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
 * ★ hostname 诚实化：当前 systemctl 在控制节点本地执行（远程经 SshPool 于 P1 引入）。
 *   host 参数仅接受省略或 "@local"——拒绝「声称操作远程主机、实际改的是本机」的误导语义。
 */
export function registerServiceTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_service",
		label: "Service",
		loadMode: "essential",
		approval: approval("ops_service"),
		description:
			"管理 systemd 服务（仅本机）。status 为只读（自动放行）；start/stop/restart/enable/disable 为变更类" +
			"（须 Owner 预授权：policy.json 的 @local 规则或批准令牌；生产标记目标禁止变更）。" +
			"host 参数留空或填 '@local'（远程执行尚未实现，禁止填其他主机名）。",
		parameters: z.object({
			host: z.string().optional().describe("目标主机：留空或 '@local'（当前仅本机；远程支持 P1 引入）"),
			service: z.string().describe("服务名（如 nginx）"),
			action: z.enum(["start", "stop", "restart", "status", "enable", "disable"]).describe("操作"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const service = String(p.service ?? "");
			const action = String(p.action ?? "status");

			// ★ hostname 诚实化：远程目标明确拒绝（此前会静默对本机执行并伪称操作了远程主机）
			const hostRaw = typeof p.host === "string" ? p.host.trim() : "";
			if (hostRaw !== "" && hostRaw !== LOCAL_HOST) {
				throw new OpsError(
					"POLICY_DENIED",
					`[ERR_POLICY] 远程执行尚未实现（P1 经 SshPool 引入）：当前仅支持本机目标。host 请省略或填 '${LOCAL_HOST}'，收到：'${hostRaw}'`,
				);
			}

			// ③ 权威复核：policyRequestFor 统一映射（host=@local, service, action），独立重算，不看 approval 判定结果
			const authz = assertAuthorized("ops_service", { host: LOCAL_HOST, service, action, command: `systemctl ${action} ${service}` }, ctx.authzView);

			if (action === "status") {
				const result = await ctx.shell.exec(
					["systemctl", "status", service, "--no-pager", "-l"],
					{ signal, timeoutMs: 10_000 },
				);
				return {
					content: [{ type: "text", text: result.stdout || `(no output, exit=${result.exitCode})` }],
					details: { authz, service, host: LOCAL_HOST, action },
				};
			}

			// 变更类操作：systemctl <action> <service>
			const result = await ctx.shell.exec(
				["systemctl", action, service],
				{ signal, timeoutMs: 30_000 },
			);
			return {
				content: [{ type: "text", text: result.stdout || `exit=${result.exitCode}` }],
				details: { authz, service, host: LOCAL_HOST, action },
			};
		},
	});
}
