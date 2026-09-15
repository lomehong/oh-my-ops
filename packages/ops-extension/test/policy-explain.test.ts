import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultDenyPolicy, LOCAL_HOST, READ, StaticTokenStore } from "@ops-pi/core";
import { POLICY_ACTIONS, policyRequestFor } from "../src/request.ts";
import { explainAuthorization, formatExplain, formatLint, parseExplainArgs, runPolicyLint } from "../src/policy-explain.ts";
import { runPolicyCli } from "../src/policy-cli.ts";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const RULES = [
	{ host: LOCAL_HOST, services: ["nginx"], actions: ["restart", "status"] },
	{ host: LOCAL_HOST, actions: ["shell"], expiresAt: "2020-01-01T00:00:00Z" },
	{ host: "prod-db", production: true },
];
const TOKENS = [{ id: "T-1", scope: "prod-db/postgres/restart", issuedBy: "主人", issuedAt: "2026-09-14T00:00:00Z" }];
const view = { targetPolicy: new DefaultDenyPolicy(RULES), tokens: new StaticTokenStore(TOKENS) };

describe("parseExplainArgs", () => {
	test("工具名 + key=value；引号内空白不切分", () => {
		const p = parseExplainArgs(`ops_shell_exec host=web-01 command="ls -la /tmp" note='a b'`);
		expect(p).toEqual({ ok: true, tool: "ops_shell_exec", input: { host: "web-01", command: "ls -la /tmp", note: "a b" } });
	});
	test("缺工具名 / 非 ops_ 前缀 / 非 k=v → 明确用法错误", () => {
		expect(parseExplainArgs("").ok).toBe(false);
		expect(parseExplainArgs("bash x=1").ok).toBe(false);
		expect(parseExplainArgs("ops_service nginx").ok).toBe(false);
	});
});

describe("explainAuthorization：与 ①-a/③ 同源的 dry-run", () => {
	test("policy 命中 → allowed/policy，轨迹标出放行规则与各条失败维度", () => {
		const r = explainAuthorization(view, "ops_service", { service: "nginx", action: "restart" }, NOW);
		expect(r.verdict).toEqual({ allowed: true, source: "policy" });
		expect(r.rules.map((t) => t.covers)).toEqual([true, false, false]);
		expect(r.rules[1]?.failedOn).toBe("expired");
		expect(r.rules[2]?.failedOn).toBe("production");
		expect(formatExplain(r)).toContain("✓ 放行（来源 policy）");
	});
	test("read 档 → 不做授权判定，说明宿主自动放行", () => {
		const r = explainAuthorization(view, "ops_service", { service: "nginx", action: "status" }, NOW);
		expect(r.tier).toBe(READ);
		expect(r.verdict).toBeUndefined();
		expect(formatExplain(r)).toContain("read 档免授权");
	});
	test("生产目标 + 令牌命中 → token 放行；无令牌 → guard-production", () => {
		const hit = explainAuthorization(view, "ops_service", { host: "prod-db", service: "postgres", action: "restart" }, NOW);
		expect(hit.verdict).toEqual({ allowed: true, source: "token", tokenId: "T-1" });
		expect(hit.tokens[0]).toMatchObject({ covers: true, active: true });
		const miss = explainAuthorization(view, "ops_service", { host: "prod-db", service: "postgres", action: "stop" }, NOW);
		expect(miss.verdict).toMatchObject({ allowed: false, reason: "guard-production" });
		expect(formatExplain(miss)).toContain("仅 Owner 批准令牌可放行");
	});
	test("内容硬拒：命中即报，且注明优先于授权结论", () => {
		const r = explainAuthorization(view, "ops_shell_exec", { command: "rm -rf /" }, NOW);
		expect(r.contentGuard).not.toBeNull();
		expect(formatExplain(r)).toContain("② 内容硬拒：✗ 命中");
		expect(formatExplain(r)).toContain("实际结果 = 拒绝");
	});
	test("未登记工具 → registered=false，不进入判定", () => {
		const r = explainAuthorization(view, "ops_nope", {}, NOW);
		expect(r.registered).toBe(false);
		expect(formatExplain(r)).toContain("未登记工具");
	});
	test("dry-run 不消费令牌", () => {
		explainAuthorization(view, "ops_service", { host: "prod-db", service: "postgres", action: "restart" }, NOW);
		expect(view.tokens.find({ host: "prod-db", service: "postgres", action: "restart" }).valid).toBe(true);
	});
});

