import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpsError } from "../src/errors.ts";
import { FileOps } from "../src/files.ts";
import type { ExecOptions, ExecResult, Runner } from "../src/runner.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-file-"));
const file = path.join(dir, "sample.txt");
fs.writeFileSync(file, "ops-pi sample\n".repeat(10));

after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** 桩 Runner：记录 exec 调用（argv + options），返回预设结果（P13 远程写入用，无 OS 依赖） */
class StubRunner implements Runner {
	readonly calls: Array<{ cmd: string | readonly string[]; options?: ExecOptions }> = [];
	private readonly results: Array<{ exitCode?: number; stderr?: string }>;
	constructor(results: Array<{ exitCode?: number; stderr?: string }> = []) {
		this.results = results;
	}
	async exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ cmd, options });
		const r = this.results[Math.min(this.calls.length - 1, this.results.length - 1)] ?? {};
		return { stdout: "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0, durationMs: 1 };
	}
}

describe("FileOps.read", () => {
	const files = new FileOps();

	it("读取文本内容", async () => {
		assert.ok((await files.read(file)).includes("ops-pi sample"));
	});

	it("不存在 → NOT_FOUND", async () => {
		const missing = path.join(dir, "nope.txt");
		await assert.rejects(files.read(missing), (error: unknown) =>
			error instanceof OpsError && error.code === "NOT_FOUND");
	});

	it("目录 → NOT_FOUND", async () => {
		await assert.rejects(files.read(dir), /目录而非文件/);
	});

	it("超上限 → POLICY_DENIED（防 OOM，提示改用分段读取）", async () => {
		await assert.rejects(files.read(file, { maxBytes: 10 }), /文件过大/);
	});
});

describe("FileOps.write（本地）", () => {
	const files = new FileOps();

	it("本地写入 + 读回一致", async () => {
		const target = path.join(dir, "written.txt");
		await files.write(target, "P8 写入内容\n");
		assert.equal(fs.readFileSync(target, "utf8"), "P8 写入内容\n");
	});

	it("父目录不存在 → INTERNAL（不静默 mkdir）", async () => {
		await assert.rejects(files.write(path.join(dir, "no-such-dir", "x.txt"), "y"), (error: unknown) =>
			error instanceof OpsError && error.code === "INTERNAL");
	});
});

describe("FileOps.write 远程路径（P13：writeViaRunner，stdin 管道无 shell 注入面）", () => {
	it("dd of=<path> + stdin 传内容；mode 指定时追加 chmod", async () => {
		const stub = new StubRunner();
		const remote = new FileOps(stub);
		await remote.write("/srv/app/config.yml", "key: value\n", { mode: 0o600 });
		assert.equal(stub.calls.length, 2);
		assert.deepStrictEqual(stub.calls[0]!.cmd, ["dd", "of=/srv/app/config.yml"]);
		assert.equal(stub.calls[0]!.options?.stdin, "key: value\n");
		assert.deepStrictEqual(stub.calls[1]!.cmd, ["chmod", "600", "--", "/srv/app/config.yml"]);
	});

	it("mode 缺省 → 不追加 chmod", async () => {
		const stub = new StubRunner();
		await new FileOps(stub).write("/tmp/a.txt", "x");
		assert.equal(stub.calls.length, 1);
		assert.deepStrictEqual(stub.calls[0]!.cmd, ["dd", "of=/tmp/a.txt"]);
	});

	it("dd 失败（Permission denied）→ PERMISSION_DENIED，stderr 摘要回传", async () => {
		const stub = new StubRunner([{ exitCode: 1, stderr: "dd: /etc/cron.d/x: Permission denied" }]);
		await assert.rejects(
			new FileOps(stub).write("/etc/cron.d/x", "evil"),
			(error: unknown) => error instanceof OpsError && error.code === "PERMISSION_DENIED" && /Permission denied/.test(error.message),
		);
	});

	it("dd 失败（其他错误）→ EXEC_FAILED", async () => {
		const stub = new StubRunner([{ exitCode: 2, stderr: "dd: unknown device" }]);
		await assert.rejects(
			new FileOps(stub).write("/dev/nowhere", "x"),
			(error: unknown) => error instanceof OpsError && error.code === "EXEC_FAILED",
		);
	});

	it("写入成功但 chmod 失败 → EXEC_FAILED（如实上报，不静默）", async () => {
		const stub = new StubRunner([{}, { exitCode: 1, stderr: "chmod: noop" }]);
		await assert.rejects(
			new FileOps(stub).write("/tmp/b.txt", "x", { mode: 0o600 }),
			(error: unknown) => error instanceof OpsError && error.code === "EXEC_FAILED" && /chmod 失败/.test(error.message),
		);
	});
});
