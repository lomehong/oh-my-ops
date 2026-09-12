import { describe, expect, test } from "bun:test";
import { assertPlatformAtLoad, assertPlatformAtSessionStart, platformChecks } from "../src/platform.ts";

/** 模拟 omp 注入面：具备全部必需能力 */
function fullPi(): Record<string, unknown> {
	return {
		zod: { object: () => ({}), string: () => ({}) },
		appendEntry: () => {},
		getAllTools: () => [],
		setActiveTools: () => {},
		registerTool: () => {},
	};
}

/** 模拟 ctx：session_start 侧能力 */
function fullCtx(): Record<string, unknown> {
	return { setInterval: () => ({}), sessionManager: { getBranch: () => [] } };
}

describe("assertPlatformAtLoad（缺失 → 硬失败）", () => {
	test("全部能力就绪 → 通过", () => {
		const pi = fullPi() as never;
		expect(() => assertPlatformAtLoad(pi)).not.toThrow();
	});

	test("缺 pi.zod → 抛错并点名缺失项", () => {
		const pi = fullPi();
		delete pi.zod;
		expect(() => assertPlatformAtLoad(pi as never)).toThrow(/pi\.zod/);
	});

	test("缺 pi.appendEntry → 抛错", () => {
		const pi = fullPi();
		delete pi.appendEntry;
		expect(() => assertPlatformAtLoad(pi as never)).toThrow(/appendEntry/);
	});

	test("getAllTools/setActiveTools 缺失 → 抛错（O11 断言依赖）", () => {
		const pi = fullPi();
		delete pi.getAllTools;
		expect(() => assertPlatformAtLoad(pi as never)).toThrow(/getAllTools/);
	});

	test("platformChecks 覆盖审计与断言前置（appendEntry/getAllTools 在列）", () => {
		const checks = platformChecks(fullPi() as never).map((c) => c.name);
		expect(checks.some((name) => name.includes("appendEntry"))).toBe(true);
		expect(checks.some((name) => name.includes("getAllTools"))).toBe(true);
	});
});

describe("assertPlatformAtSessionStart（ctx 侧能力）", () => {
	test("就绪 → 通过", () => {
		const ctx = fullCtx() as never;
		expect(() => assertPlatformAtSessionStart(ctx)).not.toThrow();
	});

	test("缺 ctx.setInterval → 抛错（O5）", () => {
		const ctx: Record<string, unknown> = { sessionManager: { getBranch: () => [] } };
		expect(() => assertPlatformAtSessionStart(ctx as never)).toThrow(/setInterval/);
	});

	test("缺 getBranch → 抛错（O17）", () => {
		const ctx = { setInterval: () => ({}) };
		expect(() => assertPlatformAtSessionStart(ctx as never)).toThrow(/getBranch/);
	});
});
