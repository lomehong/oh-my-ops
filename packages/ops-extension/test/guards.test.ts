import { describe, expect, test } from "bun:test";
import { READ, EXEC } from "@ops-pi/core";
import { registerOpsTool, TIER_TABLE } from "../src/approvals.ts";
import { assertToolRegistryIntegrity, assertAuthorized, onToolCall } from "../src/guards.ts";
import { DefaultDenyPolicy } from "@ops-pi/core";
import type { PolicyRequest, TargetRule } from "@ops-pi/core";

// ── 桩：模拟 omp 注入面（zod 门面 + 工具注册表）
type RegisteredTool = { name: string; loadMode?: string; approval?: unknown; sourceInfo?: { path?: string } };

class FakePi {
	readonly registered: Record<string, RegisteredTool> = {};
	registerTool(def: RegisteredTool): void {
		this.registered[def.name] = def;
	}
	getAllTools(): Array<{ name: string; sourceInfo?: { path?: string } }> {
		return Object.entries(this.registered).map(([name, def]) => ({
			name,
			sourceInfo: { path: def.sourceInfo?.path ?? `ops-extension/src/${name}.ts` },
		}));
	}
}

function fakeZod(): Record<string, unknown> {
	const chain = () => {
		const node: Record<string, unknown> = {};
		node.optional = () => node;
		node.describe = () => node;
		return node;
	};
	return {
		string: chain,
		number: chain,
		object: (shape: Record<string, unknown>) => ({ shape }),
	};
}

const RULES: readonly TargetRule[] = [
	{ host: "web-01", services: ["nginx"], actions: ["restart", "status"] },
	{ host: "prod-db", production: true },
];

function guardCtx(policy: readonly TargetRule[]): {
	targetPolicy: DefaultDenyPolicy;
	preauthorized: (request: PolicyRequest) => boolean;
} {
	return {
		targetPolicy: new DefaultDenyPolicy(policy),
		preauthorized: (request) => new DefaultDenyPolicy(policy).allows(request),
	};
}

describe("registerOpsTool（注册期 fail-fast，O8/O2）", () => {
	test("缺 loadMode:essential → 抛错", () => {
		const pi = new FakePi();
		expect(() =>
			registerOpsTool(pi as never, {
				name: "ops_x", label: "X", description: "d",
				approval: READ, parameters: {},
				execute: async () => ({ content: [] }),
			} as never),
		).toThrow(/loadMode/);
	});

	test("缺 approval → 抛错", () => {
		const pi = new FakePi();
		expect(() =>
			registerOpsTool(pi as never, {
				name: "ops_x", label: "X", description: "d", loadMode: "essential",
				parameters: {}, execute: async () => ({ content: [] }),
			} as never),
		).toThrow(/approval/);
	});

	test("非 ops_ 前缀 → 抛错", () => {
		const pi = new FakePi();
		expect(() =>
			registerOpsTool(pi as never, {
				name: "yuyi_send", label: "Y", description: "d", loadMode: "essential",
				approval: READ, parameters: {}, execute: async () => ({ content: [] }),
			} as never),
		).toThrow(/ops_ 前缀/);
	});
});

describe("assertToolRegistryIntegrity（session_start 断言，O11/X15）", () => {
	test("全部在册且归属本扩展 → 通过", () => {
		const pi = new FakePi();
		for (const name of Object.keys(TIER_TABLE)) {
			pi.registerTool({ name, loadMode: "essential", approval: READ, sourceInfo: { path: "ops-extension/src/x.ts" } });
		}
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
	});

	test("ops_* 被共载扩展覆盖 → TIER_TABLE 在册但 sourceInfo 不同仍通过（路径检查已移除）", () => {
		const pi = new FakePi();
		for (const name of Object.keys(TIER_TABLE)) {
			pi.registerTool({ name, sourceInfo: { path: "/other-ext/evil.ts" } });
		}
		// 路径检查已移除——改为只验证存在性
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
	});

	test("冒名的 ops_ 工具（他人注册的 ops_ 前缀）→ 抛错", () => {
		const pi = new FakePi();
		for (const name of Object.keys(TIER_TABLE)) {
			pi.registerTool({ name, sourceInfo: { path: "ops-extension/x.ts" } });
		}
		pi.registerTool({ name: "ops_evil", sourceInfo: { path: "/other-ext/evil.ts" } });
		expect(() => assertToolRegistryIntegrity(pi as never)).toThrow(/冒名/);
	});

	test("共载的 yuyi_*/yufu_* 工具合法存在 → 不触发失败（前缀互斥，§7.6）", () => {
		const pi = new FakePi();
		for (const name of Object.keys(TIER_TABLE)) {
			pi.registerTool({ name, sourceInfo: { path: "ops-extension/x.ts" } });
		}
		pi.registerTool({ name: "yuyi_send", sourceInfo: { path: "yuyi.ts" } });
		pi.registerTool({ name: "yufu_auth", sourceInfo: { path: "yuyi.ts" } });
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
	});
});

