import { describe, expect, test } from "bun:test";
import { DefaultDenyPolicy, FileOps, LOCAL_HOST, LogCollector, ProcessManager, StaticTokenStore } from "@ops-pi/core";
import type { ExecOptions, ExecResult, Runner } from "@ops-pi/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerDockerTools } from "../src/tools/docker-k8s.ts";
import { fmtExecResult } from "../src/tools/exec-output.ts";
import { registerReadOnlyTools } from "../src/tools/read-only.ts";
import { makeApprovalFactory } from "../src/approvals.ts";
import { standardAuthzView } from "../src/guards.ts";
import { OpsContext, realUserHome } from "../src/context.ts";
import type { OpsContext as OpsContextType } from "../src/context.ts";

/**
 * read 档工具的「能跑对」结构守卫（对端 2026-09-16 冒烟矩阵的元结论：
 * 守卫要从「能加载」扩到「能跑对」——断言输出结构，而不是断言文件存在或能 import）。
 *
 * 覆盖两条已确认缺陷：
 *  - ops_docker_ps 曾把 daemon 不可达显示成 "(no containers)"（吞错）；
 *  - ops_docker_compose 在 compose 缺件时回显 docker 全量 usage（约 60 行噪音、无诊断）。
 */

/** 按脚本回放的 Runner：按调用序返回预置的 ExecResult（不足则复用最后一条） */
class ScriptedRunner implements Runner {
	calls: Array<{ cmd: readonly string[] | string; options: ExecOptions | undefined }> = [];
	constructor(private readonly replies: Array<Partial<ExecResult>>) {}
	async exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ cmd, options });
		const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)] ?? {};
		return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, truncated: false, ...r } as ExecResult;
	}
}

const zStub = () => {
	const chain: Record<string, unknown> = {};
	chain.describe = () => chain;
	chain.optional = () => chain;
	return chain;
};
type ToolDef = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> };
class FakePi {
	readonly tools = new Map<string, ToolDef>();
	readonly zod = { object: () => zStub(), string: () => zStub(), number: () => zStub(), array: () => zStub(), enum: () => zStub(), boolean: () => zStub() };
	registerTool(def: ToolDef): void {
		this.tools.set(def.name, def);
	}
}

function makeCtx(runner: Runner): OpsContextType {
	const policy = new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["shell"] }]);
	const tokens = new StaticTokenStore([]);
	return {
		authzView: standardAuthzView(policy, tokens),
		forHost: () => ({ host: undefined, shell: runner }),
	} as unknown as OpsContextType;
}

function makeDocker(runner: Runner) {
	const pi = new FakePi();
	const ctx = makeCtx(runner);
	const approval = makeApprovalFactory(new DefaultDenyPolicy([{ host: LOCAL_HOST, actions: ["shell"] }]), new StaticTokenStore([]));
	registerDockerTools(pi as never, ctx as OpsContext, approval);
	return pi;
}

const textOf = (out: unknown): string => String((out as { content: Array<{ text: string }> }).content[0]!.text);

