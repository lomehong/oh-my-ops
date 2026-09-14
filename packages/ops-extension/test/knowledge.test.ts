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

describe("gitSync（两节点共享真源）", () => {
	test("save → sync push → 第二节点 sync pull 可见（file:// 远端，无网络）", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-git-"));
		const remote = path.join(base, "remote.git");
		// 建裸远端（模拟 GitHub 真源）
		fs.mkdirSync(remote);
		new ShellExec().exec(["git", "init", "--bare", "-b", "main", remote], { timeoutMs: 15_000 });

		const nodeA = path.join(base, "node-a");
		const storeA = new KnowledgeStore(nodeA);
		await storeA.save("runbook-502", "Nginx 502 Runbook", "现象/根因/处置。", ["nginx"]);
		const runnerA = new ShellExec();
		const r1 = await gitSync(nodeA, remote, "main", runnerA);
		expect(r1.actions.join(" ")).toContain("push ✓");

		// 节点 B：空目录 → sync 拉取真源
		const nodeB = path.join(base, "node-b");
		fs.mkdirSync(nodeB);
		const storeB = new KnowledgeStore(nodeB);
		const runnerB = new ShellExec();
		const r2 = await gitSync(nodeB, remote, "main", runnerB);
		expect(r2.actions.join(" ")).toContain("pull");

		const seen = await storeB.read("runbook-502");
		expect(seen?.title).toBe("Nginx 502 Runbook");
		expect(seen?.content).toContain("现象");
	});

	test("无远端 = 本地模式：sync 不报错、本地条目保留", async () => {
		const dir = tmpDir();
		const store = new KnowledgeStore(dir);
		await store.save("local-only", "仅本地", "内容");
		const runner = new ShellExec();
		const r = await gitSync(dir, undefined, "main", runner);
		expect(r.actions.length).toBeGreaterThan(0);
		expect((await store.read("local-only"))?.content).toBe("内容");
	});
});
