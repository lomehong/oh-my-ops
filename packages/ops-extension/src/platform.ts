import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface PlatformCheck {
	name: string;
	hint: string;
	probe: (pi: ExtensionAPI) => boolean;
}

/**
 * 平台能力前置校验（方案 §7.2）。
 * 与外部增强（Yuyi/御符/vault）的降级不同：平台能力是安全前提，缺失 → 硬失败拒绝启动。
 *
 * 能力边界（X14）：扩展 API 无 settings 访问器，无法自检 `approvalMode`——
 * 该项由部署规范（禁止 yolo）与 ①-b 模式无关兜底层共同保证，不列入此处。
 *
 * `tool.approval` 的**执行期语义**（X3/X5：档位被宿主执行）由发布流程探针验证，
 * 不在运行期重复探测；运行期安全不依赖它（①-b 兜底层与审批模式无关）。
 */
export function platformChecks(pi: ExtensionAPI): readonly PlatformCheck[] {
	const surface = pi as unknown as Record<string, unknown>;
	return [
		{
			name: "pi.zod",
			probe: () => typeof (surface.zod as { object?: unknown } | undefined)?.object === "function",
			hint: "omp 18.x 起注入 pi.zod（原生 schema 构建器，O14）",
		},
		{
			name: "pi.appendEntry",
			probe: () => typeof surface.appendEntry === "function",
			hint: "审计持久化依赖 appendEntry（O16）",
		},
		{
			name: "pi.getAllTools / pi.setActiveTools",
			probe: () => typeof surface.getAllTools === "function" && typeof surface.setActiveTools === "function",
			hint: "工具前缀不相交断言依赖 getAllTools（O11/X15）",
		},
		{
			name: "ctx.sessionManager.getBranch",
			probe: () => true, // ctx 侧能力在 session_start 校验（assertPlatformAtSessionStart）
			hint: "审计读取依赖 getBranch（O17）",
		},
		{
			name: "event.tool_execution_end",
			probe: () => true, // 契约内事件；审计覆盖被阻断调用（R-4），运行期由审计条目验证
			hint: "审计覆盖被阻断调用依赖该事件",
		},
	];
}

/** 工厂内同步校验（加载期；ctx 侧能力在 session_start 校验，见 assertPlatformAtSessionStart） */
export function assertPlatformAtLoad(pi: ExtensionAPI): void {
	const failures: string[] = [];
	for (const check of platformChecks(pi)) {
		let ok = false;
		try { ok = check.probe(pi); } catch (error) { void error; ok = false; }
		if (!ok) failures.push(`  · ${check.name}：${check.hint}`);
	}
	if (failures.length > 0) {
		throw new Error(
			`[ops-pi] 平台能力校验失败（omp 最低版本 18.1.18）：\n${failures.join("\n")}\n` +
			"拒绝启动：缺失的能力是安全前提，不会以残缺安全门运行。",
		);
	}
}

/** session_start 期校验：ctx 侧能力（加载期不可探测，X15 实测） */
export function assertPlatformAtSessionStart(ctx: {
	setInterval: unknown;
	sessionManager: { getBranch: unknown };
}): void {
	const failures: string[] = [];
	if (typeof ctx.setInterval !== "function") failures.push("  · ctx.setInterval：受管定时器（O5）");
	if (typeof ctx.sessionManager?.getBranch !== "function") failures.push("  · ctx.sessionManager.getBranch：审计读取（O17）");
	if (failures.length > 0) {
		throw new Error(`[ops-pi] 平台能力校验失败（session_start）：\n${failures.join("\n")}`);
	}
}
