import { OpsError } from "./errors.ts";
import * as fs from "node:fs";


export interface PolicyRequest {
	host?: string;
	service?: string;
	action?: string;
	command?: string;
}

/**
 * 第③层：目标策略（方案 §7.4 第③层）。
 * 语义 = 目标导向的 defaultDeny：不在允许清单内的一律拒绝，与调用方身份无关。
 * 纯函数实现，可单测；审批门（authorizedExec）与 execute 复核（assertAuthorized）共用。
 */
export interface TargetPolicy {
	readonly isConfigured: boolean;
	isProduction(request: PolicyRequest): boolean;
	allows(request: PolicyRequest): boolean;
	/** defaultDeny；不通过抛 OpsError("POLICY_DENIED") */
	check(request: PolicyRequest): void;
}

export interface TargetRule {
	host: string;
	services?: readonly string[];
	actions?: readonly string[];
	/** ISO 时间；过期后该规则失效 */
	expiresAt?: string;
	/** 生产目标标记：命中则变更类操作在无人值守下由 ①-b 拒绝（RR-1 收敛） */
	production?: boolean;
}

export interface PolicyFile {
	targets?: readonly TargetRule[];
}

export class DefaultDenyPolicy implements TargetPolicy {
	readonly isConfigured: boolean;
	private readonly rules: readonly TargetRule[];
	constructor(rules: readonly TargetRule[]) {
		this.rules = rules;
		this.isConfigured = rules.length > 0;
	}

	isProduction(request: PolicyRequest): boolean {
		return this.rules.some((rule) => rule.production === true && ruleMatchesHost(rule, request.host));
	}

	/**
	 * ★ production 规则只做「生产标记」（供 ①-b/审计判定），**本身不授予任何放行**——
	 *   生产变更的放行只能来自 P3 批准令牌（Owner 明示批准，决策 D4/A3）。
	 */
	allows(request: PolicyRequest): boolean {
		return this.rules.some((rule) => rule.production !== true && ruleActive(rule) && ruleCovers(rule, request));
	}

	check(request: PolicyRequest): void {
		if (this.allows(request)) return;
		throw new OpsError("POLICY_DENIED", `目标未获预授权：${describe(request)}`);
	}
}

function ruleActive(rule: TargetRule): boolean {
	if (rule.expiresAt === undefined) return true;
	return Date.parse(rule.expiresAt) > Date.now();
}

function ruleMatchesHost(rule: TargetRule, host?: string): boolean {
	return host !== undefined && rule.host === host;
}

function ruleCovers(rule: TargetRule, request: PolicyRequest): boolean {
	if (!ruleMatchesHost(rule, request.host)) return false;
	if (request.service !== undefined && request.action !== undefined) {
		const serviceOk = rule.services?.includes(request.service) ?? true;
		const actionOk = rule.actions?.includes(request.action) ?? true;
		return serviceOk && actionOk;
	}
	if (request.service !== undefined) return rule.services?.includes(request.service) ?? true;
	if (request.action !== undefined) return rule.actions?.includes(request.action) ?? true;
	return true;
}

function describe(request: PolicyRequest): string {
	const parts = [request.host, request.service, request.action].filter((x) => x !== undefined);
	return parts.length > 0 ? parts.join("/") : "(空请求)";
}

/** 读取 policy.json；任何读取/解析失败 → 全拒策略（保守侧，§7.4.3 降级语义；不崩宿主） */
export function loadTargetPolicy(path: string): TargetPolicy {
	let rules: readonly TargetRule[] = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as PolicyFile;
		rules = parsed.targets ?? [];
	} catch {
		rules = []; // 缺失或损坏 → 全拒（可发现性由 session_start 的 isConfigured 提示承担）
	}
	return new DefaultDenyPolicy(rules);
}
