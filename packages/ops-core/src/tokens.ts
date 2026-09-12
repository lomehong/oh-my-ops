import * as fs from "node:fs";
import type { PolicyRequest } from "./policy.ts";

export interface ApprovalToken {
	id: string;
	/** scope 形如 "host/service" 或 "host/service/action" */
	scope: string;
	issuedBy: string;
	issuedAt: string;
	/** ISO 时间；过期即失效。缺省 = 永不过期（需 Owner 显式签发） */
	expiresAt?: string;
	nonce?: string;
}

export interface TokenFile {
	tokens?: readonly ApprovalToken[];
}

export interface TokenStore {
	/** 只读校验：approval 被宿主求值 3 次，此方法必须无副作用（X21，方案 §7.4.4 规范 2） */
	find(request: PolicyRequest): { token: ApprovalToken; valid: true } | { valid: false };
}

/**
 * 读取批准令牌库；文件缺失 → 空库（无令牌 = 无放行）。
 * ★ 令牌的「消费」（写 nonce/置已用）不在此处——approval 被求值 3 次，
 *   消费必须发生在 ③ execute 复核通过之后（方案 §7.4.4 规范 3）。
 */
export function loadTokenStore(path: string): TokenStore {
	let tokens: readonly ApprovalToken[] = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as TokenFile;
		tokens = parsed.tokens ?? [];
	} catch {
		tokens = [];
	}
	return new StaticTokenStore(tokens);
}

export class StaticTokenStore implements TokenStore {
	private readonly tokens: readonly ApprovalToken[];
	constructor(tokens: readonly ApprovalToken[]) {
		this.tokens = tokens;
	}

	find(request: PolicyRequest): { token: ApprovalToken; valid: true } | { valid: false } {
		const token = this.tokens.find((candidate) => tokenActive(candidate) && tokenCovers(candidate, request));
		return token === undefined ? { valid: false } : { token, valid: true };
	}
}

function tokenActive(token: ApprovalToken): boolean {
	if (token.expiresAt === undefined) return true;
	return Date.parse(token.expiresAt) > Date.now();
}

function tokenCovers(token: ApprovalToken, request: PolicyRequest): boolean {
	if (request.host === undefined) return false;
	const wanted = [request.host, request.service, request.action].filter((x) => x !== undefined).join("/");
	return token.scope === wanted || token.scope === request.host;
}
