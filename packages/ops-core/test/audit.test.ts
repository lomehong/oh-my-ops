import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog, AUDIT_GENESIS } from "../src/audit.ts";

function tmpFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omo-audit-")), "audit", "ops-audit.jsonl");
}
const entry = (tool: string, isError = false) => ({ tool, isError, ts: new Date().toISOString(), authz: "read" });

describe("AuditLog（独立 append-only JSONL + 哈希链；与宿主会话解耦）", () => {
	test("append 自动建目录、逐行落盘、seq 递增、prev 链接上一条 hash", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		const a = log.append(entry("ops_file_read"));
		const b = log.append(entry("ops_service", true));
		expect(a?.seq).toBe(1);
		expect(a?.prev).toBe(AUDIT_GENESIS);
		expect(b?.seq).toBe(2);
		expect(b?.prev).toBe(a?.hash);
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[1]!).tool).toBe("ops_service");
		expect(log.verify()).toEqual({ ok: true, count: 2 });
	});

	test("跨进程续链：新实例从文件尾部恢复 seq/prev，链保持连续", () => {
		const file = tmpFile();
		new AuditLog(file).append(entry("a"));
		const second = new AuditLog(file);
		const r = second.append(entry("b"));
		expect(r?.seq).toBe(2);
		expect(second.verify()).toEqual({ ok: true, count: 2 });
		expect(second.readRecent(1).map((x) => x.tool)).toEqual(["b"]);
		expect(second.readRecent(10).map((x) => x.tool)).toEqual(["a", "b"]);
	});

	test("★ 篡改可发现：改动中间一条内容 → verify 报告断链行号", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		log.append(entry("a")); log.append(entry("b", true)); log.append(entry("c"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		const tampered = JSON.parse(lines[1]!) as Record<string, unknown>;
		tampered.isError = false; // 把「被拒」改成「成功」
		lines[1] = JSON.stringify(tampered);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const v = log.verify();
		expect(v.ok).toBe(false);
		expect(v.brokenAt).toBe(2);
		expect(v.reason).toContain("hash 不符");
	});

	test("★ 删行可发现：删掉一条 → 后继 seq/prev 不符", () => {
		const file = tmpFile();
		const log = new AuditLog(file);
		log.append(entry("a")); log.append(entry("b")); log.append(entry("c"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		fs.writeFileSync(file, `${[lines[0], lines[2]].join("\n")}\n`);
		const v = log.verify();
		expect(v.ok).toBe(false);
		expect(v.brokenAt).toBe(2);
	});

	test("文件缺失 → verify ok/0、readRecent 空；写失败不抛且记 lastError", () => {
		const log = new AuditLog(tmpFile());
		expect(log.verify()).toEqual({ ok: true, count: 0 });
		expect(log.readRecent(5)).toEqual([]);
		// 目录位置被普通文件占据 → mkdir 失败 → append 返回 undefined 而非抛错
		const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omo-audit-")), "notadir");
		fs.writeFileSync(blocked, "x");
		const bad = new AuditLog(path.join(blocked, "audit.jsonl"));
		expect(bad.append(entry("x"))).toBeUndefined();
		expect(typeof bad.lastError).toBe("string");
	});
});
