import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface KbEntryMeta {
	file: string;
	slug: string;
	title: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

export interface KbEntry extends KbEntryMeta {
	content: string;
}

export interface KbSearchHit extends KbEntryMeta {
	matchedLines: string[];
}

const MAX_BYTES = 256 * 1024;
/** front-matter 起始探测窗口：首读块大小；不够则按需增量读到闭合 `---` 为止 */
const HEAD_CHUNK = 4 * 1024;
/** front-matter 硬上限：超过此值视为无 front-matter（防御超长 tags 列表拖垮 list()） */
const MAX_FRONTMATTER = 64 * 1024;
/** list/search 返回条目数上限：条目数无界增长时防止撑爆模型上下文 */
const MAX_ENTRIES = 500;
/** 单次检索返回上限（模型上下文保护） */
const MAX_SEARCH_HITS = 200;

/**
 * front-matter 是否已闭合（读到 `---` 结束行）。
 * ★ 必须按「闭合」判定而非固定字节数——固定 4KB 会在 tags 列表较长时读到半截 front-matter，
 *   正则匹配不到闭合标记 ⇒ meta 全丢（标题回退成文件名、tags/时间戳消失），
 *   这正是为省 I/O 引入 readHead() 时踩到的坑（CI 的 knowledge 用例即栽在这里）。
 */
function frontMatterClosed(text: string): boolean {
	return /^---\n[\s\S]*?\n---\n?/.test(text);
}

/** slug → 安全文件名（防路径穿越/非法字符） */
export function slugify(raw: string): string {
	const s = raw
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return s === "" ? "untitled" : s;
}

/** 解析简易 front-matter（--- 包裹的 key: value / tags: [a,b]） */
function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
	if (m === null || m[1] === undefined) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
		if (kv && kv[1] !== undefined && kv[2] !== undefined) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^\[|\]$/g, "");
	}
	return { meta, body: text.slice(m[0].length) };
}

/** 知识库（P15）：~/.omo/knowledge/ 下的 markdown 条目（Runbook/案例/偏好）。
 *  定位：vault 存凭据，知识库存处置知识——Agent 越用越懂环境。 */
export class KnowledgeStore {
	constructor(readonly kbDir: string) {}

	async ensureDir(): Promise<void> {
		await fs.mkdir(this.kbDir, { recursive: true });
	}

	/** 知识库内的 .md 文件名（已排序、已限量）；子目录的域活档案不在清单范围内 */
	private async entryFiles(): Promise<string[]> {
		const names = (await fs.readdir(this.kbDir).catch(() => [] as string[]))
			.filter((f) => f.endsWith(".md") && !f.startsWith("."))
			.sort()
			.slice(0, MAX_ENTRIES);
		return names;
	}

