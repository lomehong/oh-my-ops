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
