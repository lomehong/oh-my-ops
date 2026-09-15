import { LOCAL_HOST, OpsError, READ, normalizeTargetHost, tierOf } from "@ops-pi/core";
import type { PolicyRequest } from "@ops-pi/core";
import { TIER_TABLE } from "./approvals.ts";

/**
 * 工具入参 → PolicyRequest 统一映射（单一事实源）。
 * ①-a 审批层 / ①-b 兜底层 / ③ execute 复核层共用：三层看到的 request 必须逐字段一致，
 * 否则就会出现「审批层看到的与 execute 执行的不是一个目标」（方向① 伪造间隙）。
 *
 * host 维度语义（P7 起）：入参 host/hostname 经 normalizeTargetHost 规范化后透传——
 * 省略/空/@local → LOCAL_HOST（本机）；真实主机名 → 按该 host 做策略匹配
 * （policy.json 需有对应 host 的授权规则，缺省 defaultDeny）。非法主机名在此即拒。
 */
export function policyRequestFor(toolName: string, input: unknown): PolicyRequest {
	const rec = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const value = rec[key];
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	const host = normalizeTargetHost(str("host") ?? str("hostname")) ?? LOCAL_HOST;

	switch (toolName) {
		// systemd 服务：host 强制本机；service/action 为策略维度
		case "ops_service":
			return { host, service: str("service"), action: str("action") };

		// 本地 shell：action="shell"（policy.json 以 actions:["shell"] 精确授权 shell）
		case "ops_shell_exec":
		case "ops_shell_script":
			return { host, action: "shell", command: str("command") ?? str("script") };

		// Docker：容器名作为 service 维度（exec 为危险动作；ps/logs 为 read 档不经此映射判定）
		case "ops_docker_exec":
			return { host, service: str("container"), action: "exec", command: str("command") };
		case "ops_docker_compose":
			return { host, service: str("projectDir"), action: str("action") };

		// K8s：Pod 名作为 service 维度
		case "ops_k8s_exec":
			return { host, service: str("pod"), action: "exec", command: str("command") };
		case "ops_k8s_rollout":
			return { host, service: `${str("kind") ?? "deployment"}/${str("name") ?? ""}`, action: str("action") };

		// P11：write 档显式 action 维度——此前落入 default 分支只带 {host}（无 action、无 service），
		// 任意命中 host 的规则（哪怕只授权 nginx/restart 或 shell）都会连带放行文件写入与 vault 写入。
		// 显式 action 后：规则必须在 actions 中包含 file-write / vault-write（或 Owner 显式全 host 规则）才放行。
		case "ops_file_write":
			return { host, action: "file-write" };
		case "ops_vault_store":
			return { host, action: "vault-write" };
		case "ops_vault_rekey":
			return { host, action: "vault-rekey" };

		// P15 知识库 write 档：知识仓位于控制节点本机（KnowledgeStore 本地目录），host 恒 @local；
		// 显式 action 防止 shell/file-write 规则连带放行知识写入与 git push（同 P11 语义）。
		case "ops_kb_save":
			return { host: LOCAL_HOST, action: "kb-write" };
		case "ops_kb_sync":
			return { host: LOCAL_HOST, action: "kb-sync" };

		// 其余：仅 read 档允许落此分支（read 档在判定前即短路，此映射仅供一致性）。
		// ★ 非 read 档落到此处 = 新增 write/exec 工具忘记登记显式 action——fail-fast，
		//   不得以 {host} 宽松语义参与授权（否则任意命中 host 的规则都会连带放行，P11 教训）。
		default:
			if (tierOf(toolName, input, TIER_TABLE) !== READ) {
				throw new OpsError("INTERNAL", `[ops-pi] ${toolName} 为非 read 档工具但未在 policyRequestFor 登记显式 action`);
			}
			return { host };
	}
}
