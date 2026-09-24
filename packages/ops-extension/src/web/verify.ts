/**
 * verify.ts —— 「像人一样访问 web 页面并验证」的编排层
 *
 * 设计要点：
 *   - 纯逻辑（断言评估、失败请求过滤、裁决组装）与 CDP 驱动分离 ⇒ 纯逻辑可单测，无需真浏览器；
 *   - 拿不到浏览器不是崩溃而是**可执行结论**：返回 ok=false + 启动指引（CdpUnreachableError.guidance）；
 *   - 默认忽略 favicon/数据 URI 等噪音 404，避免把无关噪声当"部署失败"。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Cdp, CdpUnreachableError, type CdpOptions } from "./cdp.ts";

/** verifyPage 需要的最小 CDP 面（便于注入假会话做单测） */
export interface CdpLike {
	send<T extends Record<string, unknown> = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
		timeoutMs?: number,
	): Promise<T>;
	on(sessionId: string, method: string, handler: (params: Record<string, unknown>) => void): () => void;
	waitForEvent(sessionId: string, method: string, timeoutMs?: number): Promise<Record<string, unknown>>;
	attachNewTab(url?: string): Promise<{ targetId: string; sessionId: string }>;
	closeTarget(targetId: string): Promise<void>;
	dispose(): void;
}

export interface CookieSpec {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	url?: string;
}

export interface VerifyOptions {
	url: string;
	/** 等待该选择器出现（SPA 场景必需） */
	waitFor?: string;
	/** 等待页面文本包含该串 */
	waitForText?: string;
	expectTitle?: string;
	/** 期望页面可见文本包含 */
	expectText?: string;
	/** 期望该选择器存在 */
	expectSelector?: string;
	/** 登录态注入（SSO/受保护页面验证） */
	cookies?: CookieSpec[];
	/** 截图落盘路径；缺省 /tmp/omo-web-verify-<时间戳>.png */
	screenshotPath?: string;
	timeoutMs?: number;
	/** 是否要求"无控制台错误/无失败请求"才判 ok（缺省 false：报错只作为证据列出） */
	failOnErrors?: boolean;
	/** 网络空闲判定窗口（毫秒，缺省 400）：无在途请求持续这么久即视为渲染/请求已结算 */
	settleMs?: number;
}

export interface AssertionResult {
	kind: "title" | "text" | "selector" | "waitFor" | "waitForText" | "endpoint";
	target: string;
	pass: boolean;
	detail: string;
}

export interface VerifyVerdict {
	ok: boolean;
	endpoint: string;
	url: string;
	title: string;
	assertions: AssertionResult[];
	consoleErrors: { type: string; text: string; location?: string }[];
	pageErrors: { text: string }[];
	failedRequests: { method: string; url: string; status: number; errorText?: string }[];
	ignoredNoise: number;
	screenshot?: string;
	durationMs: number;
	notes: string[];
}

export interface PageSnapshot {
	title: string;
	text: string;
	/** 选择器是否存在 */
	has: (selector: string) => boolean;
}

/* ───────────────────────── 纯逻辑（可单测） ───────────────────────── */

/** 噪音请求：favicon / data: / devtools 等，不计入"失败请求" */
export function isNoiseRequest(url: string): boolean {
	return /favicon\.ico($|\?)/i.test(url) || /^data:/i.test(url) || /^blob:/i.test(url) || /devtools:\/\//i.test(url);
}

/** 从网络事件里挑出失败请求；忽略噪音 */
export function pickFailedRequests(
	responses: { url: string; status: number; method?: string }[],
	loadingFailures: { url: string; errorText: string }[] = [],
): { failed: VerifyVerdict["failedRequests"]; ignoredNoise: number } {
	const failed: VerifyVerdict["failedRequests"] = [];
	let ignoredNoise = 0;
	for (const r of responses) {
		if (r.status < 400) continue;
		if (isNoiseRequest(r.url)) {
			ignoredNoise++;
			continue;
		}
		failed.push({ method: r.method ?? "GET", url: r.url, status: r.status });
	}
	for (const f of loadingFailures) {
		if (isNoiseRequest(f.url)) {
			ignoredNoise++;
			continue;
		}
		failed.push({ method: "GET", url: f.url, status: 0, errorText: f.errorText });
	}
	return { failed, ignoredNoise };
}

