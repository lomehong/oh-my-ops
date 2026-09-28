import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTargetHost, posixShellQuote, SshPool } from "../src/ssh.ts";
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

describe("posixShellQuote", () => {
	it("安全字符集原样透传", () => {
		for (const safe of ["uptime", "-p", "/var/log/app.log", "10.0.0.5", "a_b=c", "%h:%p"]) {
			assert.equal(posixShellQuote(safe), safe);
		}
	});
	it("含空格/引号/shell 元字符一律单引号包裹，' 编码为 '\\''", () => {
		assert.equal(posixShellQuote("a b"), `'a b'`);
		assert.equal(posixShellQuote("it's"), `'it'\\''s'`);
		assert.equal(posixShellQuote("a;b"), `'a;b'`);
		assert.equal(posixShellQuote("$(x)"), `'$(x)'`);
		assert.equal(posixShellQuote("`id`"), "'`id`'");
		assert.equal(posixShellQuote("a\nb"), "'a\nb'");
	});
	/** 迷你 POSIX shell words 解析器：模拟远端登录 shell 对拼接命令串的切词（验证引述往返） */
	function shellWords(input: string): string[] {
		const words: string[] = [];
		let cur = "";
		let quoted: string | null = null;
		for (let i = 0; i < input.length; i++) {
			const c = input[i]!;
			if (quoted === "'") {
				if (c === "'") quoted = null;
				else cur += c;
			} else if (c === "\\" ) {
				cur += input[++i] ?? ""; // 引号外的反斜杠转义：下一字符取字面量（'\'' 编码的还原关键）
			} else if (c === "'") {
				quoted = "'";
			} else if (c === " ") {
				if (cur !== "" || quoted !== null) words.push(cur);
				cur = "";
			} else {
				cur += c;
			}
		}
		if (cur !== "" || quoted !== null) words.push(cur);
		return words;
	}
	it("引述往返：远端 shell 切词后逐字还原原 argv（空格/引号/;$()/反引号）", () => {
		const cases: string[][] = [
			["grep", "-rnH", "my pattern", "/var/log"],
			["sh", "-c", "uptime && free -h | head -3"],
			["cat", "--", "/tmp/a;b$(whoami)`id`/file"],
			["stat", "-c", "%s", "--", "/tmp/it's"],
		];
		for (const argv of cases) {
			const remote = argv.map(posixShellQuote).join(" ");
			assert.deepStrictEqual(shellWords(remote), argv);
		}
	});
});

