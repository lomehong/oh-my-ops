import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { SandboxedShell, wrapBwrap, probeBwrap } from "../src/sandbox.ts";
import { ShellExec } from "@ops-pi/core";

/** 真实执行用的临时项目目录 */
const dir = mkdtempSync(path.join(os.tmpdir(), "omo-sbx-"));

describe("wrapBwrap", () => {
	test("argv 结构：/ 只读 + cwd 可写 + /tmp tmpfs + -- 透传", () => {
		const wrapped = wrapBwrap(["sh", "-c", "echo hi"], dir);
		expect(wrapped[0]).toBe("bwrap");
		expect(wrapped).toContain("--ro-bind");
		expect(wrapped).toContain("--tmpfs");
		expect(wrapped[wrapped.indexOf("--bind") + 2]).toBe(dir);
		const dd = wrapped.indexOf("--");
		expect(wrapped[dd + 1]).toBe("sh");
	});
});

describe("SandboxedShell", () => {
	test("disabled → 直接透传（不包 bwrap）", async () => {
		const inner = new ShellExec();
		let seen: string[] = [];
		const spy: ShellExec = {
			exec: async (cmd, options) => {
				seen = [...cmd] as string[];
				return inner.exec(cmd, options);
			},
		};
		const shell = new SandboxedShell(spy, { enabled: false, writableDir: dir }, true);
		await shell.exec(["echo", "pass"]);
		expect(seen[0]).toBe("echo");
	});

	test("enabled + bwrap 不可用 → SANDBOX_UNAVAILABLE（fail-closed）", async () => {
		const runner: ShellExec = new ShellExec();
		const shell = new SandboxedShell(runner, { enabled: true, writableDir: dir }, false);
		await expect(shell.exec(["echo", "x"])).rejects.toThrow(/SANDBOX_UNAVAILABLE|fail-closed/);
	});
});

describe("真实 bwrap 隔离（bwrap 可用时运行）", () => {
	test("白名单外写失败且不落宿主；cwd 内写成功", async () => {
		if (!probeBwrap()) {
			console.log("skip: bwrap 不可用");
			return;
		}
		const shell = new SandboxedShell(new ShellExec(), { enabled: true, writableDir: dir }, true);
		const marker = path.join(os.homedir(), `omo-p9-marker-${process.pid}`);

		// 负测：宿主 $HOME 写入 → bwrap 内 $HOME 是只读镜像 → 失败
		const denied = await shell.exec(["sh", "-c", `touch ${marker} 2>/dev/null; echo rc=$?`], { timeoutMs: 15_000 });
		expect(denied.stdout).toContain("rc=1");
		expect(existsSync(marker)).toBe(false);

		// 正测：cwd（白名单）写入成功且落盘
		const inside = path.join(dir, "p9-inside.txt");
		await shell.exec(["sh", "-c", `echo sandbox-ok > ${path.join(dir, "p9-inside.txt")}`], { timeoutMs: 15_000 });
		expect(existsSync(inside)).toBe(true);
		const content = fs.readFileSync(inside, "utf8");
		expect(content).toContain("sandbox-ok");

		// 清理
		if (existsSync(marker)) rmSync(marker);
		rmSync(inside);
	});
});
