import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpsError } from "../src/errors.ts";
import { FileOps } from "../src/files.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-file-"));
const file = path.join(dir, "sample.txt");
fs.writeFileSync(file, "ops-pi sample\n".repeat(10));

after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
