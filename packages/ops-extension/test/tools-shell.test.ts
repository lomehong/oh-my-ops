import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultDenyPolicy, FileOps, LOCAL_HOST, LogCollector, ProcessManager, StaticTokenStore } from "@ops-pi/core";
import type { ExecOptions, ExecResult, Runner } from "@ops-pi/core";
import { registerShellTools, readTimeoutSec } from "../src/tools/shell.ts";
import { registerReadOnlyTools } from "../src/tools/read-only.ts";
import { registerLogTools } from "../src/tools/log.ts";
import { registerWriteTools } from "../src/tools/write.ts";
import { makeApprovalFactory } from "../src/approvals.ts";
import { standardAuthzView } from "../src/guards.ts";
import { OpsContext } from "../src/context.ts";
import type { OpsContext as OpsContextType } from "../src/context.ts";

// ── 桩：记录 exec 实参的 Runner + 最小 OpsContext + 最小宿主 ──
class RecordingRunner implements Runner {
	calls: Array<{ cmd: readonly string[] | string; options: ExecOptions | undefined }> = [];
	async exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ cmd, options });
		return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, truncated: false } as unknown as ExecResult;
	}
}

// zod 桩：仅需链式调用不抛错（schema 不参与本测试断言）
const zStub = () => {
	const chain: Record<string, unknown> = {};
	chain.describe = () => chain; chain.optional = () => chain;
	return chain;
};
type ToolDef = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> };
class FakePi {
	readonly tools = new Map<string, ToolDef>();
	readonly zod = { object: () => zStub(), string: () => zStub(), number: () => zStub(), array: () => zStub() };
	registerTool(def: ToolDef): void { this.tools.set(def.name, def); }
}

function makeCtx(runner: Runner): OpsContextType {
	const policy = new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["shell"] }]);
	const tokens = new StaticTokenStore([]);
	return {
		authzView: standardAuthzView(policy, tokens),
		forHost: () => ({ host: undefined, shell: runner }),
	} as unknown as OpsContextType;
}

/** 真实 OpsContext（临时私有域）：policy 授权 shell + file-write；L1 shell 换成记录桩，不触盘 */
function realCtx(runner: Runner): { ctx: OpsContext; omo: string; home: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ctx-"));
	const omo = path.join(base, ".omo");
	const home = path.join(omo, "home");
	fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
	fs.writeFileSync(path.join(omo, "policy.json"), JSON.stringify({ targets: [{ host: LOCAL_HOST, actions: ["shell", "file-write"] }] }));
	const saved = process.env.HOME;
	process.env.HOME = home;
	const ctx = new OpsContext(
		{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json") },
		{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json"), configPath: path.join(base, "proj", ".ops-pi", "config.json") },
		{ files: new FileOps(), process: new ProcessManager(runner), log: new LogCollector(runner), shell: runner as never },
	);
	if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
	return { ctx, omo, home };
}

describe("readTimeoutSec（schema 为 number；此前 readField 只收 string → 永远回落缺省）", () => {
	test("number 实参生效并受上限截断", () => {
		expect(readTimeoutSec({ timeout: 120 }, 30, 600)).toBe(120);
		expect(readTimeoutSec({ timeout: 9999 }, 30, 600)).toBe(600);
	});
	test("数字字符串兼容；缺失/非法/非正数回落缺省", () => {
		expect(readTimeoutSec({ timeout: "45" }, 30, 600)).toBe(45);
		expect(readTimeoutSec({}, 30, 600)).toBe(30);
		expect(readTimeoutSec({ timeout: "abc" }, 30, 600)).toBe(30);
		expect(readTimeoutSec({ timeout: 0 }, 30, 600)).toBe(30);
		expect(readTimeoutSec({ timeout: -5 }, 60, 600)).toBe(60);
		expect(readTimeoutSec(null, 60, 600)).toBe(60);
	});
});

describe("ops_shell_exec / ops_shell_script：timeout 实参透传到 Runner", () => {
	test("★ 回归：timeout=120 → exec timeoutMs=120000（此前恒为缺省 30s/60s）", async () => {
		const runner = new RecordingRunner();
		const pi = new FakePi();
		const ctx = makeCtx(runner);
		const approval = makeApprovalFactory(new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["shell"] }]), new StaticTokenStore([]));
		registerShellTools(pi as never, ctx, approval);

		await pi.tools.get("ops_shell_exec")!.execute("c1", { command: "sleep 100", timeout: 120 });
		expect(runner.calls[0]?.options?.timeoutMs).toBe(120_000);
		expect(runner.calls[0]?.cmd).toEqual(["sh", "-c", "sleep 100"]);

		await pi.tools.get("ops_shell_script")!.execute("c2", { script: "sleep 100", timeout: 900 });
		expect(runner.calls[1]?.options?.timeoutMs).toBe(600_000);

		await pi.tools.get("ops_shell_exec")!.execute("c3", { command: "uptime" });
		expect(runner.calls[2]?.options?.timeoutMs).toBe(30_000);
	});
});


