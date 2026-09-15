import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintPolicySource, lintTokenSource, summarizeLint } from "../src/policy-lint.ts";
import type { LintFinding } from "../src/policy-lint.ts";
import { DefaultDenyPolicy, LOCAL_HOST, traceRules } from "../src/policy.ts";
import { traceTokens } from "../src/tokens.ts";

const NOW = Date.parse("2026-09-15T00:00:00Z");
const ACTIONS = {
	serviceless: ["shell", "file-write", "kb-write"],
	serviceBound: ["start", "stop", "restart", "status", "exec"],
};
const has = (fs: readonly LintFinding[], level: LintFinding["level"], needle: string) =>
	fs.some((f) => f.level === level && f.message.includes(needle));
const policy = (targets: unknown) => lintPolicySource(JSON.stringify({ targets }), { now: NOW, actions: ACTIONS });

describe("lintPolicySource：把运行时的静默降级显式化", () => {
	it("文件缺失 → warn；JSON 损坏 → error 并说明运行时按全拒处理", () => {
		assert.ok(has(lintPolicySource(undefined, { now: NOW }), "warn", "不存在"));
		const broken = lintPolicySource("{ targets: [ }", { now: NOW });
		assert.ok(has(broken, "error", "解析失败"));
		assert.equal(summarizeLint(broken).errors, 1);
	});

	it("字段名打错（action / service / expires）→ warn 并给出正确字段与放宽后果", () => {
		const fs = policy([{ host: LOCAL_HOST, service: ["nginx"], action: ["restart"], expires: "2027-01-01T00:00:00Z" }]);
		assert.ok(has(fs, "warn", '未知字段 "action"'));
		assert.ok(has(fs, "warn", "全动作通配"));
		assert.ok(has(fs, "warn", '未知字段 "service"'));
		assert.ok(has(fs, "warn", '未知字段 "expires"'));
		// 三个字段都被忽略后，本条实际是全权规则
		assert.ok(has(fs, "warn", "全权规则"));
	});

	it("production 写成字符串 → error（会从生产标记变成放行规则）", () => {
		const fs = policy([{ host: "prod-db", production: "true" }]);
		assert.ok(has(fs, "error", "production 须为布尔值"));
	});

	it("expiresAt 不可解析 → error（永久失效）；已过期 → warn；即将到期 → info", () => {
		const fs = policy([
			{ host: LOCAL_HOST, actions: ["shell"], expiresAt: "next week" },
			{ host: LOCAL_HOST, actions: ["file-write"], expiresAt: "2026-09-01T00:00:00Z" },
			{ host: LOCAL_HOST, actions: ["kb-write"], expiresAt: "2026-09-18T00:00:00Z" },
		]);
		assert.ok(has(fs, "error", "不可解析"));
		assert.ok(has(fs, "warn", "已过期"));
		assert.ok(has(fs, "info", "天内到期"));
	});

	it("host 非法 → error", () => {
		assert.ok(has(policy([{ host: "-oProxyCommand=x" }]), "error", "host 非法"));
		assert.ok(has(policy([{ services: ["nginx"] }]), "error", "host 缺失"));
	});

	it("死规则：未知 action / services 规则里的 serviceless action / 无 services 的 serviceBound action", () => {
		const fs = policy([
			{ host: LOCAL_HOST, actions: ["reboot"] },
			{ host: LOCAL_HOST, services: ["nginx"], actions: ["shell"] },
			{ host: LOCAL_HOST, actions: ["restart"] },
		]);
		assert.ok(has(fs, "warn", '未知 action "reboot"'));
		assert.ok(has(fs, "warn", '"shell" 无 service 维度'));
		assert.ok(has(fs, "warn", '"restart" 需要 service 维度'));
	});

	it("权限等级提示：全权规则与 shell 规则 → warn；生产标记规则不算放行", () => {
		const fs = policy([
			{ host: "web-01" },
			{ host: LOCAL_HOST, actions: ["shell"] },
			{ host: "prod-db", production: true },
		]);
		assert.ok(has(fs, "warn", "全权规则：覆盖 web-01"));
		assert.ok(has(fs, "warn", 'actions 含 "shell"'));
		assert.ok(!has(fs, "info", "没有生效的放行规则"));
	});

	it("只有生产标记/过期规则 → info 提示变更类全拒；重复规则 → info", () => {
		const fs = policy([
			{ host: "prod-db", production: true },
			{ host: LOCAL_HOST, actions: ["shell"], expiresAt: "2020-01-01T00:00:00Z" },
			{ host: "prod-db", production: true },
		]);
		assert.ok(has(fs, "info", "没有生效的放行规则"));
		assert.ok(has(fs, "info", "与 targets[0] 重复"));
	});

	it("干净策略：无 error/warn（仅 info 或空）", () => {
		const fs = policy([
			{ host: LOCAL_HOST, services: ["nginx"], actions: ["restart", "status"], expiresAt: "2027-12-31T23:59:59Z" },
			{ host: LOCAL_HOST, actions: ["file-write"], expiresAt: "2027-12-31T23:59:59Z" },
		]);
		assert.equal(summarizeLint(fs).errors, 0);
		assert.equal(summarizeLint(fs).warns, 0);
	});
});