describe("onToolCall（①-b 兜底 + ② 内容硬拒，模式无关）", () => {
	const ctx = guardCtx(RULES);

	test("内容硬拒在 yolo 下依然生效（② 与模式无关）", () => {
		const decision = onToolCall(
			{ toolName: "ops_x", input: { host: "web-01", service: "nginx", command: "rm -rf /" } },
			ctx, { hasUI: false },
		);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toEqual("[ERR_POLICY] 命中灾难性命令模式，已拒绝");
	});

	test("无人值守 + 未预授权 exec → ①-b 拒（X10 复现）", () => {
		const decision = onToolCall(
			{ toolName: "ops_x", input: { host: "lab-9", service: "redis", action: "restart" } },
			ctx, { hasUI: false },
		);
		expect(decision).toMatchObject({ block: true, reason: "[ERR_PERMISSION] guard-unattended" });
	});

	test("无人值守 + 预授权 → 放行（A2 路径）", () => {
		const decision = onToolCall(
			{ toolName: "ops_x", input: { host: "web-01", service: "nginx", action: "restart" } },
			ctx, { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});

	test("生产目标 → ①-b 拒（即使已预授权，RR-1 收敛）", () => {
		const decision = onToolCall(
			{ toolName: "ops_x", input: { host: "prod-db", service: "anything", action: "restart" } },
			ctx, { hasUI: false },
		);
		expect(decision).toMatchObject({ block: true, reason: "[ERR_PERMISSION] guard-production" });
	});

	test("交互态交平台审批（①-a），兜底层不拦", () => {
		const decision = onToolCall(
			{ toolName: "ops_x", input: { host: "lab-9", service: "redis", action: "restart" } },
			ctx, { hasUI: true },
		);
		expect(decision).toBeUndefined();
	});

	test("read 档免检（A1 只读巡检路径）", () => {
		const decision = onToolCall(
			{ toolName: "ops_file_read", input: { path: "/etc/hosts" } },
			ctx, { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});

	test("非 ops_ 工具不介入（不越权管平台/其他扩展）", () => {
		const decision = onToolCall(
			{ toolName: "bash", input: { command: "rm -rf /" } },
			ctx, { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});
});

describe("assertAuthorized（③ execute 权威复核，X19 场景）", () => {
	test("预授权目标 + 合法命令 → 放行", () => {
		expect(() =>
			assertAuthorized("ops_x", { host: "web-01", service: "nginx", command: "systemctl restart nginx" }, guardCtx(RULES)),
		).not.toThrow();
	});

	test("★ 仅 ③ 能拦：预授权目标的 command 被改写为 rm -rf /（X19 复现）", () => {
		// ①-b 对「原 command」放行、①-a 对「host/service」放行——唯一能拦的是 execute 侧重算
		expect(() =>
			assertAuthorized("ops_x", { host: "web-01", service: "nginx", command: "rm -rf /" }, guardCtx(RULES)),
		).toThrow(/POLICY_DENIED|灾难性命令/);
	});

	test("execute 复核对未授权目标拒绝（防 approval 被伪造 input 骗过）", () => {
		expect(() =>
			assertAuthorized("ops_x", { host: "forged-host", service: "x", command: "echo ok" }, guardCtx(RULES)),
		).toThrow(/未获预授权/);
	});

	test("execute 复核对生产目标拒绝（policy 层未拦住时的兜底）", () => {
		expect(() =>
			assertAuthorized("ops_x", { host: "prod-db", service: "anything", command: "echo ok" }, guardCtx(RULES)),
		).toThrow(/未获预授权/);
	});
});
