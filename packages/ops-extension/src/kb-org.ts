/**
 * kb-org.ts —— 知识条目组织纯函数（KBORG-1：域活档案 + 机械归并）
 *
 * 设计：docs/designs/kb-knowledge-org-设计.md
 *
 * 核心不变量：
 *   - organizeEntries 是**纯函数**：同样输入永远产出同样计划（归并后条目文件被移除 ⇒ 天然幂等）；
 *   - 域解析失败一律兜底 fallback 域（runbooks）并记 warning，**绝不抛错**阻塞 sync；
 *   - 每域唯一活档案 `<域>/README.md`，是域内知识唯一容器；
 *   - 文件名不带设备名/日期（设备与日期进文首元数据）。
 */

export interface DomainsConfig {
	/** 已登记域清单（kebab-case） */
	domains: string[];
	/** 兜底域：条目缺「系统」头或域未登记时落这里 */
	fallback: string;
	/** 根目录白名单：这些根级文件不参与归并 */
	rootAllowlist: string[];
}

export const DEFAULT_DOMAINS: DomainsConfig = {
	domains: ["avatar", "omo-kb", "yufu", "huntian", "twin-hzins", "yuyi", "yuheng", "runbooks", "docseal"],
	fallback: "runbooks",
	rootAllowlist: ["README.md", "PREFIX-REGISTRY.md", "domains.yml"],
};

/** 解析 domains.yml 极小子集：`domains:`/`root_allowlist:` 下的 `- <名>` 列表、顶层 `fallback: <名>`；未知行忽略。解析失败/为空 ⇒ 内置默认。 */
export function parseDomainsYml(text: string): DomainsConfig {
	const domains: string[] = [];
	const rootAllowlist: string[] = [];
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
		domains: domains.length > 0 ? domains : DEFAULT_DOMAINS.domains,
		fallback: fallback !== "" ? fallback : DEFAULT_DOMAINS.fallback,
		rootAllowlist: rootAllowlist.length > 0 ? rootAllowlist : DEFAULT_DOMAINS.rootAllowlist,
	};
}

/** 工作树根的 domains.yml 文本 ⇒ 配置（不存在 ⇒ 内置默认） */
export async function loadDomains(kbDir: string, readFile: (p: string) => Promise<string>): Promise<DomainsConfig> {
	try {
		return parseDomainsYml(await readFile(`${kbDir}/domains.yml`));
	} catch {
		return DEFAULT_DOMAINS;
	}
}

const KINDS = ["事件", "文档", "runbook"] as const;
export type EntryKind = (typeof KINDS)[number];

export interface ParsedEntry {
	system: string;
	kind: EntryKind;
	title: string;
	body: string;
	warnings: string[];
}

/** 解析条目头：文首连续的「系统|类型|主题: 值」行；其余视为正文。缺「系统」⇒ runbooks 兜底 + 警告。 */
export function parseEntry(text: string, dateIso: string): ParsedEntry {
	const warnings: string[] = [];
	const lines = String(text ?? "").replace(/^\uFEFF/, "").split("\n");
	const header: Record<string, string> = {};
	let bodyStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = /^(系统|类型|主题):\s*(.*)\s*$/.exec(lines[i]);
		if (m === null) {
			bodyStart = i;
			break;
		}
		header[m[1]] = m[2].trim();
		bodyStart = i + 1;
	}
	const systemRaw = header["系统"] ?? "";
	if (systemRaw === "") warnings.push("缺少「系统:」头，兜底 runbooks 域");
	const kindRaw = header["类型"] ?? "事件";
	const kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EntryKind) : "事件";
	if (kindRaw !== "" && !(KINDS as readonly string[]).includes(kindRaw)) warnings.push(`未知类型「${kindRaw}」，按「事件」处理`);
	const date = dateIso.slice(0, 10);
	const bodyLines = lines.slice(bodyStart).join("\n").replace(/^\n+/, "");
	const firstLine = bodyLines.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "";
	return {
		system: systemRaw !== "" ? systemRaw : "runbooks",
		kind,
		title: header["主题"] !== undefined && header["主题"] !== "" ? header["主题"] : firstLine.slice(0, 48) || date,
		body: `${bodyLines.replace(/\s*$/, "")}\n\n---\n域: ${systemRaw !== "" ? systemRaw : "runbooks"} | 来源设备见小节标题 | 日期: ${date}`,
		warnings,
	};
}

