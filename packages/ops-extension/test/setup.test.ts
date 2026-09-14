import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/setup.ts";

/** 路径解析契约：config.json 显式值 > 环境变量 > cwd 缺省（私有域注入依赖此优先级） */
describe("loadConfig 路径解析优先级", () => {
	let cwd: string;
	const saved = { policy: process.env.OMO_POLICY_PATH, token: process.env.OMO_TOKEN_PATH };

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ops-setup-"));
		delete process.env.OMO_POLICY_PATH;
		delete process.env.OMO_TOKEN_PATH;
	});
	afterEach(() => {
		if (saved.policy === undefined) delete process.env.OMO_POLICY_PATH;
		else process.env.OMO_POLICY_PATH = saved.policy;
		if (saved.token === undefined) delete process.env.OMO_TOKEN_PATH;
		else process.env.OMO_TOKEN_PATH = saved.token;
		rmSync(cwd, { recursive: true, force: true });
	});

	test("无 config、无 env → cwd/.ops-pi 缺省", () => {
		const cfg = loadConfig(cwd);
		expect(cfg.policyPath).toBe(join(cwd, ".ops-pi/policy.json"));
		expect(cfg.tokenPath).toBe(join(cwd, ".ops-pi/approval-token.json"));
	});

	test("env 生效（私有域注入）；空串视为未设", () => {
		process.env.OMO_POLICY_PATH = "/root/.omo/policy.json";
		process.env.OMO_TOKEN_PATH = "";
		const cfg = loadConfig(cwd);
		expect(cfg.policyPath).toBe("/root/.omo/policy.json");
		expect(cfg.tokenPath).toBe(join(cwd, ".ops-pi/approval-token.json"));
	});

	test("config.json 显式值优先于 env", () => {
		mkdirSync(join(cwd, ".ops-pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".ops-pi/config.json"),
			JSON.stringify({ policyPath: "/etc/explicit/policy.json" }),
		);
		process.env.OMO_POLICY_PATH = "/root/.omo/policy.json";
		const cfg = loadConfig(cwd);
		expect(cfg.policyPath).toBe("/etc/explicit/policy.json");
	});
});
