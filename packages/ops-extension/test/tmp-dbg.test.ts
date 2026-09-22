import { describe, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ShellExec } from "@ops-pi/core";
import { syncKb } from "../src/kb-sync.ts";

describe("DBG", () => {
	test("分支纪律复刻", async () => {
		const shell = new ShellExec();
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-kb-dbg1-"));
		const bare = path.join(base, "origin.git");
		fs.mkdirSync(bare, { recursive: true });
		const dirs = { a: path.join(base, "node-a"), b: path.join(base, "node-b") };
		fs.mkdirSync(dirs.a, { recursive: true });
		fs.mkdirSync(dirs.b, { recursive: true });
		await shell.exec(["git", "init", "--bare", "-b", "main", bare], { timeoutMs: 30_000 });

		fs.writeFileSync(path.join(dirs.a, "knowledge", "runbook-502.md"), "# Runbook 502\n现象/根因/处置\n");
		const ra = await syncKb({ omoDir: dirs.a, kbDir: dirs.a, repo: bare, branch: "main", device: "node-a", runner: shell, push: true });
		console.log("A-actions:", JSON.stringify(ra.actions));
		console.log("A-instance-tree:", (await shell.exec(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "instance/node-a"], { timeoutMs: 30_000 })).stdout.trim().split("\n").join(" | "));

		await shell.exec(["git", "--git-dir", bare, "push", "--force", "origin", "instance/node-a:refs/heads/main"], { timeoutMs: 30_000 });
		console.log("main-tree-after-merge:", (await shell.exec(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "main"], { timeoutMs: 30_000 })).stdout.trim().split("\n").join(" | "));

		const rb = await syncKb({ omoDir: dirs.b, kbDir: dirs.b, repo: bare, branch: "main", device: "node-b", runner: shell, push: false });
		console.log("B-actions:", JSON.stringify(rb.actions));
		console.log("B-tree:", (await shell.exec(["git", "-C", dirs.b, "ls-files"], { timeoutMs: 30_000 })).stdout.trim().split("\n").join(" | "));
		fs.rmSync(base, { recursive: true, force: true });
	});
});
