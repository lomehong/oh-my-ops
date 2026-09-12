import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpsError } from "../src/errors.ts";
import { ShellExec } from "../src/exec.ts";

describe("ShellExec", () => {
	const shell = new ShellExec();

	it("参数数组执行并返回 stdout/exitCode", async () => {
		const result = await shell.exec(["echo", "hello-ops"]);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout.trim(), "hello-ops");
		assert.ok(result.durationMs >= 0);
	});

	it("命令字符串按空白拆分为 argv（仍不经 shell）", async () => {
		const result = await shell.exec("echo a b");
		assert.equal(result.stdout.trim(), "a b");
	});

	it("非零退出码透传且不抛错（由调用方据 code 分支）", async () => {
		const result = await shell.exec(["false"]);
		assert.equal(result.exitCode, 1);
	});

	it("stderr 捕获", async () => {
		const result = await shell.exec(["sh", "-c", "echo err>&2"]);
		assert.equal(result.stderr.trim(), "err");
	});

	it("不存在命令 → EXEC_FAILED", async () => {
		await assert.rejects(shell.exec(["definitely-not-a-command-xyz"]), OpsError);
	});

	it("超时被终止 → TIMEOUT", async () => {
		await assert.rejects(shell.exec(["sleep", "5"], { timeoutMs: 200 }), /超时/);
	});

	it("输出超上限被截断且不丢已有内容", async () => {
		const result = await shell.exec(["sh", "-c", "yes 0123456789 | head -c 100000"], { maxOutputBytes: 1000 });
		assert.ok(result.stdout.startsWith("0123456789"));
		assert.ok(result.stdout.includes("已截断"));
		assert.ok(Buffer.byteLength(result.stdout) < 2000);
	});

	it("shell 元字符按字面量处理（防注入）", async () => {
		const result = await shell.exec(["echo", "a; touch /tmp/pii-injection-proof; b"]);
		// 若经 shell，`touch` 会被执行；字面量输出则证明未经过 shell
		assert.ok(result.stdout.includes("a; touch"));
		assert.doesNotMatch(result.stdout, /^a\n/);
	});
});
