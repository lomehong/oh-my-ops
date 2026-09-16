import { describe, expect, test } from "bun:test";
import { DefaultDenyPolicy, FileOps, LOCAL_HOST, LogCollector, ProcessManager, StaticTokenStore } from "@ops-pi/core";
import type { ExecOptions, ExecResult, Runner } from "@ops-pi/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerDockerTools } from "../src/tools/docker-k8s.ts";
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
	test("★ compose 不可用（probe exit=1）→ 明确诊断且不再执行 compose 本体", async () => {
		const runner = new ScriptedRunner([{ exitCode: 1, stderr: "docker: 'compose' is not a docker command.\nSee 'docker --help'\nUsage:  docker [OPTIONS] COMMAND" }]);
		const pi = makeDocker(runner);
		const text = textOf(await pi.tools.get("ops_docker_compose")!.execute("c1", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("docker compose 不可用");
		expect(text).toContain("is not a docker command");
		expect(runner.calls.length).toBe(1); // 只做了探测，未执行 compose
		expect(runner.calls[0]!.cmd).toEqual(["docker", "compose", "version"]);
	});

	test("compose 可用 → 按 file 参数执行（缺省 docker-compose.yml）", async () => {
		const runner = new ScriptedRunner([{ exitCode: 0 }, { exitCode: 0, stdout: "NAME  STATUS\nweb   running" }]);
		const pi = makeDocker(runner);
		const text = textOf(await pi.tools.get("ops_docker_compose")!.execute("c2", { projectDir: "/srv/app", action: "ps" }));
		expect(text).toContain("web");
		expect(runner.calls[1]!.cmd).toEqual(["docker", "compose", "-f", "/srv/app/docker-compose.yml", "ps"]);

		const runner2 = new ScriptedRunner([{ exitCode: 0 }, { exitCode: 0, stdout: "ok" }]);
		await makeDocker(runner2).tools.get("ops_docker_compose")!.execute("c3", { projectDir: "/srv/app", file: "compose.yaml", action: "ps" });
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
	});
});
