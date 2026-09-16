import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parsePsOutput, ProcessManager } from "../src/process.ts";

const FIXTURE = [
	"    1 root     0.1  0.2 /sbin/init splash",
	" 1234 alice   7.5  1.1 nginx: worker process",
	" 9999 bob     2.0  0.3 /usr/bin/python3 /opt/app/server.py --port 8080",
	"",
].join("\n");

describe("parsePsOutput", () => {
	it("解析 pid/user/cpu/mem/args", () => {
		const rows = parsePsOutput(FIXTURE);
		assert.equal(rows.length, 3);
		assert.deepStrictEqual(rows[0], { pid: 1, user: "root", cpuPercent: "0.1", memPercent: "0.2", command: "/sbin/init splash" });
		assert.equal(rows[1]?.command, "nginx: worker process");
		assert.ok(rows[2]?.command.includes("--port 8080"));
	});

	it("按 user 过滤", () => {
		const rows = parsePsOutput(FIXTURE, { user: "alice" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.pid, 1234);
	});

	it("按 name 子串过滤", () => {
		const rows = parsePsOutput(FIXTURE, { name: "python" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.pid, 9999);
	});

	it("非数值 pid 的行被跳过（表头/噪声）", () => {
		const rows = parsePsOutput("  PID USER  %CPU %MEM ARGS\n    1 root 0.1 0.2 init");
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.pid, 1);
	});
});

// 真实 ps 可用性：本容器无 /bin/ps（bash 侧 ps 为宿主内建），故按可执行性跳过（CI/真机有 procps 时会真跑）
const PS_AVAILABLE = (() => {
	try {
		const r = spawnSync("ps", ["-eo", "pid", "--no-headers"], { encoding: "utf8" });
		return r.error === undefined && r.status === 0;
	} catch {
		return false;
	}
})();

describe("ProcessManager.list（真实 ps 冒烟：argv 拼接必须正确）", () => {
	// 回归：旧写法 `${PS_FIELDS.join(",")}--sort=-%cpu` 漏逗号 → `args--sort=-%cpu` 被 ps 当字段描述符，
	// ps 退出码 1（unknown output format specifier）→ list() 恒抛 OpsError（2026-09-16 对端实测）
	it("list：返回结构合法且非空", { skip: PS_AVAILABLE ? false : "环境无可用 ps 二进制（容器内 ps 为宿主内建）" }, async () => {
		const rows = await new ProcessManager().list({ limit: 5 });
		assert.ok(rows.length > 0, "应至少返回一行进程");
		for (const r of rows) {
			assert.ok(Number.isInteger(r.pid) && r.pid > 0, `pid 非法：${r.pid}`);
			assert.equal(typeof r.command, "string");
			assert.ok(r.command.length > 0, "command 不应为空");
		}
	});

	it("list：limit 生效", { skip: PS_AVAILABLE ? false : "环境无可用 ps 二进制" }, async () => {
		const rows = await new ProcessManager().list({ limit: 3 });
		assert.ok(rows.length <= 3);
	});
	// 无 ps 环境下（如本容器）仍能守住该缺陷：断言传给 ps 的 -eo 取值本身合法
	it("list：-eo 取值为逗号分隔字段 + --sort 独立成项（防再次漏逗号）", async () => {
		const calls: string[][] = [];
		const runner = {
			exec: async (cmd: readonly string[]) => {
				calls.push([...cmd]);
				return { stdout: "  1 root 0.1 0.2 init", stderr: "", exitCode: 0, durationMs: 0, truncated: false };
			},
		};
		await new ProcessManager(runner as never).list({ limit: 5 });
		const argv = calls[0] ?? [];
		const eo = argv[2] ?? "";
		assert.equal(eo, "pid,user,%cpu,%mem,args", `-eo 取值应为纯字段列表：${eo}`);
		assert.ok(!eo.includes("--sort"), `--sort 是选项，不得塞进 -eo 字段列表：${eo}`);
		assert.ok(argv.includes("--sort=-%cpu"), `--sort=-%cpu 应作为独立 argv 元素：${JSON.stringify(argv)}`);
		assert.ok(!argv.some((a) => a.includes("args--sort")), "字段与 --sort 不得粘连（旧缺陷形态）");
	});
});
