import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { assertPlatformAtLoad } from "./platform.ts";
import { loadConfig } from "./setup.ts";
import { OpsContext } from "./context.ts";
import { registerReadOnlyTools } from "./tools/read-only.ts";
import { setupHooks } from "./hooks.ts";

/**
 * OpsPi 扩展入口（方案 §7.3）。
 * 加载顺序：平台校验 → 配置 → 上下文 → 工具注册 → 钩子。
 * 任何平台能力缺失 → 抛错拒启（§7.2，不静默降级）。
 */
export default function (pi: ExtensionAPI): void {
	assertPlatformAtLoad(pi);

	const config = loadConfig(process.cwd());
	const ctx = new OpsContext(config, { policyPath: config.policyPath ?? "", tokenPath: config.tokenPath ?? "" });

	registerReadOnlyTools(pi, ctx);
	setupHooks(pi, ctx, { hasUI: false });
}
