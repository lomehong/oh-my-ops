import { LOCAL_HOST, normalizeTargetHost } from "@ops-pi/core";
import type { PolicyRequest } from "@ops-pi/core";

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

		// 其余（read 档为主）：host 统一本机；read 档在判定前即短路，不会真正用于授权
		default:
			return { host };
	}
}
