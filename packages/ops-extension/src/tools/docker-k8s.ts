import { READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import { policyRequestFor } from "../request.ts";
import type { OpsContext } from "../context.ts";

/** P3：Docker 工具——统一走 docker CLI over ShellExec（不挂生产 docker.sock，方案 §3.5/§7.1） */
export function registerDockerTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_docker_ps",
		label: "Docker PS",
		loadMode: "essential",
		approval: READ,
		description: "列出 Docker 容器（只读）。通过 docker CLI 执行。输出超 3000 行时由宿主截断。",
		parameters: z.object({
			all: z.boolean().optional().describe("包含已停止容器（--all）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_docker_ps", p, ctx.authzView);
			const args = ["docker", "ps", "--format", "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"];
			if (p.all === true) args.push("--all");
			const result = await ctx.shell.exec(args, { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: result.stdout || "(no containers)" }], details: { authz } };
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
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const container = String(p.container ?? "");
			const lines = Math.min(Number(p.lines ?? 100), 5000);
			if (!container) throw new Error("[INTERNAL] 缺少 container");
			const authz = assertAuthorized("ops_docker_logs", p, ctx.authzView);
			const result = await ctx.shell.exec(["docker", "logs", "--tail", String(lines), container], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: { authz } };
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
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const container = String(p.container ?? "");
			const command = String(p.command ?? "");
			// ③ 复核走统一映射：{ host:@local, service:容器名, action:"exec", command }
			const authz = assertAuthorized("ops_docker_exec", p, ctx.authzView);
			const result = await ctx.shell.exec(["docker", "exec", container, "sh", "-c", command], { signal, timeoutMs: 30_000 });
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: { authz, request: policyRequestFor("ops_docker_exec", p) } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_docker_compose",
		label: "Docker Compose",
		loadMode: "essential",
		approval: approval("ops_docker_compose"),
		description: "Docker Compose 操作（仅本机）。ps/logs 为只读；up/down/restart 为变更类（须 Owner 预授权）。",
		parameters: z.object({
			projectDir: z.string().describe("docker-compose.yml 所在目录"),
			action: z.enum(["ps", "logs", "up", "down", "restart"]).describe("Compose 操作"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const dir = String(p.projectDir ?? "");
			const action = String(p.action ?? "ps");
			const authz = assertAuthorized("ops_docker_compose", p, ctx.authzView);
			const result = await ctx.shell.exec(["docker", "compose", "-f", `${dir}/docker-compose.yml`, action], { signal, timeoutMs: 60_000 });
			return { content: [{ type: "text", text: result.stdout || result.stderr || `exit=${result.exitCode}` }], details: { authz } };
		},
	});
}

/** P3：K8s 工具——kubectl CLI（控制节点执行，靠 kubeconfig context 切换集群，方案 §3.6） */
export function registerK8sTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_k8s_pods",
		label: "K8s Pods",
		loadMode: "essential",
		approval: READ,
		description: "列出 Kubernetes Pod（只读）。通过 kubectl CLI 执行。",
		parameters: z.object({
			namespace: z.string().optional().describe("命名空间（缺省 default）"),
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_k8s_pods", p, ctx.authzView);
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const result = await ctx.shell.exec(["kubectl", "get", "pods", "-n", ns, "-o", "wide"], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: result.stdout || "(no pods)" }], details: { authz } };
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
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const pod = String(p.pod ?? "");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const authz = assertAuthorized("ops_k8s_logs", p, ctx.authzView);
			const result = await ctx.shell.exec(["kubectl", "logs", pod, "-n", ns, "--tail=200"], { signal, timeoutMs: 15_000 });
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: { authz } };
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
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const kind = String(p.kind ?? "deployment");
			const name = String(p.name ?? "");
			const action = String(p.action ?? "status");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const authz = assertAuthorized("ops_k8s_rollout", p, ctx.authzView);
			const cmdArgs = ["kubectl", "rollout", action, `${kind}/${name}`, "-n", ns];
			if (action === "status") cmdArgs.push("--watch=false");
			const result = await ctx.shell.exec(cmdArgs, { signal, timeoutMs: 60_000 });
			return { content: [{ type: "text", text: result.stdout || `exit=${result.exitCode}` }], details: { authz } };
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
		}),
		async execute(_id, params, signal) {
			const p = params as Record<string, unknown>;
			const pod = String(p.pod ?? "");
			const command = String(p.command ?? "");
			const ns = p.namespace !== undefined ? String(p.namespace) : "default";
			const container = p.container !== undefined ? String(p.container) : undefined;
			const authz = assertAuthorized("ops_k8s_exec", p, ctx.authzView);
			const args = ["kubectl", "exec", pod, "-n", ns];
			if (container !== undefined) args.push("-c", container);
			args.push("--", "sh", "-c", command);
			const result = await ctx.shell.exec(args, { signal, timeoutMs: 30_000 });
			return { content: [{ type: "text", text: result.stdout || result.stderr }], details: { authz } };
		},
	});
}
