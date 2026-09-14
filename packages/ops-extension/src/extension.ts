import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { assertPlatformAtLoad } from "./platform.ts";
import { loadConfig } from "./setup.ts";
import { OpsContext } from "./context.ts";
import { makeApprovalFactory } from "./approvals.ts";
import { registerReadOnlyTools } from "./tools/read-only.ts";
import { registerShellTools } from "./tools/shell.ts";
import { registerLogTools } from "./tools/log.ts";
import { registerDockerTools, registerK8sTools } from "./tools/docker-k8s.ts";
import { registerServiceTools } from "./tools/service.ts";
import { setupHooks } from "./hooks.ts";
import { registerOpsCommands } from "./commands.ts";
import { registerWriteTools } from "./tools/write.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";

/**
 * omo 扩展入口（方案 §7.3）。
 * 加载顺序：平台校验 → 配置 → 上下文 → 工具注册 → 钩子。
 * 任何平台能力缺失 → 抛错拒启（§7.2）。
 *
 * ★ 审批接线（§7.4.4 规范 1）：所有 exec 档工具的 approval 由 makeApprovalFactory 构造——
 *   审批层（①-a）以 defaultDeny 表达预授权：令牌/白名单命中 → policy:"allow"（任何模式放行），
 *   生产目标 → policy:"deny"（任何模式硬拒），其余交平台审批/①-b 兜底。
 */
export default function (pi: ExtensionAPI): void {
	assertPlatformAtLoad(pi);

	const config = loadConfig(process.cwd());
	const ctx = new OpsContext(config, { policyPath: config.policyPath, tokenPath: config.tokenPath });
	const approval = makeApprovalFactory(ctx.targetPolicy, ctx.tokens);

	// P1：注册所有工具——Shell（exec）+ 日志（read）+ Process/File（read）+ Health/Vault（read）
	registerShellTools(pi, ctx, approval);
	registerLogTools(pi, ctx);
	registerDockerTools(pi, ctx, approval);
	registerK8sTools(pi, ctx, approval);
	registerServiceTools(pi, ctx, approval);
	registerReadOnlyTools(pi, ctx);

	registerOpsCommands(pi, ctx);
	registerWriteTools(pi, ctx, ctx.vault, approval);
	registerKnowledgeTools(pi, ctx, approval);
	setupHooks(pi, ctx);
}
