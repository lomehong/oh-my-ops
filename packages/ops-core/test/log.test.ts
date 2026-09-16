import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { LogCollector } from "../src/log.ts";
import { ShellExec } from "../src/exec.ts";

describe("LogCollector", () => {
	const log = new LogCollector();
	// tail/grep 为 POSIX 命令；win32 无此二进制
	const POSIX_ONLY = process.platform === "win32" ? "win32：依赖 POSIX 命令（tail/grep）" : false;

	it("tailFile：读取末尾 N 行", { skip: POSIX_ONLY }, async () => {
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

	it("grep：多文件正则搜索", { skip: POSIX_ONLY }, async () => {
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

describe("LogCollector.grep 解析（防字段错位：2026-09-16 对端实测）", () => {
	const POSIX_ONLY2 = process.platform === "win32" ? "win32：依赖 POSIX 命令（grep）" : false;
	const stub = (stdout: string) =>
		({ exec: async () => ({ stdout, stderr: "", exitCode: 0, durationMs: 0, truncated: false }) }) as never;

	it("单路径、带文件名前缀（-H 形态）→ 正确切分", async () => {
		const g = new LogCollector(stub("/etc/passwd:2:bin:x:1:1:bin:/bin:/sbin/nologin\n"));
		const r = await g.grep("nologin", ["/etc/passwd"]);
		assert.deepStrictEqual(r.matches[0], { file: "/etc/passwd", line: 2, text: "bin:x:1:1:bin:/bin:/sbin/nologin" });
	});

	it("★ 单路径、无文件名前缀 → 按行号锚定，不得产出错位数据", async () => {
		const g = new LogCollector(stub("2:bin:x:1:1:bin:/bin:/sbin/nologin\n"));
		const r = await g.grep("nologin", ["/etc/passwd"]);
		assert.deepStrictEqual(r.matches[0], { file: "/etc/passwd", line: 2, text: "bin:x:1:1:bin:/bin:/sbin/nologin" });
	});

	it("多路径、无前缀 → 无法锚定则丢弃（宁缺勿错）", async () => {
		const g = new LogCollector(stub("2:bin:x:1:1:bin:/bin:/sbin/nologin\n"));
		const r = await g.grep("nologin", ["/etc/passwd", "/etc/group"]);
		assert.equal(r.matches.length, 0);
	});

	it("目录递归输出（dir/sub/file）→ 视为已知路径之内，正常保留", async () => {
		const g = new LogCollector(stub("/var/log/nginx/access.log:7:hit\n"));
		const r = await g.grep("hit", ["/var/log/nginx"]);
		assert.deepStrictEqual(r.matches[0], { file: "/var/log/nginx/access.log", line: 7, text: "hit" });
	});

	it("真实 grep：单路径结构断言（file/line/text 三者对齐）", { skip: POSIX_ONLY2 }, async () => {
		const f = "/tmp/ops-log-test-single.log";
		fs.writeFileSync(f, "alpha\nbeta nologin\ngamma\n");
		const r = await new LogCollector().grep("nologin", [f], { maxCount: 5 }, { timeoutMs: 10_000 });
		assert.equal(r.matches.length, 1);
		assert.equal(r.matches[0]!.file, f);
		assert.equal(r.matches[0]!.line, 2);
		assert.equal(r.matches[0]!.text, "beta nologin");
	});
});

describe("LogCollector.journalctl 结果结构（缺陷 7：stderr 曾被丢弃）", () => {
	const stub = (stdout: string, stderr: string, exitCode = 0) =>
		({ exec: async () => ({ stdout, stderr, exitCode, durationMs: 0, truncated: false }) }) as never;

	it("★ 非特权用户提示在 stderr（exit=0、stdout 空）→ 必须回显且带 note", async () => {
		const warn = "You are currently not seeing messages from other users and the system.";
		const r = await new LogCollector(stub("", warn)).journalctl({ unit: "sshd", lines: 10 });
		assert.equal(r.exitCode, 0);
		assert.equal(r.lines.length, 0);
		assert.ok(r.stderr.includes("not seeing messages"), "stderr 必须原样保留");
		assert.ok((r.note ?? "").includes("systemd-journal"), "应给出权限/存储语义提示");
	});

	it("失败（exit!=0）→ exitCode/stderr 一并可见", async () => {
		const r = await new LogCollector(stub("", "Failed to connect to bus", 1)).journalctl({ lines: 5 });
		assert.equal(r.exitCode, 1);
		assert.ok(r.stderr.includes("Failed to connect to bus"));
	});

	it("正常输出且无 stderr → 无 note", async () => {
		const r = await new LogCollector(stub("line-a\nline-b\n", "")).journalctl({ lines: 5 });
		assert.deepStrictEqual(r.lines, ["line-a", "line-b"]);
		assert.equal(r.note, undefined);
	});
});

