import { describe, expect, test } from "bun:test";
import { DefaultDenyPolicy, StaticTokenStore, LOCAL_HOST, READ, EXEC } from "@ops-pi/core";
import type { TargetRule } from "@ops-pi/core";
import {
	TIER_TABLE,
	READ_ACTIONS,
	buildCapabilityLists,
	makeApprovalFactory,
	registerOpsTool,
	tierFor,
	requiresOwnerAuth,
	getRegisteredOpsToolDefs,
} from "../src/approvals.ts";
import { policyRequestFor } from "../src/request.ts";

// ── 桩（与 guards.test.ts 同构的最小宿主模拟）──
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

function registerAll(pi: FakePi): void {
	for (const name of Object.keys(TIER_TABLE)) {
		registerOpsTool(pi as never, {
			name, label: name, description: "test stub", loadMode: "essential",
			approval: READ, parameters: {}, execute: async () => ({ content: [] }),
		} as never);
	}
}

const RULES: readonly TargetRule[] = [
	{ host: LOCAL_HOST, services: ["nginx"], actions: ["restart", "status"] },
	{ host: LOCAL_HOST, actions: ["shell"] },
	{ host: LOCAL_HOST, services: ["core-db"], production: true },
];

const TOKENS = [{ id: "T-1", scope: `${LOCAL_HOST}/redis/restart`, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }];

describe("policyRequestFor（工具入参 → PolicyRequest 单一映射）", () => {
	test("ops_service：host 透传（P7 远程目标 → 策略按真实主机匹配）", () => {
		expect(policyRequestFor("ops_service", { service: "nginx", action: "restart", host: "web-01" }))
			.toEqual({ host: "web-01", service: "nginx", action: "restart" });
	});

	test("ops_shell_exec：action 固定 shell，command 进入请求", () => {
		expect(policyRequestFor("ops_shell_exec", { command: "uptime" }))
			.toEqual({ host: LOCAL_HOST, action: "shell", command: "uptime" });
	});

	test("ops_shell_script：script 字段映射为 command 维度", () => {
		expect(policyRequestFor("ops_shell_script", { script: "df -h" }))
			.toEqual({ host: LOCAL_HOST, action: "shell", command: "df -h" });
	});

	test("ops_docker_exec：容器名 → service，action=exec", () => {
		expect(policyRequestFor("ops_docker_exec", { container: "web", command: "sh" }))
			.toEqual({ host: LOCAL_HOST, service: "web", action: "exec", command: "sh" });
	});

	test("ops_docker_compose：projectDir → service，action 透传", () => {
		expect(policyRequestFor("ops_docker_compose", { projectDir: "/app", action: "up" }))
			.toEqual({ host: LOCAL_HOST, service: "/app", action: "up" });
	});

	test("ops_k8s_exec：pod → service，action=exec", () => {
		expect(policyRequestFor("ops_k8s_exec", { pod: "p1", command: "sh" }))
			.toEqual({ host: LOCAL_HOST, service: "p1", action: "exec", command: "sh" });
	});

	test("ops_k8s_rollout：kind/name → service 段（deployment/api）", () => {
		expect(policyRequestFor("ops_k8s_rollout", { kind: "deployment", name: "api", action: "restart" }))
			.toEqual({ host: LOCAL_HOST, service: "deployment/api", action: "restart" });
	});

	test("未登记工具 → host 透传（read 档在判定前短路，此映射仅供一致性）", () => {
		expect(policyRequestFor("ops_x", { host: "whatever" })).toEqual({ host: "whatever" });
		expect(policyRequestFor("ops_x", "not-an-object")).toEqual({ host: LOCAL_HOST });
	});
});

