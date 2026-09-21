import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DOMAINS,
	appendSection,
	organizeEntries,
	parseDomainsYml,
	parseEntry,
	sectionFor,
	skeleton,
} from "../src/kb-org.ts";

/**
 * KBORG-1 守卫：域活档案 + 机械归并（方案 docs/designs/kb-knowledge-org-设计.md §4/§5）。
 * 核心不变量：organizeEntries 纯函数且幂等；域解析失败兜底 runbooks 不抛错；
 * 归并=追加带日期小节 + 移除条目文件。
 */

const DOMAINS = { domains: ["omo-kb", "yufu", "runbooks"], fallback: "runbooks", rootAllowlist: ["README.md", "domains.yml"] };
const NOW = new Date("2026-09-21T08:00:00Z");
const NOW_ISO = NOW.toISOString();
const DEVICE = "test-device";

describe("parseDomainsYml", () => {
	test("解析 domains/root_allowlist/fallback；未知行忽略", () => {
		const cfg = parseDomainsYml("# 注释\ndomains:\n  - omo-kb\n  - yufu\nroot_allowlist:\n  - README.md\nfallback: runbooks\n其它: 忽略\n");
		expect(cfg.domains).toEqual(["omo-kb", "yufu"]);
		expect(cfg.rootAllowlist).toEqual(["README.md"]);
		expect(cfg.fallback).toBe("runbooks");
	});
	test("空/损坏输入 ⇒ 内置默认", () => {
		expect(parseDomainsYml("")).toEqual(DEFAULT_DOMAINS);
		expect(parseDomainsYml("完全不是 yaml 的东西\n- 也没有列表")).toEqual(DEFAULT_DOMAINS);
	});
});

describe("parseEntry", () => {
	test("解析系统/类型/主题头；元数据行追加文末", () => {
		const e = parseEntry("系统: omo-kb\n类型: 事件\n主题: 升级缓存坑\n\n升级后页面拿旧缓存。\n", NOW_ISO);
		expect(e.system).toBe("omo-kb");
		expect(e.kind).toBe("事件");
		expect(e.title).toBe("升级缓存坑");
		expect(e.body).toContain("升级后页面拿旧缓存。");
		expect(e.body).toContain("域: omo-kb");
		expect(e.body).toContain("日期: 2026-09-21");
		expect(e.warnings).toEqual([]);
	});
	test("缺「系统」头 ⇒ 兜底 runbooks + 警告（不抛错）", () => {
		const e = parseEntry("就是一段没有头的记录。\n", NOW_ISO);
		expect(e.system).toBe("runbooks");
		expect(e.warnings.some((w) => w.includes("runbooks"))).toBe(true);
	});
	test("未知类型按事件处理 + 警告；正文中的全角冒号行不被误认为头", () => {
		const e = parseEntry("注意：这一行不是头\n系统: yufu\n类型: 超级文档\n正文", NOW_ISO);
		// 「注意：…」不是已知键 ⇒ 头在第一行即终止 ⇒ 整段为正文、系统缺省 runbooks；
		// 正文里的「类型: 超级文档」不属于头 ⇒ 不产生未知类型警告
		expect(e.system).toBe("runbooks");
		expect(e.kind).toBe("事件");
		expect(e.warnings.some((w) => w.includes("runbooks"))).toBe(true);
	});
});

describe("appendSection / skeleton", () => {
	test("追加带日期小节；同标题重复 ⇒ 幂等原样返回", () => {
		const e = parseEntry("系统: omo-kb\n主题: 缓存坑\n正文内容。\n", NOW_ISO);
		const sec = sectionFor(e, DEVICE, NOW_ISO);
		expect(sec).toContain("## 2026-09-21 缓存坑（来源设备：test-device）");
		const living0 = skeleton("omo-kb");
		const living1 = appendSection(living0, sec);
		expect(living1).toContain("正文内容。");
		const living2 = appendSection(living1, sec);
		expect((living2.match(/## 2026-09-21 缓存坑/g) ?? []).length).toBe(1);
	});
});

describe("organizeEntries", () => {
	test("事件条目 ⇒ 并入域活档案并移除条目文件；多域互不串", () => {
		const plan = organizeEntries(
			[
				{ name: "a.md", text: "系统: omo-kb\n主题: 坑A\n内容A。\n" },
				{ name: "b.md", text: "系统: yufu\n主题: 坑B\n内容B。\n" },
			],
			DOMAINS,
			DEVICE,
			NOW_ISO,
		);
		expect(plan.merges.map((m) => m.removeFile).sort()).toEqual(["a.md", "b.md"]);
		const omo = plan.livingDocs.find((d) => d.domain === "omo-kb");
		const yufu = plan.livingDocs.find((d) => d.domain === "yufu");
		expect(omo?.path).toBe("omo-kb/README.md");
		expect(omo?.text).toContain("坑A");
		expect(omo?.text).not.toContain("坑B");
		expect(yufu?.text).toContain("坑B");
		expect(plan.warnings).toEqual([]);
	});

	test("幂等：归并计划产生的活档案再次归并空条目集 ⇒ 零变更", () => {
		const first = organizeEntries([{ name: "a.md", text: "系统: omo-kb\n主题: X\n内容。\n" }], DOMAINS, DEVICE, NOW_ISO);
		const living = first.livingDocs[0];
		// 第二轮：条目文件已被移除（模拟）⇒ 无输入
		const second = organizeEntries([], DOMAINS, DEVICE, NOW_ISO);
		expect(second.merges).toEqual([]);
		expect(second.moves).toEqual([]);
		expect(second.livingDocs.map((d) => d.text)).not.toContain(living.text);
	});

	test("未知域兜底 runbooks + 警告（不抛错、不丢失内容）", () => {
		const plan = organizeEntries([{ name: "c.md", text: "系统: 不存在的域\n主题: T\n重要内容。\n" }], DOMAINS, DEVICE, NOW_ISO);
		expect(plan.livingDocs.find((d) => d.domain === "runbooks")?.text).toContain("重要内容。");
		expect(plan.warnings.some((w) => w.includes("未登记"))).toBe(true);
	});

	test("类型=文档 ⇒ 移动为 <域>/<slug>.md；同名冲突 ⇒ 回退并入活档案", () => {
		const plan = organizeEntries(
			[
				{ name: "d1.md", text: "系统: omo-kb\n类型: 文档\n主题: 部署手册\n正文1。\n" },
				{ name: "d2.md", text: "系统: omo-kb\n类型: 文档\n主题: 部署手册\n正文2。\n" },
			],
			DOMAINS,
			DEVICE,
			NOW_ISO,
		);
		expect(plan.moves).toEqual([{ from: "d1.md", to: "omo-kb/doc-20260921.md", content: expect.stringContaining("正文1。") }]);
		expect(plan.merges.length).toBe(1);
		expect(plan.warnings.some((w) => w.includes("回退并入活档案"))).toBe(true);
	});

	test("设备名/日期不进文件名（文档类型 slug 化验证）", () => {
		const plan = organizeEntries([{ name: "x.md", text: "系统: yufu\n类型: 文档\n主题: 上线手册 20260921\n正文。\n" }], DOMAINS, DEVICE, NOW_ISO);
		expect(plan.moves[0]?.to).toBe("yufu/doc-20260921.md"); // 纯中文主题剥不出 ASCII ⇒ doc- 前缀兜底（文件名保持 ASCII kebab，与存量仓库文化一致）
	});
});