describe("PathGuard 接线（真实 OpsContext：机密根拒读、信任根拒写；仅本机）", () => {
	test("OpsContext 从配置推导根：私有域整体为信任根，home/.omp、.ssh、令牌为机密根，审计落私有域 audit/", () => {
		const { ctx, omo, home } = realCtx(new RecordingRunner());
		const roots = ctx.pathGuard.roots;
		expect(roots.secret.some((r) => r.endsWith(path.join("home", ".omp")))).toBe(true);
		expect(roots.secret.some((r) => r.endsWith("approval-token.json"))).toBe(true);
		expect(roots.trust.some((r) => r === path.resolve(omo) || r.endsWith(".omo"))).toBe(true);
		expect(ctx.audit.path).toBe(path.join(omo, "audit", "ops-audit.jsonl"));
		expect(ctx.pathGuard.denyRead(path.join(home, ".omp", "auth.json"))).not.toBeNull();
	});

	test("★ ops_file_read / ops_file_ls / ops_log_tail / ops_log_grep 对机密根拒（不触盘、不起进程）", async () => {
		const runner = new RecordingRunner();
		const { ctx, home, omo } = realCtx(runner);
		const pi = new FakePi();
		registerReadOnlyTools(pi as never, ctx);
		registerLogTools(pi as never, ctx);
		const secret = path.join(home, ".omp", "auth.json");

		await expect(pi.tools.get("ops_file_read")!.execute("r1", { path: secret })).rejects.toThrow(/POLICY_DENIED.*机密根/);
		await expect(pi.tools.get("ops_file_ls")!.execute("r2", { path: path.join(home, ".ssh") })).rejects.toThrow(/机密根/);
		await expect(pi.tools.get("ops_log_tail")!.execute("r3", { path: path.join(omo, "approval-token.json") })).rejects.toThrow(/机密根/);
		await expect(pi.tools.get("ops_log_grep")!.execute("r4", { pattern: "sk-", paths: [home] })).rejects.toThrow(/机密根/);
		expect(runner.calls.length).toBe(0);

		// 普通日志目录照常放行（grep 起进程）
		await pi.tools.get("ops_log_grep")!.execute("r5", { pattern: "error", paths: ["/var/log/nginx"] });
		expect(runner.calls.length).toBe(1);
	});

	test("★ ops_file_write：拿到 file-write 授权也不能改写 policy.json / 私有域（防自授权）；普通路径放行", async () => {
		const runner = new RecordingRunner();
		const { ctx, omo } = realCtx(runner);
		const pi = new FakePi();
		const approval = makeApprovalFactory(ctx.targetPolicy, ctx.tokens);
		registerWriteTools(pi as never, ctx, undefined, approval);
		const write = pi.tools.get("ops_file_write")!;

		const before = fs.readFileSync(path.join(omo, "policy.json"), "utf8");
		await expect(write.execute("w1", { path: path.join(omo, "policy.json"), content: "{\"targets\":[{\"host\":\"@local\"}]}" })).rejects.toThrow(/信任根/);
		await expect(write.execute("w2", { path: path.join(omo, "approval-token.json"), content: "{}" })).rejects.toThrow(/机密根/);
		await expect(write.execute("w3", { path: path.join(omo, "extensions", "ops-pi", "x.ts"), content: "" })).rejects.toThrow(/信任根/);
		expect(fs.readFileSync(path.join(omo, "policy.json"), "utf8")).toBe(before);

		const ok = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omo-w-")), "app.conf");
		await write.execute("w4", { path: ok, content: "k=v" });
		expect(fs.readFileSync(ok, "utf8")).toBe("k=v");
	});
});
