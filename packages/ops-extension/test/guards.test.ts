import { describe, expect, test } from "bun:test";
import { DefaultDenyPolicy, StaticTokenStore, LOCAL_HOST, READ } from "@ops-pi/core";
import type { TargetRule } from "@ops-pi/core";
import { registerOpsTool, TIER_TABLE } from "../src/approvals.ts";
import {
	assertToolRegistryIntegrity,
	assertAuthorized,
	checkToolRegistry,
	onToolCall,
	standardAuthzView,
} from "../src/guards.ts";
import type { AuthorizationView } from "../src/guards.ts";

// ── 桩：模拟 omp 注入面（工具注册表）──
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

/** 最小合规定义（过 registerOpsTool 的 fail-fast 校验），用于填充注册清单 */
function minimalDef(name: string): RegisteredTool & { loadMode: string; execute: () => Promise<unknown> } {
	return {
		name,
		label: name,
		description: "test stub",
		loadMode: "essential",
		approval: READ,
		parameters: {},
		execute: async () => ({ content: [] }),
	} as RegisteredTool & { loadMode: string; execute: () => Promise<unknown> };
}

function registerAll(pi: FakePi): void {
	for (const name of Object.keys(TIER_TABLE)) {
		registerOpsTool(pi as never, minimalDef(name) as never);
	}
}

// ── 授权视图：policyRequestFor 把一切工具映射到本机（LOCAL_HOST），规则须以 @local 表达 ──
const RULES: readonly TargetRule[] = [
	{ host: LOCAL_HOST, services: ["nginx"], actions: ["restart", "status"] },
	{ host: LOCAL_HOST, actions: ["shell"] },
	{ host: LOCAL_HOST, services: ["core-db"], production: true },
];

function view(tokens: ReadonlyArray<{ id: string; scope: string; issuedBy: string; issuedAt: string }> = []): AuthorizationView {
	return standardAuthzView(new DefaultDenyPolicy(RULES), new StaticTokenStore(tokens));
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
		registerAll(pi);
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
	});

	test("★ ops_* 被共载扩展覆盖（O11 last-wins 劫持）→ 自愈重注册后通过", () => {
		const pi = new FakePi();
		registerAll(pi);
		// 模拟另一个扩展后注册同名工具（last-wins），sourceInfo 指向本扩展之外
		pi.registered["ops_shell_exec"] = { ...pi.registered["ops_shell_exec"]!, sourceInfo: { path: "/other-ext/evil.ts" } };
		expect(checkToolRegistry(pi as never).hijacked).toEqual(["ops_shell_exec"]);
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
		// 自愈后该工具回到本扩展定义（sourceInfo 缺失 → 宿主默认归属本扩展）
		expect(pi.registered["ops_shell_exec"]?.sourceInfo).toBeUndefined();
	});

	test("自愈失败（宿主拒绝重注册）→ 复检不过 → 抛错拒绝运行", () => {
		// 先确保模块级注册清单里有定义可自愈（不依赖测试顺序）
		registerAll(new FakePi());
		class HostilePi extends FakePi {
			override registerTool(): void {
				throw new Error("host rejected");
			}
		}
		const pi = new HostilePi();
		pi.registered["ops_shell_exec"] = { name: "ops_shell_exec", sourceInfo: { path: "/other-ext/evil.ts" } };

		// 旧版宿主（17.x）sourceInfo 渲染为占位符 → 无法判定，不误报
		{
			const pi = new FakePi();
			registerAll(pi);
			pi.registered["ops_file_read"] = { name: "ops_file_read", sourceInfo: { path: "<extension:ops_file_read>" } };
			const report = checkToolRegistry(pi as never);
			expect(report.hijacked).toEqual([]);
			expect(report.failures).toEqual([]);
		}

		expect(() => assertToolRegistryIntegrity(pi as never)).toThrow(/工具清单断言失败/);
	});

	test("冒名的 ops_ 工具（他人注册的 ops_ 前缀）→ 抛错", () => {
		const pi = new FakePi();
		registerAll(pi);
		pi.registered["ops_evil"] = { name: "ops_evil", sourceInfo: { path: "/other-ext/evil.ts" } };
		expect(() => assertToolRegistryIntegrity(pi as never)).toThrow(/冒名/);
	});

	test("共载的 yuyi_*/yufu_* 工具合法存在 → 不触发失败（前缀互斥，§7.6）", () => {
		const pi = new FakePi();
		registerAll(pi);
		pi.registered["yuyi_send"] = { name: "yuyi_send", sourceInfo: { path: "yuyi.ts" } };
		pi.registered["yufu_auth"] = { name: "yufu_auth", sourceInfo: { path: "yuyi.ts" } };
		expect(() => assertToolRegistryIntegrity(pi as never)).not.toThrow();
	});
});

