import { describe, expect, test } from "bun:test";
import {
	AUDIT_DEFAULT_LIMIT,
	AUDIT_LIMIT_MAX,
	formatAuditReport,
	parseAuditLimit,
	toAuditViews,
} from "../src/audit-view.ts";

/** 构造一条 getBranch 审计信封条目（探针 v42-layer-audit-probe.ts:28-29 实证形状） */
function auditEntry(data: Record<string, unknown>): unknown {
	return { type: "custom", customType: "ops_audit", data };
}

describe("parseAuditLimit（B4/T1：空=20，正整数，上限 200）", () => {
	test("留空 → 默认 20，不截断", () => {
		expect(parseAuditLimit(undefined)).toEqual({ ok: true, n: 20, truncated: false });
		expect(parseAuditLimit("")).toEqual({ ok: true, n: AUDIT_DEFAULT_LIMIT, truncated: false });
		expect(parseAuditLimit("  ")).toEqual({ ok: true, n: AUDIT_DEFAULT_LIMIT, truncated: false });
	});

	test("正整数 → 原样", () => {
		expect(parseAuditLimit("5")).toEqual({ ok: true, n: 5, truncated: false });
		expect(parseAuditLimit(" 7 ")).toEqual({ ok: true, n: 7, truncated: false });
	});

	test("0 / 负数 / 小数 / 非数字 → 明确错误", () => {
		for (const bad of ["0", "-3", "2.5", "abc", "5条"]) {
			const r = parseAuditLimit(bad);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain("正整数");
		}
	});

	test("超上限 → 截断到 200 并带 truncated 标记", () => {
		expect(parseAuditLimit("201")).toEqual({ ok: true, n: AUDIT_LIMIT_MAX, truncated: true });
		expect(parseAuditLimit("99999")).toEqual({ ok: true, n: 200, truncated: true });
	});

	test("恰等于上限 → 不带截断标记", () => {
		expect(parseAuditLimit("200")).toEqual({ ok: true, n: 200, truncated: false });
	});
});

describe("toAuditViews（B2/B3：判型收窄，缺失不臆造，保序）", () => {
	test("剔除非 custom 与非 ops_audit 条目", () => {
		const views = toAuditViews([
			{ type: "text", text: "hello" },
			{ type: "custom", customType: "other", data: { tool: "x" } },
			auditEntry({ tool: "ops_read_file", ts: "2026-09-14T00:00:01.000Z" }),
			"junk",
			null,
		]);
		expect(views).toHaveLength(1);
		expect(views[0]?.tool).toBe("ops_read_file");
	});

	test("data 字段缺失 → undefined（不补默认语义）", () => {
		const views = toAuditViews([auditEntry({ tool: "ops_x" })]);
		expect(views[0]?.tool).toBe("ops_x");
		expect(views[0]?.ts).toBeUndefined();
		expect(views[0]?.authz).toBeUndefined();
		expect(views[0]?.isError).toBeUndefined();
		expect(views[0]?.reasonClass).toBeUndefined();
		expect(views[0]?.host).toBeUndefined();
		expect(views[0]?.reason).toBeUndefined();
	});

	test("data 非对象（或缺失）→ 全字段 undefined，不抛错", () => {
		const views = toAuditViews([
			{ type: "custom", customType: "ops_audit" },
			{ type: "custom", customType: "ops_audit", data: "garbage" },
		]);
		expect(views).toHaveLength(2);
		expect(views[0]?.tool).toBeUndefined();
		expect(views[1]?.tool).toBeUndefined();
	});

	test("保序：不做排序（排序职责在展示层）", () => {
		const views = toAuditViews([
			auditEntry({ tool: "a", ts: "2026-09-14T00:00:02.000Z" }),
			auditEntry({ tool: "b", ts: "2026-09-14T00:00:01.000Z" }),
		]);
		expect(views.map((v) => v.tool)).toEqual(["a", "b"]);
	});
});

describe("formatAuditReport（B3/B7/T1：倒序切片、- 填充、截断、空态）", () => {
	const t = (m: number) => `2026-09-14T00:${String(m).padStart(2, "0")}:00.000Z`;

	test("空数组 → 空态文案 + 可读范围声明（B7）", () => {
		const out = formatAuditReport([], 20);
		expect(out).toContain("本会话无审计条目");
		expect(out).toContain("当前会话分支");
	});
	test("按 ts 倒序 + 切片 limit", () => {
		const views = toAuditViews([auditEntry({ tool: "old", ts: t(1) }), auditEntry({ tool: "new", ts: t(3) }), auditEntry({ tool: "mid", ts: t(2) })]);
		const out = formatAuditReport(views, 2);
		expect(out).toContain("显示 2 条");
		expect(out.indexOf("new")).toBeGreaterThan(-1);
		expect(out.indexOf("mid")).toBeGreaterThan(-1);
		expect(out.indexOf("new")).toBeLessThan(out.indexOf("mid"));
		expect(out).not.toContain("old");
	});

	test("缺失字段以 - 呈现；isError 以 ok/blocked 可辨", () => {
		const out = formatAuditReport(
			toAuditViews([
				auditEntry({ tool: "ops_read_file", ts: t(1), authz: "read", isError: false }),
				auditEntry({ tool: "ops_service", ts: t(2), authz: "blocked", isError: true, reasonClass: "ERR_PERMISSION", reason: "[ERR_PERMISSION] guard-unattended" }),
			]),
			20,
		);
		expect(out).toContain("ok");
		expect(out).toContain("blocked");
		expect(out).toContain("ERR_PERMISSION");
		expect(out).toContain("guard-unattended");
		expect(out).toContain("class=-");
		expect(out).toContain("host=-");
	});

	test("reason 多行 → 单行化 + 超 160 字符截断加 …（T1）", () => {
		const long = "x".repeat(200);
		const out = formatAuditReport(
			toAuditViews([auditEntry({ tool: "ops_x", ts: t(1), isError: true, reason: `第一行\n第二行 ${long}` })]),
			20,
		);
		expect(out).toContain("第一行 第二行");
		expect(out).not.toContain("\n第二行");
		expect(out).toContain("…");
		const reasonLine = out.split("\n").find((l) => l.includes("ops_x"));
		expect(reasonLine?.length).toBeLessThan(200 + 60);
	});

	test("非法/缺失 ts 排到最后且显示 -", () => {
		const views = toAuditViews([
			auditEntry({ tool: "bad-ts", ts: "not-a-date" }),
			auditEntry({ tool: "good", ts: t(1) }),
			auditEntry({ tool: "no-ts" }),
		]);
		const out = formatAuditReport(views, 20);
		const iGood = out.indexOf("good");
		const iBad = out.indexOf("bad-ts");
		const iNo = out.indexOf("no-ts");
		expect(iGood).toBeGreaterThan(-1);
		expect(iGood).toBeLessThan(iBad);
		expect(iBad).toBeLessThan(iNo);
		expect(out).toContain("bad-ts");
	});

	test("truncated 标记 → 头部声明截断（T1）", () => {
		const out = formatAuditReport(toAuditViews([auditEntry({ tool: "a", ts: t(1) })]), 200, true);
		expect(out).toContain("已截断至 200 条上限");
	});
});
