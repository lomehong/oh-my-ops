import * as fs from "node:fs";
import type { PolicyRequest } from "./policy.ts";
import { statMtimeMs } from "./policy.ts";

export interface ApprovalToken {
	id: string;
	/** scope 形如 "host"、"host/service" 或 "host/service/action"（逐段前缀匹配，见 tokenCovers） */
	scope: string;
	issuedBy: string;
	issuedAt: string;
	/** ISO 时间；过期即失效。缺省 = 永不过期（需 Owner 显式签发） */
	expiresAt?: string;
	/** 单次批准语义：③ 复核通过后由 consume 写入；带 consumedAt 的令牌不再生效 */
	consumedAt?: string;
	nonce?: string;
}

export interface TokenFile {
	tokens?: readonly ApprovalToken[];
}

export interface TokenStore {
	/**
	 * 只读校验：approval 被宿主求值 3 次，此方法不得产生影响判定语义的副作用（X21，方案 §7.4.4 规范 2）。
	 * 允许内部的 mtime 检查与文件读取（幂等，不改变判定结果）。
	 */
	find(request: PolicyRequest): { token: ApprovalToken; valid: true } | { valid: false };
	/**
	 * 消费命中的令牌（单次批准语义）。
	 * ★ 只能在 ③ execute 复核通过之后调用（X21 规范 3）——approval 求值期间严禁调用。
	 */
	consume(request: PolicyRequest): void;
}

/**
 * 读取批准令牌库（静态快照）；文件缺失 → 空库（无令牌 = 无放行）。
 * ★ 令牌的「消费」不在此处——approval 被求值 3 次，消费必须发生在 ③ execute 复核通过之后。
 */
export function loadTokenStore(path: string): TokenStore {
	return new ReloadableTokenStore(path);
}

/** 静态内存令牌库（测试/降级用）：consume 只改内存副本 */
export class StaticTokenStore implements TokenStore {
	private tokens: ApprovalToken[];
	constructor(tokens: readonly ApprovalToken[]) {
		this.tokens = [...tokens];
	}

	find(request: PolicyRequest): { token: ApprovalToken; valid: true } | { valid: false } {
		const token = this.tokens.find((candidate) => tokenActive(candidate) && tokenCovers(candidate, request));
		return token === undefined ? { valid: false } : { token, valid: true };
	}

	/** 内存消费：置 consumedAt，后续 find 不再命中 */
	consume(request: PolicyRequest): void {
		const found = this.find(request);
		if (!found.valid) return;
		this.tokens = this.tokens.map((t) =>
			t === found.token || t.id === found.token.id ? { ...t, consumedAt: new Date().toISOString() } : t,
		);
	}
}

/**
 * 可重载令牌库：以 mtime 感知文件变化——Owner 签发令牌后**下次判定即生效**（§7.4.3）。
 * find() 懒刷新（mtime 检查 + 读文件，幂等）；consume() 在 ③ 复核通过后写回 consumedAt。
 * 写回策略：先改内存（本进程立即不可重放），再原子写文件（tmp + rename）；写失败时内存态仍保证单次。
 */
export class ReloadableTokenStore implements TokenStore {
	readonly path: string;
	private tokens: readonly ApprovalToken[];
	private mtimeMs: number;

	constructor(path: string) {
		this.path = path;
		this.tokens = readTokenFile(path);
		this.mtimeMs = statMtimeMs(path);
	}

	/** mtime 变化 → 重读文件（缺失/损坏 → 空库 = 无放行） */
	refresh(): void {
		const mtime = statMtimeMs(this.path);
		if (mtime === this.mtimeMs) return;
		this.mtimeMs = mtime;
		this.tokens = readTokenFile(this.path);
	}

	find(request: PolicyRequest): { token: ApprovalToken; valid: true } | { valid: false } {
		this.refresh();
		const token = this.tokens.find((candidate) => tokenActive(candidate) && tokenCovers(candidate, request));
		return token === undefined ? { valid: false } : { token, valid: true };
	}

	consume(request: PolicyRequest): void {
		this.refresh();
		const found = this.find(request);
		if (!found.valid) return;
		const consumedAt = new Date().toISOString();
		// ① 内存先行：本进程立即不可重放（即使写盘失败）
		this.tokens = this.tokens.map((t) => (t.id === found.token.id ? { ...t, consumedAt } : t));
		// ② 原子写盘：跨进程/跨会话也不可重放
		try {
			const file: TokenFile = { tokens: this.tokens };
			const tmp = `${this.path}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(file, null, "\t"));
			fs.renameSync(tmp, this.path);
			this.mtimeMs = statMtimeMs(this.path);
		} catch {
			// 写盘失败：内存态已消费（保守侧）；Owner 可见 tmp 残留
		}
	}
}

function readTokenFile(path: string): readonly ApprovalToken[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as TokenFile;
		return parsed.tokens ?? [];
	} catch {
		return [];
	}
}

function tokenActive(token: ApprovalToken): boolean {
	if (token.consumedAt !== undefined) return false; // 单次批准：已消费即失效
	if (token.expiresAt === undefined) return true;
	return Date.parse(token.expiresAt) > Date.now();
}

/**
 * scope 逐段前缀匹配：scope 的每一段都必须与请求路径对应段完全一致。
 *   "@local" ⊂ 覆盖本机全部操作；"@local/nginx" 覆盖该服务任意 action；"@local/nginx/restart" 精确到动作。
 * host 维度必须存在（无 host 的请求无目标语义，不匹配任何令牌）。
 */
function tokenCovers(token: ApprovalToken, request: PolicyRequest): boolean {
	if (request.host === undefined) return false;
	const wanted = [request.host, request.service, request.action].filter((x) => x !== undefined);
	const scope = token.scope.split("/");
	if (scope.length > wanted.length) return false;
	return scope.every((part, i) => wanted[i] === part);
}
