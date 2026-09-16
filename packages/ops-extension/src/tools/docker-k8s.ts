import { LOCAL_HOST, normalizeTargetHost, READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import { fmtExecResult } from "./exec-output.ts";
import { policyRequestFor } from "../request.ts";
import type { OpsContext } from "../context.ts";

/** P3：Docker 工具——统一走 docker CLI over ShellExec（不挂生产 docker.sock，方案 §3.5/§7.1） */
export function registerDockerTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;
	/** host 参数 → 能力束（P7 远程路由）；details 统一带真实 host 供审计 */
	const route = (raw: unknown) => {
		const host = normalizeTargetHost(typeof raw === "string" ? raw : undefined) ?? LOCAL_HOST;
		return { ops: ctx.forHost(host === LOCAL_HOST ? undefined : host), host };
	};

	registerOpsTool(pi, {
		name: "ops_docker_ps",
		label: "Docker PS",
		loadMode: "essential",
		approval: READ,
		description: "列出 Docker 容器（只读）。通过 docker CLI 执行。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			all: z.boolean().optional().describe("包含已停止容器（--all）"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_docker_ps", { ...p, host }, ctx.authzView);
			const args = ["docker", "ps", "--format", "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"];
			if (p.all === true) args.push("--all");
			const result = await ops.shell.exec(args, { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: fmtExecResult(result, "(no containers)") }], details: { authz, host } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_docker_logs",
		label: "Docker Logs",
		loadMode: "essential",
		approval: READ,
		description: "查看容器日志末尾 N 行。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			container: z.string().describe("容器名或 ID"),
			lines: z.number().optional().describe("行数（缺省 100）"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const container = String(p.container ?? "");
			const lines = Math.min(Number(p.lines ?? 100), 5000);
			if (!container) throw new Error("[INTERNAL] 缺少 container");
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_docker_logs", { ...p, host }, ctx.authzView);
			const result = await ops.shell.exec(["docker", "logs", "--tail", String(lines), container], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_docker_exec",
		label: "Docker Exec",
		loadMode: "essential",
		approval: approval("ops_docker_exec"),
		description: "在容器内执行命令（exec 档，须 Owner 预授权：policy.json 的 @local 规则或批准令牌）。",
		parameters: z.object({
			container: z.string().describe("容器名或 ID"),
			command: z.string().describe("要执行的命令"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const container = String(p.container ?? "");
			const command = String(p.command ?? "");
			const { ops, host } = route(p.host);
			// ③ 复核走统一映射：{ host, service:容器名, action:"exec", command }
			const authz = assertAuthorized("ops_docker_exec", { ...p, host }, ctx.authzView);
			const result = await ops.shell.exec(["docker", "exec", container, "sh", "-c", command], { signal, timeoutMs: 30_000 });
			return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host, request: policyRequestFor("ops_docker_exec", { ...p, host }) } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_docker_compose",
		label: "Docker Compose",
		loadMode: "essential",
		approval: approval("ops_docker_compose"),
		description: "Docker Compose 操作（仅本机）。ps/logs 为只读；up/down/restart 为变更类（须 Owner 预授权）。",
		parameters: z.object({
			projectDir: z.string().describe("compose 文件所在目录"),
			file: z.string().optional().describe("compose 文件名（缺省 docker-compose.yml，可传 compose.yaml）"),
			action: z.enum(["ps", "logs", "up", "down", "restart"]).describe("Compose 操作"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const dir = String(p.projectDir ?? "");
			const action = String(p.action ?? "ps");
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_docker_compose", { ...p, host }, ctx.authzView);
			const fileName = String(p.file ?? "docker-compose.yml");
			// 平台分支探测（2026-09-16 对端实测两轮）：compose v2 走 CLI 插件机制，而插件目录扫描是
			// Docker CLI **19.03** 才引入的——老平台（如 18.09）装 v2 插件也不会被识别，只能走 standalone
			// `docker-compose` v1（Python/PyInstaller 单文件，直连 daemon API，与 CLI 版本无关）。
			const v2 = await ops.shell.exec(["docker", "compose", "version"], { signal, timeoutMs: 10_000 });
			if (v2.exitCode === 0) {
				const result = await ops.shell.exec(["docker", "compose", "-f", `${dir}/${fileName}`, action], { signal, timeoutMs: 60_000 });
				return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
			}
			// v2 不可用 → 试 v1 standalone（可用则自动回退执行，老平台因此可用）
			const v1 = await ops.shell.exec(["docker-compose", "version"], { signal, timeoutMs: 10_000 });
			if (v1.exitCode === 0) {
				const result = await ops.shell.exec(["docker-compose", "-f", `${dir}/${fileName}`, action], { signal, timeoutMs: 60_000 });
				return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
			}
			// 两者皆无 → 给平台分支的处置建议（避免让老平台去装一个装不上的插件）
			const cliVer = await ops.shell.exec(["docker", "--version"], { signal, timeoutMs: 10_000 });
			const verMatch = /version\s+(\d+)\.(\d+)/.exec(cliVer.stdout || cliVer.stderr || "");
			const ver = verMatch ? `${verMatch[1]}.${verMatch[2]}` : "未知";
			const pluginCapable = verMatch !== null && (Number(verMatch[1]) > 19 || (Number(verMatch[1]) === 19 && Number(verMatch[2]) >= 3));
			const detail = (v2.stderr || v2.stdout).trim().split("\n").slice(0, 3).join("\n");
			const advice = pluginCapable
				? "· 本机 Docker CLI " + ver + " 支持 CLI 插件：安装 compose v2 插件（放到 ~/.docker/cli-plugins/docker-compose 或 /usr/libexec/docker/cli-plugins/，chmod +x）；或装 standalone docker-compose v1。"
				: "· 本机 Docker CLI " + ver + " **低于 19.03，无 CLI 插件机制**——装 compose v2 插件不会被识别，请改用 standalone docker-compose v1 单文件（放 /usr/local/bin/docker-compose，chmod +x；本工具会自动回退使用它）。";
			return {
				content: [{
					type: "text",
					text: [
						`docker compose 不可用（v2 插件 exit=${v2.exitCode}${detail === "" ? "" : `：${detail}`}；docker-compose v1 exit=${v1.exitCode}）`,
						"处置建议：",
						advice,
					].join("\n"),
				}],
				details: { authz, host },
			};
		},
	});
}

/** P3：K8s 工具——kubectl CLI（控制节点执行，靠 kubeconfig context 切换集群，方案 §3.6） */
export function registerK8sTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;
	/** host 参数 → 能力束（P7 远程路由）；details 统一带真实 host 供审计 */
	const route = (raw: unknown) => {
		const host = normalizeTargetHost(typeof raw === "string" ? raw : undefined) ?? LOCAL_HOST;
		return { ops: ctx.forHost(host === LOCAL_HOST ? undefined : host), host };
	};

	registerOpsTool(pi, {
		name: "ops_k8s_pods",
		label: "K8s Pods",
		loadMode: "essential",
		approval: READ,
		description: "列出 Kubernetes Pod（只读）。通过 kubectl CLI 执行。",
		parameters: z.object({
			namespace: z.string().optional().describe("命名空间（缺省 default）"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_k8s_pods", { ...p, host }, ctx.authzView);
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const result = await ops.shell.exec(["kubectl", "get", "pods", "-n", ns, "-o", "wide"], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: fmtExecResult(result, "(no pods)") }], details: { authz, host } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_k8s_logs",
		label: "K8s Logs",
		loadMode: "essential",
		approval: READ,
		description: "查看 Pod 日志。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			pod: z.string().describe("Pod 名称"),
			namespace: z.string().optional().describe("命名空间"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const pod = String(p.pod ?? "");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_k8s_logs", { ...p, host }, ctx.authzView);
			const result = await ops.shell.exec(["kubectl", "logs", pod, "-n", ns, "--tail=200"], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_k8s_rollout",
		label: "K8s Rollout",
		loadMode: "essential",
		approval: approval("ops_k8s_rollout"),
		description: "K8s Rollout 操作（仅本机 kubectl）。status 为只读；restart/undo 为变更类（须 Owner 预授权）。",
		parameters: z.object({
			kind: z.string().describe("资源类型（deployment/statefulset）"),
			name: z.string().describe("资源名"),
			action: z.enum(["status", "restart", "undo"]).describe("Rollout 操作"),
			namespace: z.string().optional().describe("命名空间"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const kind = String(p.kind ?? "deployment");
			const name = String(p.name ?? "");
			const action = String(p.action ?? "status");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_k8s_rollout", { ...p, host }, ctx.authzView);
			const cmdArgs = ["kubectl", "rollout", action, `${kind}/${name}`, "-n", ns];
			if (action === "status") cmdArgs.push("--watch=false");
			const result = await ops.shell.exec(cmdArgs, { signal, timeoutMs: 60_000 });
			return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_k8s_exec",
		label: "K8s Exec",
		loadMode: "essential",
		approval: approval("ops_k8s_exec"),
		description: "在 K8s Pod 容器内执行命令（exec 档，须 Owner 预授权）。",
		parameters: z.object({
			pod: z.string().describe("Pod 名称"),
			command: z.string().describe("要执行的命令"),
			container: z.string().optional().describe("容器名（多容器 Pod 时指定）"),
			namespace: z.string().optional().describe("命名空间"),
			host: z.string().optional().describe("目标主机（留空 = 本机）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const pod = String(p.pod ?? "");
			const command = String(p.command ?? "");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const container = p.container !== undefined ? String(p.container) : undefined;
			const { ops, host } = route(p.host);
			const authz = assertAuthorized("ops_k8s_exec", { ...p, host }, ctx.authzView);
			const args = ["kubectl", "exec", pod, "-n", ns];
			if (container !== undefined) args.push("-c", container);
			args.push("--", "sh", "-c", command);
			const result = await ops.shell.exec(args, { signal, timeoutMs: 30_000 });
			return { content: [{ type: "text", text: fmtExecResult(result) }], details: { authz, host } };
		},
	});
}
