import { describe, expect, test } from "bun:test";
import { CdpUnreachableError, resolveWsUrl } from "../src/web/cdp.ts";
import { buildVerdict, evaluateAssertions, isNoiseRequest, pickFailedRequests, verifyPage, type CdpLike } from "../src/web/verify.ts";

/**
 * WEBVERIFY-1 守卫：ops_web_verify 的纯逻辑 + 编排（用假 CDP 会话，无需真浏览器）。
 * 纪律：证据类判据（断言/控制台/失败请求/截图）逐项可断言；端点不可达必须是"可执行结论"而非崩溃。
 */

describe("纯逻辑：噪音过滤与失败请求", () => {
	test("favicon/data:/blob:/devtools 视为噪音并计数", () => {
		expect(isNoiseRequest("http://x/favicon.ico")).toBe(true);
		expect(isNoiseRequest("data:text/html,x")).toBe(true);
		expect(isNoiseRequest("http://x/api/v1/orders")).toBe(false);
		const { failed, ignoredNoise } = pickFailedRequests(
			[
				{ url: "http://x/app", status: 200 },
				{ url: "http://x/favicon.ico", status: 404 },
				{ url: "http://x/api/missing", status: 404, method: "POST" },
			],
			[{ url: "http://x/api/timeout", errorText: "net::ERR_TIMED_OUT" }],
		);
		expect(ignoredNoise).toBe(1);
		expect(failed).toEqual([
			{ method: "POST", url: "http://x/api/missing", status: 404 },
			{ method: "GET", url: "http://x/api/timeout", status: 0, errorText: "net::ERR_TIMED_OUT" },
		]);
	});
});

describe("纯逻辑：断言评估与裁决组装", () => {
	const snap = { title: "控制台 · Demo", text: "实例 122 状态 已接入", has: (s: string) => s === "#rows" };
	test("标题/文本/选择器三类断言各自判定", () => {
		const res = evaluateAssertions(snap, { url: "http://x", expectTitle: "控制台", expectText: "已接入", expectSelector: "#rows" });
		expect(res.map((r) => r.pass)).toEqual([true, true, true]);
		const bad = evaluateAssertions(snap, { url: "http://x", expectTitle: "登录", expectSelector: "#nope" });
		expect(bad.map((r) => r.pass)).toEqual([false, false]);
		expect(bad[0]?.detail).toContain("实际标题");
	});
	test("ok 判据：断言全过即 ok；failOnErrors=true 时错误会否掉 ok", () => {
		const common = {
			endpoint: "http://127.0.0.1:9222",
			url: "http://x",
			title: "t",
			assertions: [{ kind: "title" as const, target: "t", pass: true, detail: "" }],
			consoleErrors: [{ type: "error", text: "boom" }],
			pageErrors: [],
			failedRequests: [],
			ignoredNoise: 2,
			durationMs: 12,
			notes: [],
		};
		expect(buildVerdict({ ...common }).ok).toBe(true);
		expect(buildVerdict({ ...common, failOnErrors: true }).ok).toBe(false);
		expect(buildVerdict({ ...common }).notes.join(" ")).toContain("已忽略 2 条噪音请求");
		expect(buildVerdict({ ...common, failOnErrors: true }).notes.join(" ")).toContain("存在控制台错误");
	});
});

