import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { assertPlatformAtLoad } from "./platform.ts";
import { loadConfig } from "./setup.ts";
import { OpsContext } from "./context.ts";
import { registerReadOnlyTools } from "./tools/read-only.ts";
import { registerShellTools } from "./tools/shell.ts";
import { registerLogTools } from "./tools/log.ts";
import { registerDockerTools, registerK8sTools } from "./tools/docker-k8s.ts";
import { registerServiceTools } from "./tools/service.ts";
import { setupHooks } from "./hooks.ts";
import { registerOpsCommands } from "./commands.ts";
import { buildScenarioHints } from "./commands.ts";

/**
 * OpsPi 扩展入口（方案 §7.3）。
 * 加载顺序：平台校验 → 配置 → 上下文 → 工具注册 → 钩子。
 * 任何平台能力缺失 → 抛错拒启（§7.2）。
 */
export default function (pi: ExtensionAPI): void {
	assertPlatformAtLoad(pi);

	const config = loadConfig(process.cwd());
	const ctx = new OpsContext(config, { policyPath: config.policyPath ?? "", tokenPath: config.tokenPath ?? "" });

	// P1：注册所有工具——Shell（exec）+ 日志（read）+ Process/File（read）+ Health/Vault（read）
	registerShellTools(pi, ctx);
	registerLogTools(pi, ctx);
	registerDockerTools(pi, ctx);
	registerK8sTools(pi, ctx);
	registerServiceTools(pi, ctx);
	registerReadOnlyTools(pi, ctx);

	registerOpsCommands(pi, ctx);
	setupHooks(pi, ctx, { hasUI: false });

	// 场景提示词注入（before_agent_start 返回值，O10）
	pi.on("before_agent_start", async (event) => {
		const hints = buildScenarioHints(config);
		if (!hints) return;
		const base = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : String(event.systemPrompt);
		return { systemPrompt: `${base}\n\n${hints}` };
	});

	// 跨 Agent 降级提示（身份归 Yuyi 插件；适配器缺席时 notify）
	pi.on("session_start", async (_e, c) => {
		const hasYuyi = c.sessionManager !== undefined; // 占位：检测 Yuyi 适配器在场
		if (!hasYuyi) return;
		// Yuyi 适配器在场 → 跨 Agent 路径可用（只读）
		c.ui.notify("ops-pi：Yuyi 适配器在场，跨 Agent 只读请求已启用", "info");
	});
}
