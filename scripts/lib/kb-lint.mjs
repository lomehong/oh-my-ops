/**
 * kb-lint.mjs —— 知识合流期 lint 规则引擎（KBORG-1；零依赖，服务私有域可用）
 *
 * 分层契约（方案 docs/designs/kb-knowledge-org-设计.md §1）：
 *   - 硬拦（strict 模式 status=failure）：路径白名单 / 文件名 kebab / 文首元数据「系统:」存在且与目录一致；
 *   - 警告（PR 评论）：相似度 0.5~0.9；>0.9 升级硬拦（疑似重复，须合并）；
 *   - 语义级判断（该沉淀进活档案哪一节）**不在本引擎**——机器给相似度证据，评审终审。
 *
 * 与 packages/ops-extension/src/kb-org.ts（实例侧）刻意**互不导入**：两侧运行时不同
 * （实例=TS/bun monorepo；服务=私有域零依赖 .mjs），域解析语义保持一致（同 kb-audit 先例）。
 */
import * as crypto from "node:crypto";

export const DEFAULT_ROOT_ALLOWLIST = ["README.md", "PREFIX-REGISTRY.md", "domains.yml"];

/** 解析 domains.yml 极小子集（与实例侧 kb-org.parseDomainsYml 同语义） */
export function parseDomainsYml(text) {
	const domains = [];
	const rootAllowlist = [];
	let fallback = "";
	let section = "";
	for (const rawLine of String(text ?? "").split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (!/^\s/.test(line)) section = /^([A-Za-z_]+):/.exec(line)?.[1] ?? "";
		const item = /^-\s*(\S+)\s*$/.exec(line.trim());
		if (item !== null) {
			if (section === "domains") domains.push(item[1]);
			if (section === "root_allowlist") rootAllowlist.push(item[1]);
			continue;
		}
		const kv = /^([A-Za-z_]+):\s*(\S+)\s*$/.exec(line.trim());
		if (kv !== null && kv[1] === "fallback") fallback = kv[2];
	}
	return {
		domains: domains.length > 0 ? domains : undefined,
		fallback: fallback !== "" ? fallback : "runbooks",
		rootAllowlist: rootAllowlist.length > 0 ? rootAllowlist : DEFAULT_ROOT_ALLOWLIST,
	};
}

/** 中文友好 bigram 集合（零分词依赖：相邻字符对 + ASCII 词） */
export function bigrams(text) {
	const s = String(text ?? "").toLowerCase().replace(/\s+/g, " ");
	const set = new Set();
	const asciiWords = s.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
	for (const w of asciiWords) set.add(`w:${w}`);
	const cjk = s.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of cjk) for (let i = 0; i + 1 < run.length; i++) set.add(run.slice(i, i + 2));
	return set;
}

