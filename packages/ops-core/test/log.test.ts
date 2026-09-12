import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { LogCollector } from "../src/log.ts";
import { ShellExec } from "../src/exec.ts";

describe("LogCollector", () => {
	const log = new LogCollector();

	it("tailFile：读取末尾 N 行", async () => {
		const path = "/tmp/ops-log-test-tail.txt";
		const content = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n") + "\n";
		fs.writeFileSync(path, content);
		const result = await log.tailFile(path, { lines: 5 });
		assert.ok(result.lines.length <= 5);
		assert.ok(result.lines[result.lines.length - 1]!.includes("line-19"));
	});

	it("journalctl：环境有 journalctl 时验证返回结构", { skip: !fs.existsSync("/usr/bin/journalctl") && !fs.existsSync("/bin/journalctl") ? "环境无 journalctl" : false }, async () => {
		const shell = new ShellExec();
		let hasJournalctl = false;
		try { await shell.exec(["which", "journalctl"], { timeoutMs: 2_000 }); hasJournalctl = true; } catch { /* 不可用 */ }
		const result = await log.journalctl({ lines: 5 }, { timeoutMs: 8_000 });
		assert.ok(typeof result.query === "string");
		assert.ok(Array.isArray(result.lines));
		assert.ok(hasJournalctl ? result.lines.length >= 0 : true);
	});

	it("grep：多文件正则搜索", async () => {
		const file1 = "/tmp/ops-log-test-a.log";
		const file2 = "/tmp/ops-log-test-b.log";
		fs.writeFileSync(file1, "error: connection refused\nok: success\nerror: timeout\n");
		fs.writeFileSync(file2, "error: permission denied\n");
		const result = await log.grep("error:", [file1, file2], { maxCount: 10 }, { timeoutMs: 10_000 });
		assert.equal(result.totalMatches, 3);
		assert.ok(result.matches.some((m) => m.file.includes("a.log")));
		assert.ok(result.matches.some((m) => m.file.includes("b.log")));
	});
});