describe("onToolCall（①-b 兜底 + ② 内容硬拒，模式无关）", () => {
	test("内容硬拒在无人值守下依然生效（② 与模式无关）", () => {
		const decision = onToolCall(
			{ toolName: "ops_shell_exec", input: { command: "rm -rf /" } },
			view(), { hasUI: false },
		);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toEqual("[ERR_POLICY] 命中灾难性命令模式，已拒绝");
	});

	test("无人值守 + 未预授权 exec → ①-b 拒（X10 复现）", () => {
		const decision = onToolCall(
			{ toolName: "ops_service", input: { service: "redis", action: "restart" } },
			view(), { hasUI: false },
		);
		expect(decision).toMatchObject({ block: true, reason: "[ERR_PERMISSION] guard-unattended" });
	});

	test("无人值守 + 预授权（@local 白名单）→ 放行（A2 路径）", () => {
		const decision = onToolCall(
			{ toolName: "ops_service", input: { service: "nginx", action: "restart" } },
			view(), { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});

	test("★ 无人值守 + Owner 批准令牌 → 放行（明示批准 > 默认拒绝）", () => {
		const decision = onToolCall(
			{ toolName: "ops_service", input: { service: "redis", action: "restart" } },
			view([{ id: "T-1", scope: `${LOCAL_HOST}/redis/restart`, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }]),
			{ hasUI: false },
		);
		expect(decision).toBeUndefined();
	});

	test("生产目标 → ①-b 拒（guard-production，RR-1 收敛）", () => {
		const decision = onToolCall(
			{ toolName: "ops_service", input: { service: "core-db", action: "restart" } },
			view(), { hasUI: false },
		);
		expect(decision).toMatchObject({ block: true, reason: "[ERR_PERMISSION] guard-production" });
	});

	test("交互态交平台审批（①-a），兜底层不拦", () => {
		const decision = onToolCall(
			{ toolName: "ops_service", input: { service: "redis", action: "restart" } },
			view(), { hasUI: true },
		);
		expect(decision).toBeUndefined();
	});

	test("read 档免检（A1 只读巡检路径）", () => {
		const decision = onToolCall(
			{ toolName: "ops_file_read", input: { path: "/etc/hosts" } },
			view(), { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});

	test("非 ops_ 工具不介入（不越权管平台/其他扩展）", () => {
		const decision = onToolCall(
			{ toolName: "bash", input: { command: "rm -rf /" } },
			view(), { hasUI: false },
		);
		expect(decision).toBeUndefined();
	});
});

describe("assertAuthorized（③ execute 权威复核，X19 场景）", () => {
	test("预授权 shell + 合法命令 → 放行，返回授权来源 policy", () => {
		expect(assertAuthorized("ops_shell_exec", { command: "uptime" }, view())).toBe("policy");
	});

	test("read 档 → 免授权判定，返回 read", () => {
		expect(assertAuthorized("ops_file_read", { path: "/etc/hosts" }, view())).toBe("read");
	});

	test("★ 仅 ③ 能拦：预授权目标的 command 被改写为 rm -rf /（X19 复现）", () => {
		// ①-b 对「原 command」放行、①-a 对「host/service」放行——唯一能拦的是 execute 侧重算
		expect(() =>
			assertAuthorized("ops_service", { service: "nginx", action: "restart", command: "rm -rf /" }, view()),
		).toThrow(/POLICY_DENIED|灾难性命令/);
	});

	test("execute 复核对未授权目标拒绝（防 approval 被伪造 input 骗过）", () => {
		expect(() =>
			assertAuthorized("ops_service", { service: "redis", action: "restart" }, view()),
		).toThrow(/未获预授权/);
	});

	test("execute 复核对生产目标拒绝（无令牌 → guard-production）", () => {
		expect(() =>
			assertAuthorized("ops_service", { service: "core-db", action: "restart" }, view()),
		).toThrow(/ERR_PERMISSION.*guard-production/);
	});

	test("★ 令牌路径 → 返回 token，且单次批准（消费后同请求不再放行）", () => {
		const authz = view([{ id: "T-1", scope: `${LOCAL_HOST}/redis/restart`, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }]);
		expect(assertAuthorized("ops_service", { service: "redis", action: "restart" }, authz)).toBe("token");
		// 消费后：令牌失效且无 policy 白名单 → 拒
		expect(() =>
			assertAuthorized("ops_service", { service: "redis", action: "restart" }, authz),
		).toThrow(/未获预授权/);
	});
});
