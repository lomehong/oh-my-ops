import { describe, expect, test } from "bun:test";
import { DefaultDenyPolicy, LOCAL_HOST, READ, StaticTokenStore, WRITE, tierOf } from "@ops-pi/core";
import { policyRequestFor } from "../src/request.ts";
import { READ_ACTIONS, TIER_TABLE } from "../src/approvals.ts";
import { assertAuthorized, standardAuthzView } from "../src/guards.ts";

/** P7：host 维度透传——远程主机名进入策略匹配维度（此前一律 @local） */
describe("policyRequestFor · host 维度", () => {
	test("省略 / @local → 本机", () => {
		expect(policyRequestFor("ops_shell_exec", { command: "x" }).host).toBe("@local");
		expect(policyRequestFor("ops_shell_exec", { command: "x", host: "@local" }).host).toBe("@local");
	});
	test("真实主机名透传（远程目标 → 策略按 host 匹配）", () => {
		expect(policyRequestFor("ops_shell_exec", { command: "x", host: "web-01" }).host).toBe("web-01");
		expect(policyRequestFor("ops_health_check", { hostname: "db-01" }).host).toBe("db-01");
		expect(policyRequestFor("ops_service", { host: "prod-api", service: "nginx", action: "restart" }).host).toBe("prod-api");
		expect(policyRequestFor("ops_docker_exec", { container: "c1", command: "x", host: "web-01" }).host).toBe("web-01");
	});
	test("非法主机名抛 POLICY_DENIED（审批层即拒，不进执行）", () => {
		expect(() => policyRequestFor("ops_shell_exec", { command: "x", host: "-oProxyCommand=evil" })).toThrow(/POLICY_DENIED|非法主机名/);
	});
	test("user@host 形式合法", () => {
		expect(policyRequestFor("ops_file_read", { path: "/etc/hostname", host: "deploy@10.0.0.5" }).host).toBe("deploy@10.0.0.5");
	});
});

describe("policyRequestFor · write 档显式 action（P11）", () => {
	test("ops_file_write → action='file-write'（此前落 default 分支只带 {host}，被任意 host 规则连带放行）", () => {
		expect(policyRequestFor("ops_file_write", { path: "/tmp/a", content: "x" }))
			.toEqual({ host: "@local", action: "file-write" });
		expect(policyRequestFor("ops_file_write", { path: "/a", content: "x", host: "web-01" }))
			.toEqual({ host: "web-01", action: "file-write" });
	});
	test("ops_vault_store → action='vault-write'", () => {
		expect(policyRequestFor("ops_vault_store", { key: "k", value: "v" }))
			.toEqual({ host: "@local", action: "vault-write" });
	});
	test("ops_vault_rekey → action='vault-rekey'（P14 口令轮换独立授权粒度）", () => {
		expect(policyRequestFor("ops_vault_rekey", { newPassphrase: "n" }))
			.toEqual({ host: "@local", action: "vault-rekey" });
	});
	test("ops_kb_save / ops_kb_sync → 显式 action，host 恒 @local（知识仓为控制节点本地）", () => {
		expect(policyRequestFor("ops_kb_save", { slug: "s", title: "t", content: "c" }))
			.toEqual({ host: LOCAL_HOST, action: "kb-write" });
		expect(policyRequestFor("ops_kb_sync", {})).toEqual({ host: LOCAL_HOST, action: "kb-sync" });
		// host 入参不改变知识仓位置：不得借远程 host 规则放行本机知识写入
		expect(policyRequestFor("ops_kb_sync", { host: "web-01" })).toEqual({ host: LOCAL_HOST, action: "kb-sync" });
	});
});

describe("policyRequestFor · default 分支 fail-fast（非 read 档不得以 {host} 宽松语义参与授权）", () => {
	test("★ 一致性：TIER_TABLE 中所有非 read 档工具（含多态工具的非 read 动作）必须产出显式 action", () => {
		for (const name of Object.keys(TIER_TABLE)) {
			const entry = TIER_TABLE[name];
			const args = typeof entry === "function" ? { action: "__non_read__" } : {};
			if (tierOf(name, args, TIER_TABLE) === READ) continue;
			const request = policyRequestFor(name, args);
			const hasAction = typeof request.action === "string" && request.action !== "";
			expect(hasAction ? name : `${name} 缺少显式 action`).toBe(name);
		}
	});

	test("多态工具的 read 动作与纯 read 档工具落 {host}（判定前短路，仅供一致性）", () => {
		for (const [name, actions] of Object.entries(READ_ACTIONS)) {
			for (const action of actions) expect(policyRequestFor(name, { action }).host).toBe(LOCAL_HOST);
		}
		expect(policyRequestFor("ops_file_read", { path: "/etc/hosts" })).toEqual({ host: LOCAL_HOST });
	});

	test("未登记工具（按最严档 EXEC）落 default → 抛错而非 {host}", () => {
		expect(() => policyRequestFor("ops_x", { host: "whatever" })).toThrow(/未在 policyRequestFor 登记显式 action/);
	});

	test("★ 回归：仅授权 shell 的规则不再连带放行 ops_kb_save / ops_kb_sync（P11 同类漏洞）", () => {
		const shellOnly = standardAuthzView(
			new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["shell"] }]),
			new StaticTokenStore([]),
		);
		expect(tierOf("ops_kb_save", {}, TIER_TABLE)).toBe(WRITE);
		expect(() => assertAuthorized("ops_kb_save", { slug: "s", title: "t" }, shellOnly)).toThrow(/未获预授权/);
		expect(() => assertAuthorized("ops_kb_sync", { sync: true }, shellOnly)).toThrow(/未获预授权/);

		const kbRule = standardAuthzView(
			new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["kb-write", "kb-sync"] }]),
			new StaticTokenStore([]),
		);
		expect(assertAuthorized("ops_kb_save", { slug: "s", title: "t" }, kbRule)).toBe("policy");
		expect(assertAuthorized("ops_kb_sync", { sync: true }, kbRule)).toBe("policy");
	});
});
