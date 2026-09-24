/**
 * cdp.ts —— 零依赖 CDP（Chrome DevTools Protocol）客户端
 *
 * 为什么不用 playwright：omo 的 agent 包是自包含发布物，引入 playwright（含浏览器与数十 MB 依赖）
 * 会把包体和攻击面一起带进来；而 CDP 是浏览器自带的 HTTP+WebSocket 协议，Bun 原生 WebSocket 即可驱动。
 *
 * 约定：
 *   - 端点形如 http://127.0.0.1:9222（浏览器 `--remote-debugging-port`）；
 *   - 传输层可注入（测试用假传输，无需真浏览器）；
 *   - 所有命令带超时；端点不可达时抛 CdpUnreachableError（含启动指引，由上层组装给用户）。
 */

export class CdpUnreachableError extends Error {
	readonly guidance: string;
	constructor(endpoint: string, cause: string) {
		super(`无法连接 CDP 端点 ${endpoint}：${cause}`);
		this.name = "CdpUnreachableError";
		this.guidance = [
			`未发现无头浏览器 CDP 端点在 ${endpoint}。三种起法（任选）：`,
			"1) 本机容器（推荐，绕过老发行版 glibc 限制）：",
			'   docker run -d --rm --name omo-chrome -p 127.0.0.1:9222:9222 --shm-size=1g \\',
			'     zenika/alpine-chrome:latest --no-sandbox --disable-dev-shm-usage \\',
			'     --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 about:blank',
			"2) 现代发行版本机直跑：",
			"   chromium --headless=new --no-sandbox --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 about:blank",
			"3) 远程集中式：在可达的现代机器上跑同样命令，然后设 OMO_BROWSER_CDP=http://<host>:9222",
		].join("\n");
	}
}

export interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	sessionId?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/** 传输层接口：真实现走 WebSocket，测试注入假实现 */
export interface CdpTransport {
	send(payload: string): void;
	close(): void;
	onMessage(handler: (raw: string) => void): void;
	onClose(handler: (reason: string) => void): void;
	/** 连接就绪（WebSocket OPEN）；缺省视为立即可用（测试用假传输） */
	ready?: Promise<void>;
}

export type TransportFactory = (wsUrl: string) => CdpTransport;

export interface CdpOptions {
	/** 浏览器级 WebSocket 地址；缺省由 endpoint 经 /json/version 解析 */
	wsUrl?: string;
	/** 命令默认超时（毫秒） */
	timeoutMs?: number;
	transportFactory?: TransportFactory;
}

const realTransportFactory: TransportFactory = (wsUrl) => {
	const ws = new WebSocket(wsUrl);
	let markReady: () => void = () => {};
	let markFailed: (e: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		markFailed = reject;
	});
	ws.addEventListener("open", () => markReady(), { once: true });
	ws.addEventListener("error", () => markFailed(new Error("WebSocket 连接/握手失败")), { once: true });
	const handlers: ((raw: string) => void)[] = [];
	const closers: ((reason: string) => void)[] = [];
	ws.addEventListener("message", (ev: MessageEvent) => {
		const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
		for (const h of handlers) h(raw);
	});
	ws.addEventListener("close", () => {
		for (const c of closers) c("websocket closed");
	});
	return {
		send: (payload) => ws.send(payload),
		close: () => ws.close(),
		onMessage: (h) => handlers.push(h),
		onClose: (h) => closers.push(h),
		ready,
	};
};

/** 解析 CDP 端点 → 浏览器级 WebSocket 地址（/json/version 的 webSocketDebuggerUrl） */
export async function resolveWsUrl(endpoint: string, timeoutMs = 5000): Promise<string> {
	const base = endpoint.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as { webSocketDebuggerUrl?: string };
		if (typeof json.webSocketDebuggerUrl !== "string" || json.webSocketDebuggerUrl === "") {
			throw new Error("响应缺少 webSocketDebuggerUrl");
		}
		return json.webSocketDebuggerUrl;
	} catch (err) {
		throw new CdpUnreachableError(endpoint, String((err as Error)?.message ?? err));
	}
}

/**
 * CDP 会话：id 关联请求-响应；事件按 (sessionId, method) 分发。
 * 用法：const cdp = await Cdp.connect(endpoint)；const { sessionId } = await cdp.attachNewTab();
 */
export class Cdp {
	#transport: CdpTransport;
	#nextId = 1;
	#pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: Timer }>();
	#listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
	#defaultTimeout: number;
	#closed = false;