describe("SshPool", () => {
	it("wrap：BatchMode/ControlMaster/目标/-- 分隔，数组形式引述合并为单一远端命令串", () => {
		const pool = new SshPool({ user: "ops", port: 2222, identityFile: "/k/id" }, new GateRunner(), "/tmp/cp-test");
		const wrapped = pool.wrap("web-01", ["uptime", "-p"]);
		assert.equal(wrapped[0], "ssh");
		assert.ok(wrapped.includes("BatchMode=yes"));
		assert.ok(wrapped.includes("ControlMaster=auto"));
		assert.ok(wrapped.some((o) => o.startsWith("IdentityFile=/k/id")));
		assert.ok(wrapped.some((o) => o.startsWith("Port=2222")));
		const dd = wrapped.indexOf("--");
		assert.equal(wrapped.length, dd + 2, "-- 之后必须只有一个（合并引述的）远端命令串");
		assert.equal(wrapped[dd + 1], "uptime -p");
	});

	it("wrap：含 shell 元字符的参数被引述，远端切词后还原（注入回归：; $() 不得逃逸）", () => {
		const runner = new GateRunner();
		const pool = new SshPool({}, runner, "/tmp/cp-test-inject");
		const wrapped = pool.wrap("web-01", ["/tmp; cat /etc/shadow", "a $(pwned) b"]);
		const dd = wrapped.indexOf("--");
		assert.equal(wrapped.length, dd + 2, "元字符参数不得拆成多个 ssh 参数");
		assert.equal(wrapped[dd + 1], `'/tmp; cat /etc/shadow' 'a $(pwned) b'`, "远端 shell 收到的串必须整体在引号内");
	});

	it("wrap：字符串形式 = 远端 shell 命令行原样传递（不再按空白拆散）", () => {
		const pool = new SshPool({}, new GateRunner(), "/tmp/cp-test-str");
		const wrapped = pool.wrap("web-01", "sh -c 'uptime && free -h | head -3'");
		const dd = wrapped.indexOf("--");
		assert.equal(wrapped.length, dd + 2);
		assert.equal(wrapped[dd + 1], "sh -c 'uptime && free -h | head -3'");
	});

	it("wrap：core 层拒绝选项注入形态主机名（不依赖扩展层纪律）", () => {
		const pool = new SshPool({}, new GateRunner(), "/tmp/cp-test-host");
		assert.throws(() => pool.wrap("-oProxyCommand=evil", ["uptime"]), OpsError);
	});

	it("exec：目标地址与 -- 分隔出现在 runner 收到的 argv 中", async () => {
		const runner = new GateRunner();
		const pool = new SshPool({}, runner, "/tmp/cp-test2");
		const pending = pool.exec("db-01", ["df", "-h", "/"]);
		await drain();
		const argv = runner.calls[0]!;
		assert.equal(argv[argv.indexOf("db-01") + 1], "--");
		assert.equal(argv[argv.indexOf("--") + 1], "df -h /");
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

	it("maxSessions 槽位移交：释放后立刻发起新调用也不得越过上限（竞态回归）", async () => {
		const runner = new GateRunner();
		const pool = new SshPool({ maxSessions: 2 }, runner, "/tmp/cp-test-race");
		const first = Array.from({ length: 4 }, () => pool.exec("h", ["echo", "x"]));
		await drain();
		assert.equal(runner.calls.length, 2);
		runner.release(2); // 释放前两个，唤醒队列中的 2 个（槽位移交，inFlight 保持 2）
		// 在被唤醒者恢复执行**之前**发起新调用——旧实现此处看到已递减的 inFlight 会越过上限
		const second = Array.from({ length: 2 }, () => pool.exec("h", ["echo", "y"]));
		await drain();
		assert.equal(runner.calls.length, 4, "唤醒窗口内的新调用必须排队而非直接入跑");
		runner.release(4);
		await drain();
		assert.equal(runner.calls.length, 6);
		runner.release(2);
		await Promise.all([...first, ...second]);
		assert.ok(runner.maxInFlightSeen <= 2, `在飞数越过上限：${runner.maxInFlightSeen}`);
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

describe("SshPool host key 策略（缺陷 5：文档承诺 TOFU，实现此前无任何 host key 选项）", () => {
	// argv 里的受管路径由 path.join 生成（win32 为反斜杠）⇒ 比较前归一化分隔符
	const posix = (s: string): string => s.replaceAll("\\", "/");
	it("支持 accept-new（OpenSSH ≥7.6）→ StrictHostKeyChecking=accept-new + 受管 known_hosts", () => {
		const pool = new SshPool({}, new GateRunner(), "/tmp/cp-hk-a", true);
		const wrapped = pool.wrap("web-01", ["uptime"]);
		assert.ok(wrapped.includes("StrictHostKeyChecking=accept-new"), "应带 accept-new");
		assert.ok(wrapped.some((o) => posix(o) === "UserKnownHostsFile=/tmp/cp-hk-a/known_hosts"), "应指向受管 known_hosts");
		assert.deepStrictEqual(pool.hostKeyPolicy().mode, "accept-new");
	});

	it("不支持 accept-new（el7 仅 7.4）→ 退化为 no + 受管 known_hosts（仍记录指纹）", () => {
		const pool = new SshPool({}, new GateRunner(), "/tmp/cp-hk-b", false);
		const wrapped = pool.wrap("web-01", ["uptime"]);
		assert.ok(wrapped.includes("StrictHostKeyChecking=no"), "应退化为 no");
		assert.ok(wrapped.some((o) => posix(o) === "UserKnownHostsFile=/tmp/cp-hk-b/known_hosts"));
		assert.deepStrictEqual(pool.hostKeyPolicy().mode, "no+managed-known-hosts");
	});

	it("调用方 options 可覆盖（OpenSSH 首值生效 → 默认项排在 caller 之后）", () => {
		const pool = new SshPool({ options: ["StrictHostKeyChecking=yes"] }, new GateRunner(), "/tmp/cp-hk-c", true);
		const wrapped = pool.wrap("web-01", ["uptime"]);
		const caller = wrapped.indexOf("StrictHostKeyChecking=yes");
		const fallback = wrapped.indexOf("StrictHostKeyChecking=accept-new");
		assert.ok(caller >= 0 && fallback >= 0 && caller < fallback, "caller 的取值必须排在默认值之前");
	});
});