/** 按期望评估断言（纯函数：只吃快照） */
export function evaluateAssertions(snap: PageSnapshot, opts: VerifyOptions): AssertionResult[] {
	const out: AssertionResult[] = [];
	if (opts.expectTitle !== undefined) {
		const pass = snap.title.includes(opts.expectTitle);
		out.push({ kind: "title", target: opts.expectTitle, pass, detail: `实际标题「${snap.title}」` });
	}
	if (opts.expectText !== undefined) {
		const pass = snap.text.includes(opts.expectText);
		out.push({ kind: "text", target: opts.expectText, pass, detail: pass ? "页面文本命中" : "页面文本未命中" });
	}
	if (opts.expectSelector !== undefined) {
		const pass = snap.has(opts.expectSelector);
		out.push({ kind: "selector", target: opts.expectSelector, pass, detail: pass ? "选择器存在" : "选择器不存在" });
	}
	return out;
}

/** 组装裁决：ok = 全部断言通过（可选叠加「无错误」要求） */
export function buildVerdict(input: Omit<VerifyVerdict, "ok"> & { failOnErrors?: boolean }): VerifyVerdict {
	const assertionsPass = input.assertions.every((a) => a.pass);
	const hasErrors = input.consoleErrors.length > 0 || input.pageErrors.length > 0 || input.failedRequests.length > 0;
	const ok = assertionsPass && (input.failOnErrors === true ? !hasErrors : true);
	const notes = [...input.notes];
	if (input.ignoredNoise > 0) notes.push(`已忽略 ${input.ignoredNoise} 条噪音请求（favicon/data: 等）`);
	if (!assertionsPass) notes.push(`断言未通过：${input.assertions.filter((a) => !a.pass).map((a) => a.target).join("、")}`);
	if (hasErrors) notes.push("存在控制台错误/页面异常/失败请求——见对应字段（failOnErrors=false 时不影响 ok）");
	if (input.screenshot !== undefined) notes.push(`截图：${input.screenshot}`);
	const { failOnErrors: _ignored, ...rest } = input;
	return { ok, ...rest, notes };
}

/* ───────────────────────── CDP 驱动 ───────────────────────── */

type RuntimeEvaluateResult = {
	result?: { value?: unknown };
	exceptionDetails?: { text?: string };
};

async function evaluate(cdp: CdpLike, sessionId: string, expression: string, timeoutMs: number): Promise<unknown> {
	const res = await cdp.send<RuntimeEvaluateResult>(
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise: true },
		sessionId,
		timeoutMs,
	);
	return res.result?.value;
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 150): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await fn()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/**
 * 真实访问并验证。返回结构化裁决——**任何失败都以裁决呈现**（含端点不可达时的启动指引）。
 * cdp 可注入（测试用假会话）。
 */
