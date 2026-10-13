import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 测试清单守护：CI 的 test:l2 曾手工列举 11 个测试文件，新增测试若忘记加入该列表，
 * 会被**静默跳过**（不失败、只漏测）——而 README 把 test:l2 当作 CI 同源依据。
 * 现 test:l2 已改为目录 glob，本测试进一步固化约定：新增 *.test.ts 必须能被 bun 自动发现，
 * 且不得把测试放在 glob 覆盖不到的子目录（如 runtime/ 下的 shell 探针不算单元测试）。
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function testFiles(dir: string = TEST_DIR): string[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
		.map((e) => e.name)
		.sort();
}

/** 顶层可直接跑的测试（子目录下的属运行时探针，不要求 bun 收集） */
function topLevelTestFiles(): string[] {
	return testFiles();
}

/** 子目录（如 runtime/）中的测试文件——列出以便识别「被 glob 漏掉」的放置错误 */
function nestedTestFiles(): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(TEST_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const sub = path.join(TEST_DIR, entry.name);
		for (const name of fs.readdirSync(sub)) {
			if (name.endsWith(".test.ts")) out.push(`${entry.name}/${name}`);
		}
	}
	return out.sort();
}

describe("测试清单守护（防止新增测试被 CI 静默跳过）", () => {
	test("test:l2 走目录 glob，新增 *.test.ts 自动纳入（package.json 不得回退为文件清单）", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "..", "..", "..", "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const cmd = pkg.scripts["test:l2"] ?? "";
		expect(cmd).toContain("packages/ops-extension/test/");
		// 逐文件列举是漏测的根因：一旦出现 "test/xxx.test.ts" 形式的硬编码清单即判失败
		expect(cmd).not.toMatch(/test\/[\w-]+\.test\.ts/);
	});

	test("顶层测试文件非空，且命名均以 .test.ts 结尾", () => {
		const files = topLevelTestFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const name of files) expect(name.endsWith(".test.ts")).toBe(true);
	});

	test("测试不得放在 runtime/ 等 glob 覆盖不到的子目录（否则等于未纳入 CI）", () => {
		const nested = nestedTestFiles();
		for (const rel of nested) {
			expect(rel.startsWith("runtime/")).toBe(true);
		}
	});

	test("关键授权与执行层测试存在于顶层（回归防护锚点）", () => {
		const extFiles = new Set(topLevelTestFiles());
		// 这些文件覆盖策略/守卫/请求映射/执行层，是安全语义的回归网
		for (const required of [
			"guards.test.ts",
			"request.test.ts",
			"approvals.test.ts",
			"policy-explain.test.ts",
			"read-tier-structure.test.ts",
			"tools-shell.test.ts",
		]) {
			expect(extFiles.has(required)).toBe(true);
		}
		// 执行层参数收口的回归网在 ops-core（argv 安全属L1 纯能力，与 policy/tokens 同层）
		const coreDir = path.join(TEST_DIR, "..", "..", "ops-core", "test");
		const coreFiles = new Set(fs.readdirSync(coreDir).filter((n) => n.endsWith(".test.ts")));
		expect(coreFiles.has("argv-safety.test.ts")).toBe(true);
	});
});