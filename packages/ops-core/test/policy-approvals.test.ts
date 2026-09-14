import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpsError } from "../src/errors.ts";
import { DefaultDenyPolicy, ReloadableTargetPolicy, loadTargetPolicy, LOCAL_HOST } from "../src/policy.ts";
import type { TargetRule } from "../src/policy.ts";
import { loadTokenStore, StaticTokenStore } from "../src/tokens.ts";
import { createAuthorizedExec, evaluateAuthorization, needsOwnerAuth, tierOf, READ, EXEC } from "../src/approvals.ts";

const RULES: readonly TargetRule[] = [
	{ host: "web-01", services: ["nginx"], actions: ["restart", "status"], production: false },
	{ host: "prod-db", production: true },
	{ host: LOCAL_HOST, actions: ["shell"] },
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

	it("★ LOCAL_HOST 哨兵：@local 规则授权本机操作（ops_shell_exec 此前无法被白名单表达）", () => {
		const request = { host: LOCAL_HOST, action: "shell", command: "uptime" };
		assert.equal(policy.allows(request), true);
		assert.equal(policy.allows({ host: LOCAL_HOST, action: "restart" }), false);
	});

	it("★ 服务维度显式性：无 services 约束的规则（shell 类）不放行带 service 的请求", () => {
		// rule {host: @local, actions:["shell"]} 无 services——不得误放行 nginx/redis 等服务请求
		assert.equal(policy.allows({ host: LOCAL_HOST, service: "nginx", action: "restart" }), false);
		assert.equal(policy.allows({ host: LOCAL_HOST, service: "anything" }), false);
		assert.equal(policy.allows({ host: LOCAL_HOST, action: "shell", command: "uptime" }), true);
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

	it("★ 生产标记服务维度显式性：带 services 的生产规则只标记该服务（不扩大到同主机任意服务）", () => {
		const scoped = new DefaultDenyPolicy([{ host: LOCAL_HOST, services: ["core-db"], production: true }]);
		assert.equal(scoped.isProduction({ host: LOCAL_HOST, service: "core-db", action: "restart" }), true);
		assert.equal(scoped.isProduction({ host: LOCAL_HOST, service: "redis", action: "restart" }), false);
		assert.equal(scoped.isProduction({ host: LOCAL_HOST, service: "core-db" }), true);
	});

	it("过期规则失效（expiresAt）", () => {
		const expired = new DefaultDenyPolicy([{ host: "old-host", expiresAt: "2020-01-01T00:00:00Z" }]);
		assert.equal(expired.allows({ host: "old-host" }), false);
	});
});

describe("P11：write 档显式 action + ruleCovers 收紧", () => {
	it("★ 服务级规则不连带放行无 service 维度的请求（此前 {host} 请求会被任何 host 规则放行）", () => {
		// 规则 {web-01, services:[nginx], actions:[restart,status]} 不覆盖无 service 的请求
		assert.equal(policy.allows({ host: "web-01" }), false);
		// shell 规则（{host:@local, actions:["shell"]}，无 services）也不放行 write 档 action
		assert.equal(policy.allows({ host: LOCAL_HOST, action: "file-write" }), false);
		assert.equal(policy.allows({ host: LOCAL_HOST, action: "vault-write" }), false);
	});

	it("★ 显式 file-write 规则才放行；Owner 全 host 规则（无 services 无 actions）仍覆盖一切", () => {
		const p = new DefaultDenyPolicy([
			{ host: LOCAL_HOST, actions: ["file-write"] },
			{ host: "wide-host" },
		]);
		assert.equal(p.allows({ host: LOCAL_HOST, action: "file-write" }), true);
		assert.equal(p.allows({ host: LOCAL_HOST, action: "vault-write" }), false);
		assert.equal(p.allows({ host: "wide-host", action: "file-write" }), true);
		// services 级规则（无 actions）不放行 action 型写档请求（写文件不是「该服务的操作」）
		const svcOnly = new DefaultDenyPolicy([{ host: LOCAL_HOST, services: ["nginx"] }]);
		assert.equal(svcOnly.allows({ host: LOCAL_HOST, service: "nginx" }), true);
		assert.equal(svcOnly.allows({ host: LOCAL_HOST, action: "file-write" }), false);
	});

	it("action 无关语义保持：host+service 命中即放行（服务级授权不要求逐 action 枚举）", () => {
		assert.equal(policy.allows({ host: "web-01", service: "nginx" }), true);
	});
});

describe("evaluateAuthorization（单一事实源：①-a/①-b/③ 共用）", () => {
	it("优先级 1：令牌命中 → allowed(source=token)，明示批准 > 生产 blanket-deny", () => {
		const verdict = evaluateAuthorization(policy, tokens, { host: "prod-db", service: "postgres", action: "restart" });
		assert.deepStrictEqual(verdict, { allowed: true, source: "token", tokenId: "T-9" });
	});

	it("优先级 2：policy 白名单命中 → allowed(source=policy)", () => {
		const verdict = evaluateAuthorization(policy, tokens, { host: "web-01", service: "nginx", action: "restart" });
		assert.deepStrictEqual(verdict, { allowed: true, source: "policy" });
	});

	it("优先级 3：生产目标无令牌 → 拒（guard-production）", () => {
		const verdict = evaluateAuthorization(policy, tokens, { host: "prod-db", service: "redis", action: "restart" });
		assert.deepStrictEqual(verdict, { allowed: false, source: "none", reason: "guard-production" });
	});

	it("优先级 4：其余 → 拒（guard-unattended）", () => {
		const verdict = evaluateAuthorization(policy, tokens, { host: "lab-9", service: "redis", action: "restart" });
		assert.deepStrictEqual(verdict, { allowed: false, source: "none", reason: "guard-unattended" });
	});
});

describe("ReloadableTokenStore（mtime 重载 + 单次消费）", () => {
	it("文件后置出现 → 下次 find 即生效（§7.4.3 降级语义）", () => {
		const latePath = path.join(tmpDir, "late-token.json");
		const store = loadTokenStore(latePath);
		const request = { host: "prod-db", service: "postgres", action: "restart" };
		assert.equal(store.find(request).valid, false); // 文件尚不存在
		fs.writeFileSync(latePath, JSON.stringify({
			tokens: [{ id: "T-LATE", scope: "prod-db/postgres/restart", issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }],
		}));
		const found = store.find(request);
		assert.equal(found.valid, true);
		if (found.valid) assert.equal(found.token.id, "T-LATE");
	});

	it("consume 后同请求不再命中（单次批准），文件写回 consumedAt（跨会话不可重放）", async () => {
		const oncePath = path.join(tmpDir, "once-token.json");
		fs.writeFileSync(oncePath, JSON.stringify({
			tokens: [{ id: "T-1", scope: `${LOCAL_HOST}/nginx/restart`, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" }],
		}));
		const store = loadTokenStore(oncePath);
		const request = { host: LOCAL_HOST, service: "nginx", action: "restart" };
		assert.equal(store.find(request).valid, true);
		store.consume(request);
		assert.equal(store.find(request).valid, false); // 内存立即不可重放
		// 新实例（模拟跨会话）从文件读 → 已消费 → 不命中
		const fresh = loadTokenStore(oncePath);
		assert.equal(fresh.find(request).valid, false);
		const parsed = JSON.parse(fs.readFileSync(oncePath, "utf8")) as { tokens: Array<{ id: string; consumedAt?: string }> };
		assert.ok(parsed.tokens[0]!.consumedAt !== undefined, "consumedAt 应写回文件");
	});

	it("scope 逐段前缀匹配：host+service 令牌覆盖该服务任意 action", () => {
		const store = new StaticTokenStore([
			{ id: "T-SVC", scope: `${LOCAL_HOST}/nginx`, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" },
		]);
		assert.equal(store.find({ host: LOCAL_HOST, service: "nginx", action: "restart" }).valid, true);
		assert.equal(store.find({ host: LOCAL_HOST, service: "nginx", action: "stop" }).valid, true);
		assert.equal(store.find({ host: LOCAL_HOST, service: "redis", action: "restart" }).valid, false);
		assert.equal(store.find({ host: "web-01", service: "nginx", action: "restart" }).valid, false);
	});

	it("无 host 的请求不匹配任何令牌（无目标语义）", () => {
		const store = new StaticTokenStore([
			{ id: "T-X", scope: LOCAL_HOST, issuedBy: "主人", issuedAt: "2026-09-12T00:00:00Z" },
		]);
		assert.equal(store.find({ action: "shell" }).valid, false);
	});
});

describe("ReloadableTargetPolicy（mtime 重载）", () => {
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	it("文件出现/编辑 → 下次判定即生效（免重启）", async () => {
		const policyPath = path.join(tmpDir, "reload-policy.json");
		const reloadable = new ReloadableTargetPolicy(policyPath);
		const request = { host: "web-09", service: "app", action: "restart" };
		assert.equal(reloadable.allows(request), false); // 文件不存在 → 全拒
		assert.equal(reloadable.isConfigured, false);
		fs.writeFileSync(policyPath, JSON.stringify({
			targets: [{ host: "web-09", services: ["app"], actions: ["restart"] }],
		}));
		assert.equal(reloadable.allows(request), true); // 出现后下次判定生效
		assert.equal(reloadable.isConfigured, true);
		await sleep(10); // mtime 粒度可能为毫秒/秒——确保后续写入产生可感知的 mtime 变化
		// 收紧 → 立即生效
		fs.writeFileSync(policyPath, JSON.stringify({ targets: [] }));
		assert.equal(reloadable.allows(request), false);
		assert.equal(reloadable.isConfigured, false);
		await sleep(10);
		// 损坏 → 全拒（保守侧）
		fs.writeFileSync(policyPath, "{ broken");
		assert.equal(reloadable.allows({ host: "web-09" }), false);
	});
});

describe("authorizedExec（纯函数：宿主求值 3 次，必须无副作用）", () => {
	it("预授权命中 → policy:allow（任何模式放行）", () => {
		const decision = authorizedExec({ host: "web-01", service: "nginx", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "allow", reason: "命中预授权 web-01/nginx" });
	});

	it("生产目标（无令牌）→ policy:deny（任何模式硬拒）", () => {
		const decision = authorizedExec({ host: "prod-db", service: "redis", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更（如需放行须 Owner 批准令牌）" });
	});

	it("Owner 令牌优先于生产 blanket-deny（明示批准 > 默认拒绝）", () => {
		const decision = authorizedExec({ host: "prod-db", service: "postgres", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec", policy: "allow", reason: "Owner 批准令牌 T-9" });
	});

	it("未授权 → 朴素档位（交平台审批；无人值守由 ①-b 拒）", () => {
		const decision = authorizedExec({ host: "lab-9", service: "redis", action: "restart" });
		assert.deepStrictEqual(decision, { tier: "exec" });
	});

	it("纯函数：同输入同输出（不消费令牌）", () => {
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
