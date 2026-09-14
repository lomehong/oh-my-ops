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

	async list(): Promise<KbEntryMeta[]> {
		await this.ensureDir();
		const out: KbEntryMeta[] = [];
		for (const f of (await fs.readdir(this.kbDir)).sort()) {
			if (!f.endsWith(".md")) continue;
			try {
				const text = await fs.readFile(path.join(this.kbDir, f), "utf8");
				const { meta } = parseFrontMatter(text);
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

	/** 大小写不敏感检索：命中标题或正文行，返回命中行（上限防刷屏） */
	async search(query: string, limit = 20): Promise<KbSearchHit[]> {
		const q = query.trim().toLowerCase();
		if (q === "") return [];
		const hits: KbSearchHit[] = [];
		for (const meta of await this.list()) {
			const entry = await this.read(meta.slug);
			if (entry === undefined) continue;
			const haystack = `${entry.title}\n${entry.tags.join(" ")}\n${entry.content}`.toLowerCase();
			if (!haystack.includes(q)) continue;
			const matchedLines = entry.content
				.split("\n")
				.filter((l) => l.toLowerCase().includes(q))
				.slice(0, 5);
			hits.push({ ...meta, matchedLines });
			if (hits.length >= limit) break;
		}
		return hits;
	}
}
