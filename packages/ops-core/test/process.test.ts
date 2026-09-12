import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePsOutput } from "../src/process.ts";

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