describe("POLICY_ACTIONS 词表与 policyRequestFor 同源", () => {
	test("每个显式 action 都在词表中，且 service 维度归类正确", () => {
		const samples: Array<[string, Record<string, string>]> = [
			["ops_service", { service: "nginx", action: "restart" }],
			["ops_shell_exec", { command: "id" }],
			["ops_docker_exec", { container: "c", command: "id" }],
			["ops_docker_compose", { projectDir: "/srv", action: "up" }],
			["ops_k8s_rollout", { kind: "deployment", name: "api", action: "undo" }],
			["ops_file_write", {}], ["ops_vault_store", {}], ["ops_vault_rekey", {}], ["ops_kb_save", {}], ["ops_kb_sync", {}],
		];
		for (const [tool, input] of samples) {
			const req = policyRequestFor(tool, input);
			const action = req.action as string;
			const list = req.service === undefined ? POLICY_ACTIONS.serviceless : POLICY_ACTIONS.serviceBound;
			expect(list.includes(action) ? tool : `${tool}: action ${action} 归类错误`).toBe(tool);
		}
	});
});

describe("lint + CLI（真实文件）", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-policy-cli-"));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	const policyPath = path.join(dir, "policy.json");
	const tokenPath = path.join(dir, "approval-token.json");
	const io = () => {
		const out: string[] = [], err: string[] = [];
		return { out: (t: string) => out.push(t), err: (t: string) => err.push(t), text: () => out.join("\n"), errText: () => err.join("\n") };
	};

	test("lint：打错字段的策略 → 警告；损坏文件 → 退出码 1", () => {
		fs.writeFileSync(policyPath, JSON.stringify({ targets: [{ host: LOCAL_HOST, action: ["shell"] }] }));
		const report = runPolicyLint(policyPath, tokenPath, NOW);
		expect(report.summary.warns).toBeGreaterThan(0);
		expect(formatLint(report)).toContain('未知字段 "action"');
		const ok = io();
		expect(runPolicyCli(["lint", "--policy", policyPath, "--token", tokenPath], {}, ok)).toBe(0);
		fs.writeFileSync(policyPath, "{ broken");
		const bad = io();
		expect(runPolicyCli(["lint"], { OMO_POLICY_PATH: policyPath, OMO_TOKEN_PATH: tokenPath }, bad)).toBe(1);
		expect(bad.text()).toContain("解析失败");
	});

	test("explain：放行 → 0；拒绝 → 2；用法错误 → 64；缺路径 → 64", () => {
		fs.writeFileSync(policyPath, JSON.stringify({ targets: RULES }));
		const env = { OMO_POLICY_PATH: policyPath, OMO_TOKEN_PATH: tokenPath };
		const allow = io();
		expect(runPolicyCli(["explain", "ops_service", "service=nginx", "action=restart"], env, allow)).toBe(0);
		expect(allow.text()).toContain("✓ 放行");
		const deny = io();
		expect(runPolicyCli(["explain", "ops_file_write", "path=/etc/x"], env, deny)).toBe(2);
		expect(deny.text()).toContain("✗ 拒绝（guard-unattended）");
		expect(runPolicyCli(["explain"], env, io())).toBe(64);
		expect(runPolicyCli(["bogus"], env, io())).toBe(64);
		expect(runPolicyCli(["lint"], {}, io())).toBe(64);
	});
});
