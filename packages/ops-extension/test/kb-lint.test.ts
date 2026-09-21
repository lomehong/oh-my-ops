import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { bigrams, buildComment, jaccard, lintSimilarity, lintStructure, parseDomainsYml, verifyHmac } from "../../../scripts/lib/kb-lint.mjs";

/**
 * KBORG-1 守卫：合流期 lint 规则引擎（scripts/lib/kb-lint.mjs）。
 * 结构规则=硬拦；相似度>0.9 硬拦、0.5~0.9 警示；语义判断不在引擎内（评审终审）。
 */

const DOMAINS_YML = "domains:\n  - omo-kb\n  - runbooks\nroot_allowlist:\n  - README.md\n  - domains.yml\nfallback: runbooks\n";

describe("parseDomainsYml", () => {
	test("解析域与根白名单；空输入 ⇒ undefined domains（结构规则跳过）", () => {
		const cfg = parseDomainsYml(DOMAINS_YML);
		expect(cfg.domains).toEqual(["omo-kb", "runbooks"]);
		expect(cfg.rootAllowlist).toEqual(["README.md", "domains.yml"]);
		expect(parseDomainsYml("").domains).toBeUndefined();
	});
});

describe("lintStructure", () => {
	test("域外根文件硬拦；活档案与白名单豁免；元数据缺失/不一致硬拦", () => {
		const contents = [
			{ path: "omo-kb/v0134-cache-note.md", text: "系统: omo-kb\n\n正文。\n" },
			{ path: "omo-kb/wrong-domain.md", text: "系统: yufu\n\n正文。\n" },
			{ path: "omo-kb/no-header.md", text: "没有头的正文。\n" },
			{ path: "scratch/loose.md", text: "随便。\n" },
		];
		const { hard, warnings, touchedDomains } = lintStructure({
			changedPaths: contents.map((c) => c.path),
			contents,
			domainsText: DOMAINS_YML,
		});
		const rules = hard.map((h) => h.rule);
		expect(rules).toContain("domain-mismatch");
		expect(rules).toContain("front-matter");
		expect(rules).toContain("domain-dir");
		expect(touchedDomains.has("omo-kb")).toBe(true);
		expect(warnings).toEqual([]);
	});
	test("domains.yml 缺失 ⇒ 结构规则跳过（警告），不误伤", () => {
		const { hard, warnings } = lintStructure({ changedPaths: ["whatever/x.md"], contents: [], domainsText: undefined });
		expect(hard).toEqual([]);
		expect(warnings.length).toBe(1);
	});
	test("活档案本身与白名单文件豁免", () => {
		const { hard } = lintStructure({
			changedPaths: ["omo-kb/README.md", "README.md", "domains.yml"],
			contents: [],
			domainsText: DOMAINS_YML,
		});
		expect(hard).toEqual([]);
	});
});

describe("bigram Jaccard", () => {
	test("同主题改写中等相似，无关文本不相似（实测定标：0.42 / 0）", () => {
		const a = "升级后页面拿旧缓存，需要 no-store 才能修复";
		const b = "升级后页面端出旧缓存，必须 no-store 方可修复";
		const c = "Gitea 子路径部署必须剥前缀，否则登录页 404";
		expect(jaccard(a, b)).toBeGreaterThan(0.35);
		expect(jaccard(a, c)).toBeLessThan(0.3);
	});
});

const SAME = "升级后页面拿旧缓存需要 no-store 才能修复浏览器缓存问题";
const OTHER = "Gitea 子路径部署必须剥前缀，否则登录页 404";
const WARN_VARIANT = "升级后页面拿旧缓存需要 no-store 才能修复，定位为浏览器缓存";
describe("lintSimilarity", () => {
	test("精确重复 ⇒ ≥0.9 硬拦；改写一半 ⇒ 0.5~0.9 警示；无关忽略", () => {
		const contents = [
			{ path: "omo-kb/new-note.md", text: SAME },
			{ path: "runbooks/warn-me.md", text: WARN_VARIANT },
			{ path: "runbooks/other.md", text: OTHER },
		];
		const existing = [{ domain: "omo-kb", path: "omo-kb/README.md", text: SAME + "。" }];
		const { hard, warnings } = lintSimilarity({ contents, existing, thresholds: { block: 0.9, warn: 0.5 } });
		expect(hard.some((h) => h.rule === "duplicate" && h.path.includes("omo-kb/README.md@main"))).toBe(true);
		expect(warnings.some((w) => w.includes("runbooks/warn-me.md"))).toBe(true);
		expect(hard.some((h) => h.path.includes("runbooks/other.md"))).toBe(false);
	});
});

describe("buildComment", () => {
	test("评论含违规与提示分组；全绿含 ✓", () => {
		const bad = buildComment({ mode: "strict", hard: [{ path: "x.md", rule: "front-matter", reason: "缺元数据" }], warnings: ["近似内容"] });
		expect(bad).toContain("✗ 硬性规则违规 1 条");
		expect(bad).toContain("⚠ 提示 1 条");
		const good = buildComment({ mode: "strict", hard: [], warnings: [] });
		expect(good).toContain("✓ 未发现违规");
	});
});
