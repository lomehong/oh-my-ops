import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpsError } from "../src/errors.ts";
import { DefaultDenyPolicy, loadTargetPolicy } from "../src/policy.ts";
import type { TargetRule } from "../src/policy.ts";
import { loadTokenStore } from "../src/tokens.ts";
import { createAuthorizedExec, needsOwnerAuth, tierOf, READ, EXEC } from "../src/approvals.ts";

const RULES: readonly TargetRule[] = [
	{ host: "web-01", services: ["nginx"], actions: ["restart", "status"], production: false },
	{ host: "prod-db", production: true },
];

const policy = new DefaultDenyPolicy(RULES);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-approvals-"));
const tokenPath = path.join(tmpDir, "approval-token.json");
fs.writeFileSync(tokenPath, JSON.stringify({
	tokens: [{ id: "T-9", scope: "prod-db/postgres/restart", issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }],
}));
const tokens = loadTokenStore(tokenPath);
const authorizedExec = createAuthorizedExec(policy, tokens);

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe("TargetPolicy（第③层 defaultDeny）", () => {
	it("未配置 = 全拒（保守侧）", () => {
		const none = loadTargetPolicy(path.join(tmpDir, "no-such-policy.json"));
		assert.equal(none.isConfigured, false);
		assert.equal(none.allows({ host: "web-01", service: "nginx" }), false);
		assert.throws(() => none.check({ host: "web-01" }), OpsError);
	});

	it("目标级预授权：主机+服务命中才放行", () => {
		assert.equal(policy.allows({ host: "web-01", service: "nginx" }), true);
		assert.equal(policy.allows({ host: "web-01", service: "postgres" }), false);
		assert.equal(policy.allows({ host: "web-02", service: "nginx" }), false);
	});

	it("action 维度：允许的动作才放行", () => {
		assert.equal(policy.allows({ host: "web-01", service: "nginx", action: "restart" }), true);
		assert.equal(policy.allows({ host: "web-01", service: "nginx", action: "stop" }), false);
	});

	it("production 规则只做标记，本身不授予放行", () => {
		assert.equal(policy.allows({ host: "prod-db", service: "anything" }), false);
		assert.equal(policy.allows({ host: "prod-db", action: "restart" }), false);
		assert.equal(policy.allows({ host: "prod-db" }), false);
	});

	it("生产目标识别", () => {
		assert.equal(policy.isProduction({ host: "prod-db" }), true);
		assert.equal(policy.isProduction({ host: "web-01" }), false);
	});

	it("过期规则失效（expiresAt）", () => {
		const expired = new DefaultDenyPolicy([{ host: "old-host", expiresAt: "2020-01-01T00:00:00Z" }]);
		assert.equal(expired.allows({ host: "old-host" }), false);
	});
});

describe("authorizedExec（纯函数：宿主求值 3 次，必须无副作用）", () => {
	it("预授权命中 → policy:allow（任何模式放行）", () => {
		const decision = authorizedExec({ host: "web-01", service: "nginx", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "allow", reason: "命中预授权 web-01/nginx" });
	});

	it("生产目标（无令牌）→ policy:deny（任何模式硬拒）", () => {
		const decision = authorizedExec({ host: "prod-db", service: "redis", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更" });
	});

	it("Owner 令牌优先于生产 blanket-deny（明示批准 > 默认拒绝）", () => {
		const decision = authorizedExec({ host: "prod-db", service: "postgres", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "allow", reason: "Owner 批准令牌 T-9" });
	});

	it("未授权 → 朴素档位（交平台审批；无人值守由 ①-b 拒）", () => {
		const decision = authorizedExec({ host: "lab-9", service: "redis", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec" });
	});

	it("纯函数：同输入同输出", () => {
		const args = { host: "web-01", service: "nginx" };
		assert.deepStrictEqual(authorizedExec(args), authorizedExec(args));
	});
});

describe("档位判定", () => {
	const TABLE = {
		ops_file_read: READ,
		ops_service: (args: unknown) => {
			const action = typeof args === "object" && args !== null && "action" in args
				? (args as Record<string, unknown>).action
				: undefined;
			return action === "status" ? READ : EXEC;
		},
	};

	it("未登记工具按最严档 EXEC", () => {
		assert.equal(tierOf("ops_unknown", {}, TABLE), EXEC);
		assert.equal(needsOwnerAuth("ops_unknown", {}, TABLE), true);
	});

	it("read 档不需要 Owner 授权", () => {
		assert.equal(tierOf("ops_file_read", {}, TABLE), READ);
		assert.equal(needsOwnerAuth("ops_file_read", {}, TABLE), false);
	});

	it("action 多态：status 为 read，restart 为 exec", () => {
		assert.equal(tierOf("ops_service", { action: "status" }, TABLE), READ);
		assert.equal(tierOf("ops_service", { action: "restart" }, TABLE), EXEC);
		assert.equal(needsOwnerAuth("ops_service", { action: "status" }, TABLE), false);
		assert.equal(needsOwnerAuth("ops_service", { action: "restart" }, TABLE), true);
	});
});

describe("loadTargetPolicy 异常输入", () => {
	it("非法 JSON → 全拒而非崩溃", () => {
		const badPath = path.join(tmpDir, "bad-policy.json");
		fs.writeFileSync(badPath, "{ not json");
		const bad = loadTargetPolicy(badPath);
		assert.equal(bad.isConfigured, false);
		assert.equal(bad.allows({ host: "anything" }), false);
	});
});