/** 活档案小节：`## <日期> <主题>（来源设备：<设备>）` + 正文（正文已含元数据行） */
export function sectionFor(entry: ParsedEntry, device: string, dateIso: string): string {
	const date = dateIso.slice(0, 10);
	return `## ${date} ${entry.title}（来源设备：${device}）\n\n${entry.body.replace(/\s*$/, "")}\n`;
}

/** 向活档案追加小节；幂等：同标题小节已存在则原样返回 */
export function appendSection(living: string, section: string): string {
	const heading = section.split("\n")[0] ?? "";
	if (heading !== "" && String(living ?? "").includes(`\n${heading}\n`)) return String(living ?? "");
	const base = String(living ?? "").replace(/\s*$/, "");
	return `${base}\n\n${section}`.replace(/^\n+/, "");
}

export function skeleton(domain: string): string {
	return `# ${domain} 知识活档案\n\n> 本文件是「${domain}」域知识的**唯一容器**：新知识以带日期小节追加于此，请勿另开事件文件。\n`;
}

export interface OrganizeInput {
	/** 根目录条目文件名（相对 kbDir） */
	name: string;
	text: string;
}

export interface OrganizePlan {
	/** 归并：条目文件内容并入域活档案后，原文件应被移除 */
	merges: { removeFile: string; domain: string }[];
	/** 归并后的活档案最终文本（调用方写盘） */
	livingDocs: { domain: string; path: string; text: string }[];
	/** 独立文档移动（类型=文档 且目标名不冲突） */
	moves: { from: string; to: string; content: string }[];
	warnings: string[];
}

const slug = (s: string, dateIso: string) => {
	let v = s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	if (v === "" || /^\d+$/.test(v)) v = `doc-${v || dateIso.slice(0, 10).replace(/-/g, "")}`; // 纯中文标题剥不出 ASCII ⇒ doc- 前缀兜底
	return v;
};

/**
 * 组织根目录条目（KBORG-1 核心）：
 *   - `类型=事件`（缺省）/`runbook` ⇒ 并入 `<域>/README.md` 活档案（追加带日期小节）+ 移除条目文件；
 *   - `类型=文档` ⇒ 移动为 `<域>/<slug>.md`；目标名冲突 ⇒ 回退并入活档案 + 警告；
 *   - 域未登记/缺头 ⇒ 兜底 fallback（runbooks）+ 警告。
 * 幂等：归并过的条目文件已移除 ⇒ 重复调用零变更。
 */
export function organizeEntries(
	entries: OrganizeInput[],
	domains: DomainsConfig,
	device: string,
	dateIso: string,
	existingLiving: { domain: string; text: string }[] = [],
): OrganizePlan {
	const plan: OrganizePlan = { merges: [], livingDocs: [], moves: [], warnings: [] };
	const living = new Map<string, string>();
	for (const base of existingLiving) living.set(base.domain, base.text);
	for (const e of entries) {
		const parsed = parseEntry(e.text, dateIso);
		plan.warnings.push(...parsed.warnings.map((w) => `${e.name}: ${w}`));
		let domain = parsed.system;
		if (!domains.domains.includes(domain)) {
			plan.warnings.push(`${e.name}: 域「${domain}」未登记（domains.yml），兜底 ${domains.fallback}`);
			domain = domains.fallback;
		}
		const livingPath = `${domain}/README.md`;
		if (!living.has(domain)) living.set(domain, living.get(domain) ?? "");
		if (parsed.kind === "文档") {
			const to = `${domain}/${slug(parsed.title, dateIso)}.md`;
			const taken = plan.moves.some((m) => m.to === to) || (living.get(domain) ?? "").includes(`<a name="${to}"></a>`);
			if (taken) {
				plan.warnings.push(`${e.name}: 目标 ${to} 已存在，回退并入活档案`);
			} else {
				plan.moves.push({ from: e.name, to, content: e.text });
				continue;
			}
		}
		const section = sectionFor(parsed, device, dateIso);
		living.set(domain, appendSection(living.get(domain) ?? skeleton(domain), section));
		plan.merges.push({ removeFile: e.name, domain });
	}
	for (const [domain, base] of living) {
		let text = base;
		if (text === "" && !existingLiving.some((b) => b.domain === domain)) text = skeleton(domain); // 空且无基底 ⇒ 骨架
		plan.livingDocs.push({ domain, path: `${domain}/README.md`, text });
	}
	return plan;
}