describe("lintTokenSource", () => {
	const tokens = (list: unknown) => lintTokenSource(JSON.stringify({ tokens: list }), { now: NOW });
	it("缺字段 / scope 非法 / 段数超限 → error", () => {
		const fs = tokens([{ id: "T1", scope: "a/b/c/d", issuedAt: "2026-09-14T00:00:00Z" }]);
		assert.ok(has(fs, "error", "issuedBy 缺失"));
		assert.ok(has(fs, "error", "scope \"a/b/c/d\" 非法"));
	});
	it("已消费 → info 且不再报过期；永不过期 → warn；有效 → info", () => {
		const fs = tokens([
			{ id: "T1", scope: "@local/nginx/restart", issuedBy: "主人", issuedAt: "2026-09-14T00:00:00Z", consumedAt: "2026-09-14T01:00:00Z" },
			{ id: "T2", scope: "@local/nginx", issuedBy: "主人", issuedAt: "2026-09-14T00:00:00Z" },
			{ id: "T3", scope: "@local", issuedBy: "主人", issuedAt: "2026-09-14T00:00:00Z", expiresAt: "2026-09-16T00:00:00Z" },
		]);
		assert.ok(has(fs, "info", "已消费"));
		assert.ok(has(fs, "warn", "永不过期"));
		assert.ok(has(fs, "warn", 'scope "@local" 覆盖该主机全部操作'));
		assert.ok(has(fs, "info", "有效：scope=@local"));
	});
});

describe("traceRules / traceTokens：与 allows / find 语义一致的逐条投影", () => {
	const rules = [
		{ host: LOCAL_HOST, services: ["nginx"], actions: ["restart", "status"] },
		{ host: LOCAL_HOST, actions: ["shell"], expiresAt: "2020-01-01T00:00:00Z" },
		{ host: "prod-db", production: true },
		{ host: "web-01" },
	];
	const p = new DefaultDenyPolicy(rules);
	it("每条 covers 与 allows 一致；failedOn 指出首个失败维度", () => {
		for (const request of [
			{ host: LOCAL_HOST, service: "nginx", action: "restart" },
			{ host: LOCAL_HOST, action: "shell" },
			{ host: LOCAL_HOST, action: "file-write" },
			{ host: "prod-db", service: "postgres", action: "restart" },
			{ host: "web-01", action: "file-write" },
		]) {
			const traces = traceRules(rules, request, NOW);
			assert.equal(traces.some((t) => t.covers), p.allows(request), JSON.stringify(request));
			assert.equal(traces.some((t) => t.marks), p.isProduction(request), JSON.stringify(request));
		}
		const t = traceRules(rules, { host: LOCAL_HOST, action: "shell" }, NOW);
		assert.equal(t[0]?.failedOn, "service");
		assert.equal(t[1]?.failedOn, "expired");
		assert.equal(t[2]?.failedOn, "production");
		assert.equal(t[3]?.failedOn, "host");
	});
	it("令牌轨迹：consumed / expired / scope 不覆盖 各自可辨", () => {
		const base = { issuedBy: "主人", issuedAt: "2026-09-14T00:00:00Z" };
		const traces = traceTokens([
			{ id: "A", scope: "@local/nginx", ...base, consumedAt: "2026-09-14T01:00:00Z" },
			{ id: "B", scope: "@local/nginx", ...base, expiresAt: "2026-09-01T00:00:00Z" },
			{ id: "C", scope: "@local/redis", ...base },
			{ id: "D", scope: "@local", ...base },
		], { host: LOCAL_HOST, service: "nginx", action: "restart" }, NOW);
		assert.deepEqual(traces.map((t) => [t.covers, t.active, t.inactiveReason]), [
			[true, false, "consumed"], [true, false, "expired"], [false, true, undefined], [true, true, undefined],
		]);
	});
});