	/**
	 * 读 front-matter（增量读到闭合为止）。
	 *
	 * list() 只需 meta（title/tags/时间），无需整篇正文——此前为取标题读完整文件，
	 * 条目数增长后 list() 线性变慢，而它是 ops_kb_list / ops_kb_search 的高频入口。
	 *
	 * 读取策略：分块读，**直到 front-matter 闭合或触达 MAX_FRONTMATTER 上限**才停。
	 * 固定字节数截断是错的：超长 tags 会让闭合 `---` 落在窗口之外，
	 * 导致 meta 静默全丢（标题退化成文件名、tags/时间戳消失）。
	 */
	private async readFrontMatter(file: string): Promise<string> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(path.join(this.kbDir, file), "r");
			const parts: Buffer[] = [];
			let read = 0;
			for (;;) {
				const buf = Buffer.alloc(HEAD_CHUNK);
				const { bytesRead } = await handle.read(buf, 0, HEAD_CHUNK, read);
				if (bytesRead === 0) break;
				parts.push(buf.subarray(0, bytesRead));
				read += bytesRead;
				if (frontMatterClosed(Buffer.concat(parts).toString("utf8"))) break;
				if (read >= MAX_FRONTMATTER) break;
			}
			return Buffer.concat(parts).toString("utf8");
		} catch {
			return "";
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	async list(): Promise<KbEntryMeta[]> {
		await this.ensureDir();
		const out: KbEntryMeta[] = [];
		for (const f of await this.entryFiles()) {
			try {
				const { meta } = parseFrontMatter(await this.readFrontMatter(f));
				out.push({
					file: f,
					slug: f.replace(/\.md$/, ""),
					title: meta.title ?? f.replace(/\.md$/, ""),
					tags: meta.tags ? meta.tags.split(",").map((x) => x.trim()).filter(Boolean) : [],
					createdAt: meta.created ?? "",
					updatedAt: meta.updated ?? "",
				});
			} catch {
				// 单文件损坏不阻塞清单
			}
		}
		return out;
	}

	async save(slug: string, title: string, content: string, tags: string[] = []): Promise<KbEntryMeta> {
		await this.ensureDir();
		const file = `${slugify(slug)}.md`;
		const full = path.join(this.kbDir, file);
		const now = new Date().toISOString();
		let createdAt = now;
		try {
			const prev = parseFrontMatter(await fs.readFile(full, "utf8"));
			createdAt = prev.meta.created ?? now;
		} catch {
			// 新条目
		}
		const text = `---\ntitle: ${title || slug}\ntags: [${tags.join(", ")}]\ncreated: ${createdAt}\nupdated: ${now}\n---\n${content}`;
		if (Buffer.byteLength(text) > MAX_BYTES) {
			throw new Error(`知识条目过大（>${MAX_BYTES} 字节）`);
		}
		await fs.writeFile(full, text, "utf8");
		return { file, slug: file.replace(/\.md$/, ""), title: title || slug, tags, createdAt, updatedAt: now };
	}

	async read(slug: string): Promise<KbEntry | undefined> {
		const file = `${slugify(slug)}.md`;
		const text = await fs.readFile(path.join(this.kbDir, file), "utf8").catch(() => undefined);
		if (text === undefined) return undefined;
		const { meta, body } = parseFrontMatter(text);
		return {
			file,
			slug: file.replace(/\.md$/, ""),
			title: meta.title ?? slug,
			tags: meta.tags ? meta.tags.split(",").map((x) => x.trim()).filter(Boolean) : [],
			createdAt: meta.created ?? "",
			updatedAt: meta.updated ?? "",
			content: body,
		};
	}

	/**
	 * 大小写不敏感检索：命中标题或正文行，返回命中行（上限防刷屏）。
	 *
	 * 实现说明（审查 5.1）：此前先 list() 再对每个条目 read() —— 同一文件被读两遍（N 个条目 2N 次 I/O），
	 * 且 list() 内又各读一次全文，实际 3N 次。现改为**单次遍历**：枚举文件 → 读一次 → 同时产出 meta 与命中，
	 * 命中数达 limit 即停（避免无谓读完全库）。
	 */
	async search(query: string, limit = 20): Promise<KbSearchHit[]> {
		const q = query.trim().toLowerCase();
		if (q === "") return [];
		// limit 夹取：NaN/≤0 会让 `hits.length >= limit` 恒真（空结果），负数同理
		const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_SEARCH_HITS) : 20;
		await this.ensureDir();
		const hits: KbSearchHit[] = [];
		for (const f of await this.entryFiles()) {
			if (hits.length >= capped) break;
			const text = await fs.readFile(path.join(this.kbDir, f), "utf8").catch(() => undefined);
			if (text === undefined) continue;
			const { meta, body } = parseFrontMatter(text);
			const haystack = `${meta.title ?? ""}\n${meta.tags ?? ""}\n${body}`.toLowerCase();
			if (!haystack.includes(q)) continue;
			hits.push({
				file: f,
				slug: f.replace(/\.md$/, ""),
				title: meta.title ?? f.replace(/\.md$/, ""),
				tags: meta.tags ? meta.tags.split(",").map((x) => x.trim()).filter(Boolean) : [],
				createdAt: meta.created ?? "",
				updatedAt: meta.updated ?? "",
				matchedLines: body
					.split("\n")
					.filter((l) => l.toLowerCase().includes(q))
					.slice(0, 5),
			});
		}
		return hits;
	}
}
