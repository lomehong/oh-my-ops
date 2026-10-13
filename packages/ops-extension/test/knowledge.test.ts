import { describe, expect, test } from "bun:test";
import { rmTempSync } from "./tmp-cleanup.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeStore, slugify } from "../src/knowledge.ts";
import { gitSync } from "../src/tools/knowledge.ts";
import { ShellExec } from "@ops-pi/core";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-"));
}

describe("KnowledgeStore", () => {
	test("save → list → read 往返；slug 穿越防护", async () => {
		const store = new KnowledgeStore(tmpDir());
		await store.save("../../etc/passwd", "尝试穿越", "内容不该出现在 /etc");
		const items = await store.list();
		expect(items.length).toBe(1);
		expect(items[0]!.file).not.toContain("..");
		expect(items[0]!.file).not.toContain("/");
		const entry = await store.read(items[0]!.slug);
		expect(entry !== undefined && entry.content.includes("不该出现")).toBe(true);
	});

	// 回归：list() 曾改为「只读文件头固定 4KB」以省I/O，超长 tags 会让闭合 `---`
	// 落在窗口外 ⇒ 正则匹配失败 ⇒ meta 静默全丢（标题退化成文件名、tags/时间戳消失）。
	// 修复为「增量读到 front-matter 闭合为止」，此处固化该场景。
	test("★ front-matter 超长时 list() 仍完整解析（不得因读窗口截断而丢 meta）", async () => {
		const store = new KnowledgeStore(tmpDir());
		const manyTags = Array.from({ length: 900 }, (_, i) => `tag${i}`);
		await store.save("huge-tags", "超长标签标题", "正文内容", manyTags);
		// 大正文条目：验证增量读取在 front-matter 闭合后即停，不受正文长度影响
		await store.save("big-body", "大正文标题", "X".repeat(200 * 1024), ["z"]);

		const byslug = new Map((await store.list()).map((m) => [m.slug, m]));
		const huge = byslug.get("huge-tags")!;
		expect(huge.title).toBe("超长标签标题"); // 未退化为文件名
		expect(huge.tags.length).toBe(900);
		expect(huge.createdAt).not.toBe("");
		const big = byslug.get("big-body")!;
		expect(big.title).toBe("大正文标题");
		expect(big.tags).toEqual(["z"]);

		const hits = await store.search("超长", 5);
		expect(hits.length).toBe(1);
		expect(hits[0]!.title).toBe("超长标签标题");
	});

	test("save 覆盖保留 createdAt；search 命中标题/标签/正文", async () => {
		const store = new KnowledgeStore(tmpDir());
		const first = await store.save("disk-full", "磁盘满处置", "现象：/ 使用率 100%。处置：log-rotate。", ["disk"]);
		await store.save("disk-full", "磁盘满处置 v2", "现象：/ 使用率 100%。处置：log-rotate + 清理 docker 日志。", ["disk"]);
		const entry = await store.read("disk-full");
		expect(entry !== undefined && entry.createdAt === first.createdAt && entry.updatedAt >= first.createdAt).toBe(true);

		const hits = await store.search("log-rotate");
		expect(hits.length).toBe(1);
		expect(hits[0]?.title).toContain("磁盘");
		expect((await store.search("不存在的关键词")).length === 0).toBe(true);
	});

	test("search 大小写不敏感；空查询返回空", async () => {
		const store = new KnowledgeStore(tmpDir());
		await store.save("nginx-502", "Nginx 502 排查", "upstream 超时导致 502。检查 backend 健康。");
		expect((await store.search("NGINX")).length).toBe(1);
		expect((await store.search("502")).length).toBe(1);
		expect((await store.search("")).length).toBe(0);
	});
});

describe("gitSync（工具层包装：本地模式 + 分支纪律）", () => {
	// 完整的两节点/中心合流端到端见 kb-sync.test.ts（分支纪律由 syncKb 承载，此处只验工具层包装）
	test("save → sync(push) → 推的是 instance/<device>，main 不被触碰", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-git-"));
		const remote = path.join(base, "remote.git");
		fs.mkdirSync(remote, { recursive: true });
		await new ShellExec().exec(["git", "init", "--bare", "--initial-branch=main", remote], { timeoutMs: 15_000 });
		const node = path.join(base, "node-a");
		const kbDir = path.join(node, "knowledge");
		fs.mkdirSync(kbDir, { recursive: true });
		const store = new KnowledgeStore(kbDir);
		await store.save("runbook-502", "Nginx 502 Runbook", "现象/根因/处置。", ["nginx"]);

		const saved = process.env.YUYI_DEVICE;
		process.env.YUYI_DEVICE = "node-a";
		try {
			const r = await gitSync(node, kbDir, remote, "main", new ShellExec());
			expect(r.actions.join(" ")).toContain("push instance/node-a ✓");
			expect(r.actions.join(" ")).not.toContain("push main");
			const branches = await new ShellExec().exec(["git", "--git-dir", remote, "branch", "--list", "--format=%(refname:short)"], { timeoutMs: 15_000 });
			expect(branches.stdout).toContain("instance/node-a");
			expect(branches.stdout).not.toContain("main");
		} finally {
			if (saved === undefined) delete process.env.YUYI_DEVICE;
			else process.env.YUYI_DEVICE = saved;
			rmTempSync(base);
		}
	});

	test("无远端 = 本地模式：sync 不报错、本地条目保留", async () => {
		const dir = tmpDir();
		const kbDir = path.join(dir, "knowledge");
		fs.mkdirSync(kbDir, { recursive: true });
		const store = new KnowledgeStore(kbDir);
		await store.save("local-only", "仅本地", "内容");
		const r = await gitSync(dir, kbDir, undefined, "main", new ShellExec());
		expect(r.actions.length).toBeGreaterThan(0);
		expect((await store.read("local-only"))?.content).toBe("内容");
	});
});
