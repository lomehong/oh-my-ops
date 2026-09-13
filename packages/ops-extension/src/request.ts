import { LOCAL_HOST } from "@ops-pi/core";
import type { PolicyRequest } from "@ops-pi/core";

/**
 * 工具入参 → PolicyRequest 统一映射（单一事实源）。
 * ①-a 审批层 / ①-b 兜底层 / ③ execute 复核层共用：三层看到的 request 必须逐字段一致，
 * 否则就会出现「审批层看到的与 execute 执行的不是一个目标」（方向① 伪造间隙）。
 *
 * host 维度语义：当前所有工具都在控制节点本地执行（远程 P1 经 SshPool 引入），
 * 因此一律映射为 LOCAL_HOST（"@local"）——policy.json 以 "@local" 表示本机目标。
 * 工具入参里的 host/hostname 由各工具自行做「远程未实现」诚实化校验，不进入策略匹配。
 */
export function policyRequestFor(toolName: string, input: unknown): PolicyRequest {
	const rec = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const str = (key: string): string | undefined => {
		const value = rec[key];
		return typeof value === "string" && value !== "" ? value : undefined;
	};

	switch (toolName) {
		// systemd 服务：host 强制本机；service/action 为策略维度
		case "ops_service":
			return { host: LOCAL_HOST, service: str("service"), action: str("action") };

		// 本地 shell：action="shell"（policy.json 以 actions:["shell"] 精确授权 shell）
		case "ops_shell_exec":
		case "ops_shell_script":
			return { host: LOCAL_HOST, action: "shell", command: str("command") ?? str("script") };

		// Docker：容器名作为 service 维度（exec 为危险动作；ps/logs 为 read 档不经此映射判定）
		case "ops_docker_exec":
			return { host: LOCAL_HOST, service: str("container"), action: "exec", command: str("command") };
		case "ops_docker_compose":
			return { host: LOCAL_HOST, service: str("projectDir"), action: str("action") };

		// K8s：Pod 名作为 service 维度
		case "ops_k8s_exec":
			return { host: LOCAL_HOST, service: str("pod"), action: "exec", command: str("command") };
		case "ops_k8s_rollout":
			return { host: LOCAL_HOST, service: `${str("kind") ?? "deployment"}/${str("name") ?? ""}`, action: str("action") };

		// 其余（read 档为主）：host 统一本机；read 档在判定前即短路，不会真正用于授权
		default:
			return { host: LOCAL_HOST };
	}
}