/** Jaccard 相似度（0~1；双方皆空 ⇒ 0） */
export function jaccard(aText, bText) {
	const a = bigrams(aText);
	const b = bigrams(bText);
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

/** 剥条目头（系统/类型/主题三行）⇒ 纯正文（比对粒度对齐：头是样板，不参与相似度） */
export function stripEntryHeader(text) {
	const lines = String(text ?? "").split("\n");
	let i = 0;
	for (; i < lines.length; i++) {
		if (!/^(系统|类型|主题):\s*/.test(lines[i])) break;
	}
	return lines.slice(i).join("\n").trim();
}

/** 活档案切节：按 `## ` 标题切成小节块（导言也算一块）⇒ 小节级相似度比对 */
export function sectionsOf(text) {
	const blocks = [];
	let heading = "";
	let cur = [];
	for (const line of String(text ?? "").split("\n")) {
		if (line.startsWith("## ")) {
			if (cur.join("\n").trim() !== "") blocks.push({ heading, body: cur.join("\n").trim() });
			heading = line.replace(/^##\s*/, "");
			cur = [];
			continue;
		}
		cur.push(line);
	}
	if (cur.join("\n").trim() !== "") blocks.push({ heading, body: cur.join("\n").trim() });
	return blocks;
}

/**
 * 路径结构规则（硬拦）：域白名单 / 根目录白名单 / 文件名 kebab / 元数据一致性。
 * @param {object} p { changedPaths: string[], contents: {path,text}[], domainsText?: string }
 */
export function lintStructure({ changedPaths = [], contents = [], domainsText }) {
	const cfg = domainsText === undefined ? undefined : parseDomainsYml(domainsText);
	const domains = cfg?.domains;
	const rootAllow = new Set([...(cfg?.rootAllowlist ?? DEFAULT_ROOT_ALLOWLIST), "domains.yml"]);
	const hard = [];
	const warnings = [];
	const touchedDomains = new Set();
	for (const p of changedPaths) {
		const top = p.split("/")[0];
		if (domains !== undefined && domains.includes(top)) {
			touchedDomains.add(top);
			const base = p.slice(top.length + 1);
			if (base === "" || base === "README.md") continue; // 活档案本身
			if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.(md|json)$/.test(base)) {
				hard.push({ path: p, rule: "filename", reason: "文件名需 kebab-case（小写字母/数字/连字符；archive/ 子层可隔层）" });
				continue;
			}
			if (/\.md$/.test(base)) {
				const c = contents.find((x) => x.path === p);
				if (c !== undefined) {
					const sys = /^系统:\s*(\S+)/m.exec(c.text)?.[1];
					if (sys === undefined) hard.push({ path: p, rule: "front-matter", reason: "缺少首行元数据「系统: <域>」" });
					else if (sys !== top) hard.push({ path: p, rule: "domain-mismatch", reason: `元数据 系统:${sys} 与目录 ${top} 不一致` });
				}
			}
			continue;
		}
		if (rootAllow.has(p)) continue;
		if (domains === undefined) {
			warnings.push(`domains.yml 缺失：跳过结构规则（${p}）`);
			continue;
		}
		hard.push({ path: p, rule: "domain-dir", reason: `不在任何已登记域目录内（顶层「${top}」未登记；通用排查放 runbooks/）` });
	}
	return { hard, warnings, touchedDomains };
}

/**
 * 相似度规则：新条目正文 vs ①域活档案（main 版）整体与小节 ②PR 内其它新文件。
 * 整文件比对会被标题/样板稀释 ⇒ 以「剥头正文」与「小节」为粒度（真机教训：0.9 阈值在整文件粒度下形同虚设）。
 */
export function lintSimilarity({ contents = [], existing = [], thresholds = { block: 0.9, warn: 0.5 } }) {
	const hard = [];
	const warnings = [];
	const pairs = [];
	const newBodies = contents.map((c) => ({ path: c.path, text: stripEntryHeader(c.text) }));
	const existBodies = [];
	for (const e of existing) {
		existBodies.push({ path: `${e.path}@main`, text: stripEntryHeader(e.text) });
		for (const sec of sectionsOf(e.text)) {
			existBodies.push({ path: `${e.path}@main#${sec.heading.slice(0, 40)}`, text: sec.body });
		}
	}
	for (const a of newBodies) {
		for (const b of existBodies) {
			const score = Math.round(jaccard(a.text, b.text) * 100) / 100;
			if (score < thresholds.warn) continue;
			pairs.push({ a: a.path, b: b.path, score });
			if (score >= thresholds.block) hard.push({ path: `${a.path} ↔ ${b.path}`, rule: "duplicate", reason: `相似度 ${score} ≥ ${thresholds.block}：疑似重复，请合并进活档案对应小节` });
			else warnings.push(`近似内容：${a.path} ↔ ${b.path}（相似度 ${score}），请评审确认`);
		}
	}
	return { hard, warnings, pairs };
}

/** 组装 PR 评论正文（中文；不含任何秘密） */
export function buildComment({ mode, hard, warnings }) {
	const lines = [`kb-lint（模式：${mode}）`];
	if (hard.length > 0) {
		lines.push("", `✗ 硬性规则违规 ${hard.length} 条：`);
		for (const h of hard) lines.push(`- ${h.path} —— ${h.rule}：${h.reason}`);
	}
	if (warnings.length > 0) {
		lines.push("", `⚠ 提示 ${warnings.length} 条：`);
		for (const w of warnings) lines.push(`- ${w}`);
	}
	if (hard.length === 0 && warnings.length === 0) lines.push("", "✓ 未发现违规。");
	return lines.join("\n");
}

/** 常数时间 HMAC-SHA256 校验（webhook 防伪造） */
export function verifyHmac(secret, body, signatureHex) {
	if (typeof secret !== "string" || secret === "" || typeof signatureHex !== "string") return false;
	const expect = crypto.createHmac("sha256", secret).update(String(body)).digest("hex");
	const a = Buffer.from(expect);
	const b = Buffer.from(signatureHex.toLowerCase());
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
