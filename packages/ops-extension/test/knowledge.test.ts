import { describe, expect, test } from "bun:test";
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
			fs.rmSync(base, { recursive: true, force: true });
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