	private constructor(transport: CdpTransport, timeoutMs: number) {
		this.#transport = transport;
		this.#defaultTimeout = timeoutMs;
		this.#transport.onMessage((raw) => this.#onMessage(raw));
		this.#transport.onClose((reason) => {
			this.#closed = true;
			for (const [, p] of this.#pending) {
				clearTimeout(p.timer);
				p.reject(new Error(`CDP 连接中断：${reason}`));
			}
			this.#pending.clear();
		});
	}

	/** 连接浏览器级端点 */
	static async connect(endpoint: string, opts: CdpOptions = {}): Promise<Cdp> {
		const wsUrl = opts.wsUrl ?? (await resolveWsUrl(endpoint));
		const factory = opts.transportFactory ?? realTransportFactory;
		const transport = factory(wsUrl);
		if (transport.ready !== undefined) {
			try {
				await transport.ready;
			} catch (err) {
				try {
					transport.close();
				} catch {
					// 关闭失败无妨
				}
				throw new CdpUnreachableError(endpoint, String((err as Error)?.message ?? err));
			}
		}
		return new Cdp(transport, opts.timeoutMs ?? 20_000);
	}

	/** 供测试：直接用假传输构造 */
	static fromTransport(transport: CdpTransport, timeoutMs = 5000): Cdp {
		return new Cdp(transport, timeoutMs);
	}

	get closed(): boolean {
		return this.#closed;
	}

	#onMessage(raw: string): void {
		let msg: CdpMessage;
		try {
			msg = JSON.parse(raw) as CdpMessage;
		} catch {
			return;
		}
		if (msg.id !== undefined) {
			const p = this.#pending.get(msg.id);
			if (p === undefined) return;
			clearTimeout(p.timer);
			this.#pending.delete(msg.id);
			if (msg.error !== undefined) p.reject(new Error(`CDP ${msg.error.message}（code ${msg.error.code}）`));
			else p.resolve(msg.result ?? {});
			return;
		}
		if (msg.method !== undefined) {
			const key = `${msg.sessionId ?? ""}:${msg.method}`;
			for (const h of this.#listeners.get(key) ?? []) h(msg.params ?? {});
			for (const h of this.#listeners.get(`*:${msg.method}`) ?? []) h(msg.params ?? {});
		}
	}

	/** 发送命令；sessionId 省略 = 浏览器级 */
	send<T extends Record<string, unknown> = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
		timeoutMs?: number,
	): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("CDP 连接已关闭"));
		const id = this.#nextId++;
		const payload: CdpMessage = { id, method, params };
		if (sessionId !== undefined) payload.sessionId = sessionId;
		const timeout = timeoutMs ?? this.#defaultTimeout;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`CDP 命令超时（${timeout}ms）：${method}`));
			}, timeout);
			this.#pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer });
			this.#transport.send(JSON.stringify(payload));
		});
	}

	/** 订阅事件（sessionId 传 "*" 匹配任意会话） */
	on(sessionId: string, method: string, handler: (params: Record<string, unknown>) => void): () => void {
		const key = `${sessionId}:${method}`;
		const list = this.#listeners.get(key) ?? [];
		list.push(handler);
		this.#listeners.set(key, list);
		return () => {
			const cur = this.#listeners.get(key) ?? [];
			this.#listeners.set(
				key,
				cur.filter((h) => h !== handler),
			);
		};
	}

	/** 新开标签并附着（flatten 模式：命令带 sessionId） */
	async attachNewTab(url = "about:blank"): Promise<{ targetId: string; sessionId: string }> {
		const created = await this.send<{ targetId: string }>("Target.createTarget", { url });
		const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
		return { targetId: created.targetId, sessionId: attached.sessionId };
	}

	async closeTarget(targetId: string): Promise<void> {
		try {
			await this.send("Target.closeTarget", { targetId });
		} catch {
			// 关闭失败不影响结论
		}
	}

	/** 等待某事件（一次） */
	waitForEvent(sessionId: string, method: string, timeoutMs?: number): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const timeout = timeoutMs ?? this.#defaultTimeout;
			const timer = setTimeout(() => {
				off();
				reject(new Error(`等待事件超时（${timeout}ms）：${method}`));
			}, timeout);
			const off = this.on(sessionId, method, (params) => {
				clearTimeout(timer);
				off();
				resolve(params);
			});
		});
	}

	dispose(): void {
		this.#closed = true;
		this.#transport.close();
	}
}