/** 假 CDP 会话：按脚本应答命令、按需派发事件 */
function fakeCdp(opts: { title?: string; text?: string; selectorOk?: boolean; finalUrl?: string; consoleError?: boolean; status404Url?: string }) {
	const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
	const loads: (() => void)[] = [];
	const emit = (method: string, params: Record<string, unknown>) => {
		for (const h of handlers.get(`s1:${method}`) ?? []) h(params);
	};
	const client: CdpLike = {
		async send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, _params?: Record<string, unknown>, _sessionId?: string): Promise<T> {
			if (method === "Runtime.evaluate") {
				const expr = String((_params as { expression?: string } | undefined)?.expression ?? "");
				const val = expr.includes("document.title")
					? (opts.title ?? "T")
					: expr.includes("innerText")
						? (opts.text ?? "BODY")
						: expr.includes("location.href")
							? (opts.finalUrl ?? "http://x/final")
							: expr.includes("querySelector")
								? (opts.selectorOk ?? true)
								: true;
				return { result: { value: val } } as unknown as T;
			}
			if (method === "Page.captureScreenshot") return { data: Buffer.from("PNGDATA").toString("base64") } as unknown as T;
			if (method === "Target.createTarget") return { targetId: "t1" } as unknown as T;
			if (method === "Target.attachToTarget") return { sessionId: "s1" } as unknown as T;
			return {} as unknown as T;
		},
		on(_sessionId, method, handler) {
			const list = handlers.get(`s1:${method}`) ?? [];
			list.push(handler);
			handlers.set(`s1:${method}`, list);
			return () => {};
		},
		async waitForEvent(_sessionId, method) {
			if (opts.consoleError === true) emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "演示业务错误" }] });
			if (opts.status404Url !== undefined) {
				emit("Network.requestWillBeSent", { requestId: "r9", request: { url: opts.status404Url } });
				emit("Network.responseReceived", { response: { url: opts.status404Url, status: 404 } });
				emit("Network.loadingFinished", { requestId: "r9" });
			}
			emit("Network.requestWillBeSent", { requestId: "rf", request: { url: "http://x/favicon.ico" } });
			emit("Network.responseReceived", { response: { url: "http://x/favicon.ico", status: 404 } });
			emit("Network.loadingFinished", { requestId: "rf" });
			return {} as Record<string, unknown>;
		},
		async attachNewTab() {
			return { targetId: "t1", sessionId: "s1" };
		},
		async closeTarget() {},
		dispose() {},
	};
	return client;
}

describe("编排：verifyPage（假 CDP 全链）", () => {
	test("全过场景：断言 + 截图 + 噪音忽略 + 最终 URL 回读", async () => {
		const v = await verifyPage(
			{ url: "http://x/app", waitFor: "#rows", expectTitle: "T", expectText: "BODY", expectSelector: "#rows", screenshotPath: "/tmp/wv-test.png" },
			{ cdp: fakeCdp({ title: "T", text: "BODY", selectorOk: true, finalUrl: "http://x/app" }) },
		);
		expect(v.ok).toBe(true);
		expect(v.url).toBe("http://x/app");
		expect(v.assertions.map((a) => `${a.kind}:${a.pass}`)).toEqual(["waitFor:true", "title:true", "text:true", "selector:true"]);
		expect(v.screenshot).toBe("/tmp/wv-test.png");
		expect(v.ignoredNoise).toBeGreaterThanOrEqual(1);
		expect(v.failedRequests).toEqual([]);
	});
	test("失败场景：断言不过 + 控制台错误 + 带 URL 的失败请求（不误报噪音）", async () => {
		const v = await verifyPage(
			{ url: "http://x/app", expectTitle: "不该出现的标题", failOnErrors: true },
			{ cdp: fakeCdp({ title: "实际", consoleError: true, status404Url: "http://x/api/missing" }) },
		);
		expect(v.ok).toBe(false);
		expect(v.assertions.find((a) => a.kind === "title")?.pass).toBe(false);
		expect(v.consoleErrors[0]?.text).toContain("演示业务错误");
		expect(v.failedRequests.map((f) => f.url)).toEqual(["http://x/api/missing"]);
	});
	test("端点不可达 ⇒ ok=false + 可执行启动指引（不是崩溃）", async () => {
		const v = await verifyPage({ url: "http://x/" }, { endpoint: "http://127.0.0.1:1" });
		expect(v.ok).toBe(false);
		expect(v.notes.join("\n")).toContain("docker run");
		expect(v.notes.join("\n")).toContain("OMO_BROWSER_CDP");
	});
});

describe("CDP 端点解析", () => {
	test("不可达端点抛 CdpUnreachableError 并携带指引", async () => {
		try {
			await resolveWsUrl("http://127.0.0.1:1", 1500);
			throw new Error("不应到达");
		} catch (err) {
			expect(err instanceof CdpUnreachableError).toBe(true);
			expect((err as CdpUnreachableError).guidance).toContain("remote-debugging-port");
		}
	});
});
