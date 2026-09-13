import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTargetHost, SshPool } from "../src/ssh.ts";
import { OpsError } from "../src/errors.ts";
import type { ExecResult, Runner } from "../src/runner.ts";

/** 桩 runner：记录 argv；每次执行挂起在 Gate 上，由测试显式放行（确定性并发，无真实计时器） */
class GateRunner implements Runner {
	readonly calls: string[][] = [];
	maxInFlightSeen = 0;
	#inFlight = 0;
	#pending: Array<() => void> = [];

	async exec(cmd: string | readonly string[], _options?: unknown): Promise<ExecResult> {
		const argv = [...cmd] as string[];
		this.calls.push(argv);
		this.#inFlight += 1;
		this.maxInFlightSeen = Math.max(this.maxInFlightSeen, this.#inFlight);
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		this.#pending.push(release);
		await gate;
		this.#inFlight -= 1;
		return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 0 };
	}

	/** 放行 n 个挂起中的执行（FIFO） */
	release(n = 1): void {
		for (let i = 0; i < n; i++) this.#pending.shift()?.();
	}

	get pendingCount(): number {
		return this.#pending.length;
	}
}

/** 让微任务队列排空（信号量唤醒 / promise 链推进），不做真实等待 */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("normalizeTargetHost", () => {
	it("空值 / @local → undefined（本机）", () => {
		assert.equal(normalizeTargetHost(""), undefined);
		assert.equal(normalizeTargetHost("  "), undefined);
		assert.equal(normalizeTargetHost("@local"), undefined);
		assert.equal(normalizeTargetHost(undefined), undefined);
	});
	it("合法主机名 / user@host", () => {
		assert.equal(normalizeTargetHost("web-01"), "web-01");
		assert.equal(normalizeTargetHost("prod.db.example.com"), "prod.db.example.com");
		assert.equal(normalizeTargetHost("deploy@10.0.0.5"), "deploy@10.0.0.5");
	});
	it("非法输入抛 POLICY_DENIED", () => {
		for (const bad of ["-oProxyCommand=evil", "host name", "a;b", " $(x)", "host;rm"]) {
			assert.throws(() => normalizeTargetHost(bad), OpsError);
		}
	});
});

describe("SshPool", () => {
	it("wrap：BatchMode/ControlMaster/目标/-- 分隔，argv 原样透传", () => {
		const pool = new SshPool({ user: "ops", port: 2222, identityFile: "/k/id" }, new GateRunner(), "/tmp/cp-test");
		const wrapped = pool.wrap("web-01", ["uptime", "-p"]);
		assert.equal(wrapped[0], "ssh");
		assert.ok(wrapped.includes("BatchMode=yes"));
		assert.ok(wrapped.includes("ControlMaster=auto"));
		assert.ok(wrapped.some((o) => o.startsWith("IdentityFile=/k/id")));
		assert.ok(wrapped.some((o) => o.startsWith("Port=2222")));
		const dd = wrapped.indexOf("--");
		assert.equal(wrapped[dd + 1], "uptime");
		assert.equal(wrapped[dd + 2], "-p");
	});

	it("exec：目标地址与 -- 分隔出现在 runner 收到的 argv 中", async () => {
		const runner = new GateRunner();
		const pool = new SshPool({}, runner, "/tmp/cp-test2");
		const pending = pool.exec("db-01", ["df", "-h", "/"]);
		await drain();
		const argv = runner.calls[0]!;
		assert.equal(argv[argv.indexOf("db-01") + 1], "--");
		assert.equal(argv[argv.indexOf("--") + 1], "df");
		runner.release(1);
		await pending;
	});

	it("maxSessions 并发上限：5 发起，runner 同时在飞 ≤ 2", async () => {
		const runner = new GateRunner();
		const pool = new SshPool({ maxSessions: 2 }, runner, "/tmp/cp-test3");
		const all = Array.from({ length: 5 }, () => pool.exec("h", ["echo", "x"]));

		await drain();
		assert.equal(runner.calls.length, 2); // 只有 2 个进入 runner
		runner.release(2); // 放行前两个 → 队列中的 2 个进入
		await drain();
		assert.equal(runner.calls.length, 4);
		runner.release(2); // 放行 → 最后 1 个进入
		await drain();
		assert.equal(runner.calls.length, 5);
		runner.release(1);
		await Promise.all(all);
		assert.ok(runner.maxInFlightSeen <= 2);
	});

	it("closeAll：对每个已知目标发 -O exit", async () => {
		const runner = new GateRunner();
		const pool = new SshPool({}, runner, "/tmp/cp-test4");
		const p = pool.exec("a", ["true"]);
		await drain();
		runner.release(1);
		await p;
		const closing = pool.closeAll();
		await drain();
		runner.release(1);
		await closing;
		assert.ok(runner.calls.some((argv) => argv.includes("-O") && argv.includes("exit")));
	});
});