describe("ops_docker_ps：失败不得伪装成空结果", () => {
	test("★ daemon 不可达（exit=1）→ 回显 exit + stderr，而非 (no containers)", async () => {
		const runner = new ScriptedRunner([
			{ exitCode: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" },
		]);
		const pi = makeDocker(runner);
		const text = textOf(await pi.tools.get("ops_docker_ps")!.execute("d1", {}));
		expect(text).toContain("exit=1");
		expect(text).toContain("Cannot connect to the Docker daemon");
		expect(text).not.toBe("(no containers)");
	});

	test("成功且有输出 → 原样回显 stdout", async () => {
		const runner = new ScriptedRunner([{ exitCode: 0, stdout: "CONTAINER ID   IMAGE\nabc123         nginx:latest" }]);
		const text = textOf(await makeDocker(runner).tools.get("ops_docker_ps")!.execute("d2", {}));
		expect(text).toContain("abc123");
	});

	test("成功但无容器 → 占位文案 (no containers)", async () => {
		const runner = new ScriptedRunner([{ exitCode: 0, stdout: "" }]);
		const text = textOf(await makeDocker(runner).tools.get("ops_docker_ps")!.execute("d3", {}));
		expect(text).toBe("(no containers)");
	});
});

describe("ops_docker_compose：缺件给诊断，不回显 usage 转储", () => {
	test("★ compose 全缺（v2+v1）→ 明确诊断 + 平台分支建议（老 CLI 不得被建议装 v2 插件）", async () => {
		const runner = new ScriptedRunner([
			{ exitCode: 1, stderr: "docker: 'compose' is not a docker command." }, // v2 探测
			{ exitCode: 1, stdout: "" }, // v1 存在性探测（command -v 未命中 → 非 0）
			{ exitCode: 0, stdout: "Docker version 18.09.6, build 481bc77" }, // docker --version（老平台）
		]);
		const pi = makeDocker(runner);
		const text = textOf(await pi.tools.get("ops_docker_compose")!.execute("c1", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("docker compose 不可用");
		expect(text).toContain("18.09"); // 版本取 major.minor
		expect(text).toContain("无 CLI 插件机制");
		expect(text).toContain("standalone docker-compose v1");
		expect(runner.calls.map((c) => c.cmd)).toEqual([
			["docker", "compose", "version"],
			["sh", "-c", "command -v docker-compose"],
			["docker", "--version"],
		]);
	});

	test("★ v1 二进制不存在导致 spawn 抛错时，仍落到「两者皆无」建议分支（缺陷 8）", async () => {
		class ThrowOnComposeRunner extends ScriptedRunner {
			override async exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
				if (Array.isArray(cmd) && cmd[0] === "docker-compose") throw new Error("[EXEC_FAILED] 命令执行失败：docker-compose");
				return super.exec(cmd, options);
			}
		}
		const runner = new ThrowOnComposeRunner([
			{ exitCode: 1, stderr: "docker: 'compose' is not a docker command." },
			{ exitCode: 1, stdout: "" }, // command -v 未命中
			{ exitCode: 0, stdout: "Docker version 24.0.7, build afdd53b" }, // 新平台 → 建议 v2 插件
		]);
		const text = textOf(await makeDocker(runner).tools.get("ops_docker_compose")!.execute("c1b", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("docker compose 不可用");
		expect(text).toContain("24.0");
		expect(text).toContain("支持 CLI 插件");
		expect(runner.calls.some((c) => Array.isArray(c.cmd) && c.cmd[0] === "docker-compose")).toBe(false); // 不再直接执行 v1 探测
	});

	test("★ v2 缺但 v1 在 → 自动回退 standalone docker-compose 执行", async () => {
		const runner = new ScriptedRunner([
			{ exitCode: 1, stderr: "docker: 'compose' is not a docker command." },
			{ exitCode: 0, stdout: "/usr/local/bin/docker-compose" },
			{ exitCode: 0, stdout: "   Name   Command\n   web    nginx" },
		]);
		const text = textOf(await makeDocker(runner).tools.get("ops_docker_compose")!.execute("c2", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("web");
		expect(runner.calls[2]!.cmd).toEqual(["docker-compose", "-f", "/srv/app/docker-compose.yml", "ps"]);
	});

	test("compose v2 可用 → 按 file 参数执行（缺省 docker-compose.yml）", async () => {
		const runner = new ScriptedRunner([{ exitCode: 0 }, { exitCode: 0, stdout: "NAME  STATUS\nweb   running" }]);
		const pi = makeDocker(runner);
		const text = textOf(await pi.tools.get("ops_docker_compose")!.execute("c3", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("web");
		expect(runner.calls[1]!.cmd).toEqual(["docker", "compose", "-f", "/srv/app/docker-compose.yml", "ps"]);

		const runner2 = new ScriptedRunner([{ exitCode: 0 }, { exitCode: 0, stdout: "ok" }]);
		await makeDocker(runner2).tools.get("ops_docker_compose")!.execute("c4", { projectDir: "/srv/app", file: "compose.yaml", action: "ps" });
		expect(runner2.calls[1]!.cmd).toEqual(["docker", "compose", "-f", "/srv/app/compose.yaml", "ps"]);
	});
});

describe("PathGuard 机密根：真实用户 home 的 .ssh（缺陷 6：HOME 重定向导致真实 home 漏出）", () => {
	test("★ 真实 home 的 .ssh 必须被拒（不得可列）", async () => {
		// 复刻 omo 部署：HOME 被重定向到私有域；Node 的 os.homedir() 优先 $HOME → 旧实现下
		// join(home,".ssh") 与 join(os.homedir(),".ssh") 塌缩，真实 home 的 .ssh 落到 secret 之外
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-secret-"));
		const omo = path.join(base, ".omo");
		const fakeHome = path.join(omo, "home");
		fs.mkdirSync(path.join(fakeHome, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(omo, "policy.json"), JSON.stringify({ targets: [{ host: LOCAL_HOST, actions: ["shell", "file-write"] }] }));
		const saved = process.env.HOME;
		process.env.HOME = fakeHome;
		let ctx: OpsContextType;
		try {
			ctx = new OpsContext(
				{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json") },
				{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json"), configPath: path.join(base, "proj", ".ops-pi", "config.json") },
				{ files: new FileOps(), process: new ProcessManager(), log: new LogCollector(), shell: new ScriptedRunner([]) as never },
			);
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
		const pi = new FakePi();
		registerReadOnlyTools(pi as never, ctx);
		const realHome = realUserHome();
		await expect(pi.tools.get("ops_file_ls")!.execute("p1", { path: path.join(realHome, ".ssh") })).rejects.toThrow(/机密根/);

		// OMO-KB-SYNC：KB 同步凭据同属机密根（bot token 不得被 Agent 读出）
		fs.mkdirSync(path.join(omo, "kb"), { recursive: true });
		fs.writeFileSync(path.join(omo, "kb", "credential.json"), JSON.stringify({ repo: "https://h/git/a/b", username: "bot", token: "SECRET" }));
		await expect(pi.tools.get("ops_file_read")!.execute("p2", { path: path.join(omo, "kb", "credential.json") })).rejects.toThrow(/机密根/);
	});
});

describe("fmtExecResult：失败与「成功但有 stderr」都必须可见（缺陷 7 同族）", () => {
	const r = (stdout: string, stderr: string, exitCode = 0) => ({ stdout, stderr, exitCode });

	test("成功且无 stderr → 原样 stdout", () => {
		expect(fmtExecResult(r("ok", ""))).toBe("ok");
	});

	test("★ 成功但 stderr 非空 → 追加 (stderr) 段（不得吞掉）", () => {
		const text = fmtExecResult(r("NAME  STATUS", "Warning: /srv/app is not a directory"));
		expect(text).toContain("NAME  STATUS");
		expect(text).toContain("(stderr)");
		expect(text).toContain("Warning: /srv/app is not a directory");
	});

	test("★ 成功、stdout 空但 stderr 有权限提示 → 回显提示而非空占位", () => {
		const warn = "You are currently not seeing messages from other users and the system.";
		const text = fmtExecResult(r("", warn));
		expect(text).toContain("You are currently not seeing messages");
		expect(text).not.toBe("(no output)");
	});

	test("成功且两者皆空 → 占位文案（可自定义）", () => {
		expect(fmtExecResult(r("", ""), "(no containers)")).toBe("(no containers)");
	});

	test("失败 → exit=N + stderr，长输出取「头 5 行 + 省略 + 尾 3 行」", () => {
		const text = fmtExecResult(r("", Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"), 1));
		expect(text.startsWith("exit=1")).toBe(true);
		expect(text).toContain("L0");
		expect(text).toContain("省略");
		expect(text).toContain("L19"); // 尾部保留（可行动结论常在此）
		expect(text).not.toContain("L10"); // 中段被省略
	});

	test("★ traceback 形态：可行动结论在尾部，必须可见（对端观察）", () => {
		const tb = [
			"[20033] Failed to execute script docker-compose",
			"Traceback (most recent call last):",
			'  File "docker_compose/cli/main.py", line 67, in main',
			'  File "docker_compose/cli/main.py", line 121, in perform_command',
			'  File "urllib3/connectionpool.py", line 677, in urlopen',
			'  File "urllib3/connectionpool.py", line 445, in _make_request',
			'  File "urllib3/connection.py", line 170, in _new_conn',
			'  File "socket.py", line 716, in create_connection',
			"urllib3.exceptions.NewConnectionError: <urllib3.connection.HTTPConnection object at 0x7f>: Failed to establish a new connection",
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
		].join("\n");
		const text = fmtExecResult(r("", tb, 255));
		expect(text.startsWith("exit=255")).toBe(true);
		expect(text).toContain("Cannot connect to the Docker daemon");
	});
});

