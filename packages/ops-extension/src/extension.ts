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
	setupHooks(pi, ctx);
}