export async function verifyPage(opts: VerifyOptions, deps: { cdp?: CdpLike; endpoint?: string; cdpOptions?: CdpOptions } = {}): Promise<VerifyVerdict> {
	const started = Date.now();
	const endpoint = deps.endpoint ?? process.env.OMO_BROWSER_CDP ?? "http://127.0.0.1:9222";
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const base: Omit<VerifyVerdict, "ok"> = {
		endpoint,
		url: opts.url,
		title: "",
		assertions: [],
		consoleErrors: [],
		pageErrors: [],
		failedRequests: [],
		ignoredNoise: 0,
		durationMs: 0,
		notes: [],
	};

	let cdp: CdpLike | undefined = deps.cdp;
	let owned = false;
	let targetId: string | undefined;
	try {
		if (cdp === undefined) {
			cdp = await Cdp.connect(endpoint, deps.cdpOptions ?? {});
			owned = true;
		}
		const { targetId: tid, sessionId } = await cdp.attachNewTab();
		targetId = tid;
		const client = cdp;

		// 事件采集
		const consoleErrors: VerifyVerdict["consoleErrors"] = [];
		const pageErrors: VerifyVerdict["pageErrors"] = [];
		const responses: { url: string; status: number; method?: string }[] = [];
		const failures: { url: string; errorText: string }[] = [];
		client.on(sessionId, "Runtime.consoleAPICalled", (p) => {
			if (p.type !== "error" && p.type !== "warning") return;
			const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
			const text = args.map((a) => String(a.value ?? a.description ?? "")).join(" ").trim();
			consoleErrors.push({ type: String(p.type), text, location: undefined });
		});
		client.on(sessionId, "Runtime.exceptionThrown", (p) => {
			const d = (p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined) ?? {};
			pageErrors.push({ text: d.exception?.description ?? d.text ?? "未知异常" });
		});
		client.on(sessionId, "Network.responseReceived", (p) => {
			const r = (p.response as { url?: string; status?: number } | undefined) ?? {};
			responses.push({ url: String(r.url ?? ""), status: Number(r.status ?? 0) });
		});
		const requestUrls = new Map<string, string>();
		const inFlight = new Set<string>();
		client.on(sessionId, "Network.requestWillBeSent", (p) => {
			const id = String(p.requestId ?? "");
			const url = String((p.request as { url?: string } | undefined)?.url ?? "");
			if (id !== "" && url !== "") requestUrls.set(id, url);
			if (id !== "") inFlight.add(id);
		});
		client.on(sessionId, "Network.loadingFinished", (p) => {
			const id = String(p.requestId ?? "");
			if (id !== "") inFlight.delete(id);
		});
		client.on(sessionId, "Network.loadingFailed", (p) => {
			const id = String(p.requestId ?? "");
			if (id !== "") inFlight.delete(id);
			failures.push({ url: requestUrls.get(id) ?? id, errorText: String(p.errorText ?? "loadingFailed") });
		});

		for (const domain of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) {
			await client.send(domain, {}, sessionId, timeoutMs);
		}

		// 登录态注入（SSO cookie）：导航前设置
		for (const c of opts.cookies ?? []) {
			await client.send(
				"Network.setCookie",
				{
					name: c.name,
					value: c.value,
					...(c.domain !== undefined ? { domain: c.domain } : {}),
					...(c.path !== undefined ? { path: c.path } : {}),
					...(c.url !== undefined ? { url: c.url } : { url: opts.url }),
				},
				sessionId,
				timeoutMs,
			);
		}

		// 导航 + 等待加载
		const loaded = client.waitForEvent(sessionId, "Page.loadEventFired", timeoutMs).catch(() => undefined);
		await client.send("Page.navigate", { url: opts.url }, sessionId, timeoutMs);
		await loaded;

		// 等待条件（SPA 渲染）
		if (opts.waitFor !== undefined) {
			const okWait = await waitUntil(
				async () => (await evaluate(client, sessionId, `!!document.querySelector(${JSON.stringify(opts.waitFor)})`, timeoutMs)) === true,
				timeoutMs,
			);
			base.assertions.push({ kind: "waitFor", target: opts.waitFor, pass: okWait, detail: okWait ? "选择器已出现" : "等待超时" });
		}
		if (opts.waitForText !== undefined) {
			const okWait = await waitUntil(
				async () =>
					(await evaluate(
						client,
						sessionId,
						`(document.body ? document.body.innerText : "").includes(${JSON.stringify(opts.waitForText)})`,
						timeoutMs,
					)) === true,
				timeoutMs,
			);
			base.assertions.push({ kind: "waitForText", target: opts.waitForText, pass: okWait, detail: okWait ? "文本已出现" : "等待超时" });
		}

		// 等网络空闲：固定 sleep 会漏掉"页面 fetch 结算晚于读取窗口"的情形（真机教训：404 采集不到）
		const idleMs = opts.settleMs ?? 400;
		// 上限 3s：长轮询/SSE 类站点"在途永远非 0"，等满会拖垮裁决（超时即继续，证据仍在）
		await waitUntil(async () => inFlight.size === 0, Math.min(timeoutMs, 3000), 100);
		await new Promise((r) => setTimeout(r, idleMs));

		// 快照（供断言纯函数评估）
		const title = String((await evaluate(client, sessionId, "document.title", timeoutMs)) ?? "");
		const text = String((await evaluate(client, sessionId, `(document.body ? document.body.innerText : "")`, timeoutMs)) ?? "");
		const selectorCache = new Map<string, boolean>();
		const snap: PageSnapshot = {
			title,
			text,
			has: (sel) => selectorCache.get(sel) === true,
		};
		if (opts.expectSelector !== undefined) {
			selectorCache.set(
				opts.expectSelector,
				(await evaluate(client, sessionId, `!!document.querySelector(${JSON.stringify(opts.expectSelector)})`, timeoutMs)) === true,
			);
		}
		const expectAssertions = evaluateAssertions(snap, opts);
		base.assertions.push(...expectAssertions);

		// 截图
		let screenshot: string | undefined;
		try {
			const shot = await client.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId, timeoutMs);
			const file = opts.screenshotPath ?? path.join("/tmp", `omo-web-verify-${Date.now()}.png`);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, Buffer.from(shot.data, "base64"), { mode: 0o644 });
			screenshot = file;
		} catch (err) {
			base.notes.push(`截图失败：${String((err as Error)?.message ?? err)}`);
		}

		// 证据读取前的最后宽限（事件已随空闲期到达；此处仅兜底微小时序）
		await new Promise((r) => setTimeout(r, 100));
		const perfRaw = await evaluate(
			client,
			sessionId,
			`JSON.stringify(performance.getEntriesByType("resource").map(e => ({ url: e.name, status: e.responseStatus || 0 })))`,
			timeoutMs,
		);
		try {
			const perf = JSON.parse(String(perfRaw ?? "[]")) as { url: string; status: number }[];
			for (const e of perf) {
				if (e.status >= 400 && !responses.some((r) => r.url === e.url && r.status === e.status)) {
					responses.push({ url: e.url, status: e.status });
				}
			}
		} catch {
			// Resource Timing 不可用（老内核/cross-origin 限制）时忽略，不影响 CDP 证据
		}
		if (process.env.OMO_WEB_VERIFY_DEBUG === "1") {
			base.notes.push(
				`DBG responses=${JSON.stringify(responses)} failures=${JSON.stringify(failures)} perf=${String(perfRaw).slice(0, 300)}`,
			);
		}
		const { failed, ignoredNoise } = pickFailedRequests(responses, failures);
		return buildVerdict({
			...base,
			url: String((await evaluate(client, sessionId, "location.href", timeoutMs)) ?? opts.url),
			title,
			consoleErrors,
			pageErrors,
			failedRequests: failed,
			ignoredNoise,
			screenshot,
			durationMs: Date.now() - started,
			notes: base.notes,
			failOnErrors: opts.failOnErrors,
		});
	} catch (err) {
		const detail = String((err as Error)?.message ?? err);
		if (err instanceof CdpUnreachableError) {
			base.notes.push(err.guidance);
		} else {
			base.notes.push(`验证中断：${detail}`);
		}
		// 显式记一条失败断言：空断言集合 every() 恒真，会伪装成"通过"（真机教训）
		base.assertions.push({ kind: "endpoint", target: endpoint, pass: false, detail });
		return buildVerdict({ ...base, durationMs: Date.now() - started, failOnErrors: opts.failOnErrors, assertions: base.assertions });
	} finally {
		if (targetId !== undefined && cdp !== undefined) await cdp.closeTarget(targetId);
		if (owned && cdp !== undefined) cdp.dispose();
	}
}
