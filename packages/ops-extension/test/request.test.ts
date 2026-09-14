import { describe, expect, test } from "bun:test";
import { policyRequestFor } from "../src/request.ts";

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
});