describe("makeApprovalFactory（①-a 审批层授权）", () => {
	const approval = makeApprovalFactory(new DefaultDenyPolicy(RULES), new StaticTokenStore(TOKENS));

	test("read 档 → 返回 READ（宿主自动放行）", () => {
		expect(approval("ops_file_read")({ path: "/etc/hosts" })).toBe(READ);
	});

	test("预授权命中 → policy:allow（任何模式放行，含无人值守）", () => {
		expect(approval("ops_shell_exec")({ command: "uptime" })).toEqual({
			tier: "exec", policy: "allow", reason: `命中预授权 ${LOCAL_HOST}/shell`,
		});
	});

	test("Owner 批准令牌 → policy:allow（明示批准 > 默认拒绝，覆盖生产标记）", () => {
		expect(approval("ops_service")({ service: "redis", action: "restart" })).toEqual({
			tier: "exec", policy: "allow", reason: "Owner 批准令牌 T-1",
		});
	});

	test("生产目标无令牌 → policy:deny（任何模式硬拒，X3/X8）", () => {
		expect(approval("ops_service")({ service: "core-db", action: "restart" })).toEqual({
			tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更（如需放行须 Owner 批准令牌）",
		});
	});

	test("其余 → 朴素档位（交平台审批；无人值守由 ①-b 兜底拒）", () => {
		expect(approval("ops_service")({ service: "redis" })).toEqual({ tier: "exec" });
	});

	test("★ 纯函数（X21）：宿主求值 3 次不消费令牌，③ 复核仍可走 token 放行", () => {
		const authz = makeApprovalFactory(new DefaultDenyPolicy(RULES), new StaticTokenStore(TOKENS));
		const fn = authz("ops_service");
		fn({ service: "redis", action: "restart" });
		fn({ service: "redis", action: "restart" });
		fn({ service: "redis", action: "restart" });
		// 若 approval 期间消费了令牌，这里将不再命中（令牌仍在）——验证交给 guards.test 的单次消费语义
		const still = authz("ops_service")({ service: "redis", action: "restart" });
		expect(still).toMatchObject({ policy: "allow", reason: "Owner 批准令牌 T-1" });
	});
});

describe("档位表与授权需求", () => {
	test("read 档不需要 Owner 授权；exec 档需要", () => {
		expect(requiresOwnerAuth("ops_file_read", {})).toBe(false);
		expect(requiresOwnerAuth("ops_shell_exec", { command: "uptime" })).toBe(true);
	});

	test("action 多态：status 为 read，restart 为 exec", () => {
		expect(tierFor("ops_service", { action: "status" })).toBe(READ);
		expect(tierFor("ops_service", { action: "restart" })).toBe(EXEC);
		expect(requiresOwnerAuth("ops_service", { action: "status" })).toBe(false);
		expect(requiresOwnerAuth("ops_service", { action: "restart" })).toBe(true);
	});

	test("未登记工具按最严档 EXEC", () => {
		expect(tierFor("ops_unknown", {})).toBe(EXEC);
		expect(requiresOwnerAuth("ops_unknown", {})).toBe(true);
	});
});

describe("buildCapabilityLists（提示词 = TIER_TABLE 零漂移）", () => {
	const { read, exec } = buildCapabilityLists();
	const all = [...read, ...exec];

	test("TIER_TABLE 声明的每个工具都出现在能力清单中（提示词不宣告未实现工具）", () => {
		for (const name of Object.keys(TIER_TABLE)) {
			expect(all.some((entry) => entry === name || entry.startsWith(`${name}(`))).toBe(true);
		}
	});

	test("能力清单不含 TIER_TABLE 之外的 ops_ 工具", () => {
		for (const entry of all) {
			const name = entry.includes("(") ? entry.slice(0, entry.indexOf("(")) : entry;
			expect(Object.hasOwn(TIER_TABLE, name)).toBe(true);
		}
	});

	test("read/exec 无重复：一个工具只归属一档（action 多态除外，其以注解形式双列）", () => {
		const plainRead = read.filter((x) => !x.includes("("));
		const plainExec = exec.filter((x) => !x.includes("("));
		for (const name of plainRead) expect(plainExec).not.toContain(name);
	});

	test("action 多态工具按 READ_ACTIONS 双列且档位一致", () => {
		for (const [name, actions] of Object.entries(READ_ACTIONS)) {
			const readEntry = read.find((x) => x.startsWith(`${name}(`));
			const execEntry = exec.find((x) => x.startsWith(`${name}(`));
			expect(readEntry).not.toBeUndefined();
			expect(execEntry).not.toBeUndefined();
			for (const action of actions) {
				expect(tierFor(name, { action })).toBe(READ); // 声明的 read 动作确实为 read 档
			}
		}
	});

	test("registry 对账：注册清单键集 === TIER_TABLE 键集（清单/提示词/注册三方一致）", () => {
		const pi = new FakePi();
		registerAll(pi);
		expect([...getRegisteredOpsToolDefs().keys()].sort()).toEqual(Object.keys(TIER_TABLE).sort());
	});
});
