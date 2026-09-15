import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog, AUDIT_GENESIS } from "../src/audit.ts";

function tmpFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omo-audit-")), "audit", "ops-audit.jsonl");
}
const entry = (tool: string, isError = false) => ({ tool, isError, ts: new Date().toISOString(), authz: "read" });

describe("AuditLog（独立 append-only JSONL + 哈希链；与宿主会话解耦）", () => {
	it("append 自动建目录、逐行落盘、seq 递增、prev 链接上一条 hash", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		const a = log.append(entry("ops_file_read"));
		const b = log.append(entry("ops_service", true));
		assert.equal(a?.seq, 1);
		assert.equal(a?.prev, AUDIT_GENESIS);
		assert.equal(b?.seq, 2);
		assert.equal(b?.prev, a?.hash);
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[1]!).tool, "ops_service");
		assert.deepEqual(log.verify(), { ok: true, count: 2 });
	});

	it("跨进程续链：新实例从文件尾部恢复 seq/prev，链保持连续", () => {
		const file = tmpFile();
		new AuditLog(file).append(entry("a"));
		const second = new AuditLog(file);
		const r = second.append(entry("b"));
		assert.equal(r?.seq, 2);
		assert.deepEqual(second.verify(), { ok: true, count: 2 });
		assert.deepEqual(second.readRecent(1).map((x) => x.tool), ["b"]);
		assert.deepEqual(second.readRecent(10).map((x) => x.tool), ["a", "b"]);
	});

	it("★ 篡改可发现：改动中间一条内容 → verify 报告断链行号", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		log.append(entry("a")); log.append(entry("b", true)); log.append(entry("c"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const tampered = JSON.parse(lines[1]!) as Record<string, unknown>;
		tampered.isError = false; // 把「被拒」改成「成功」
		lines[1] = JSON.stringify(tampered);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const v = log.verify();
		assert.equal(v.ok, false);
		assert.equal(v.brokenAt, 2);
		assert.ok(v.reason?.includes("hash 不符"));
	});

	it("★ 删行可发现：删掉一条 → 后继 seq/prev 不符", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		log.append(entry("a")); log.append(entry("b")); log.append(entry("c"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		fs.writeFileSync(file, `${[lines[0], lines[2]].join("\n")}\n`);
		const v = log.verify();
		assert.equal(v.ok, false);
		assert.equal(v.brokenAt, 2);
	});

	it("文件缺失 → verify ok/0、readRecent 空；写失败不抛且记 lastError", () => {
		const log = new AuditLog(tmpFile());
		assert.deepEqual(log.verify(), { ok: true, count: 0 });
		assert.deepEqual(log.readRecent(5), []);
		// 目录位置被普通文件占据 → mkdir 失败 → append 返回 undefined 而非抛错
		const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omo-audit-")), "notadir");
		fs.writeFileSync(blocked, "x");
		const bad = new AuditLog(path.join(blocked, "audit.jsonl"));
		assert.equal(bad.append(entry("x")), undefined);
		assert.equal(typeof bad.lastError, "string");
	});
});
