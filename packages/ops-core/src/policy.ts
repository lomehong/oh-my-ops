import { OpsError } from "./errors.ts";
import * as fs from "node:fs";

/**
 * 本机哨兵主机名：当前所有 ops_* 工具都在控制节点本地执行（远程执行 P1 经 SshPool 引入）。
 * 因此目标策略匹配一律以 LOCAL_HOST 为 host 维度——policy.json 中用 "@local" 表示本机。
 * ★ "@@" 不是合法 hostname 字符，无法与真实主机名冲突（防「伪造成已授权值」）。
 */
export const LOCAL_HOST = "@local";

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
	readonly rules: readonly TargetRule[];
	constructor(rules: readonly TargetRule[]) {
		this.rules = rules;
		this.isConfigured = rules.length > 0;
	}

	isProduction(request: PolicyRequest): boolean {
		// ★ 标记 ≠ 授予：isProduction 用 ruleMarks（规则未指定的维度 = 通配，整机标记），
		//   allows 用 ruleCovers（规则未指定的维度 = 不覆盖，保守侧）。过期规则两者均失效。
		return this.rules.some((rule) => rule.production === true && ruleActive(rule) && ruleMarks(rule, request));
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

export function ruleActive(rule: TargetRule, now: number = Date.now()): boolean {
	if (rule.expiresAt === undefined) return true;
	return Date.parse(rule.expiresAt) > now;
}

/** 单条规则对请求的逐维度匹配轨迹（供 explain dry-run 展示；判定语义与 ruleCovers/ruleMarks 完全一致） */
export interface RuleTrace {
	index: number;
	rule: TargetRule;
	active: boolean;
	hostMatch: boolean;
	/** 放行语义（allows 的单条投影）：非生产规则 + 生效 + ruleCovers（规则未声明的维度 = 不覆盖） */
	covers: boolean;
	/** 生产标记语义（isProduction 的单条投影）：生产规则 + 生效 + ruleMarks（规则未声明的维度 = 通配） */
	marks: boolean;
	/** 放行失败的首个原因（expired / production / host / service / action），covers=true 时为 undefined */
	failedOn?: "expired" | "production" | "host" | "service" | "action";
}

export function traceRule(rule: TargetRule, index: number, request: PolicyRequest, now: number = Date.now()): RuleTrace {
	const active = ruleActive(rule, now);
	const hostMatch = ruleMatchesHost(rule, request.host);
	const covers = rule.production !== true && active && ruleCovers(rule, request);
	const marks = rule.production === true && active && ruleMarks(rule, request);
	let failedOn: RuleTrace["failedOn"];
	if (!covers) {
		if (!active) failedOn = "expired";
		else if (rule.production === true) failedOn = "production";
		else if (!hostMatch) failedOn = "host";
		else if (
			(request.service !== undefined && (rule.services === undefined || !rule.services.includes(request.service))) ||
			(request.service === undefined && rule.services !== undefined)
		) failedOn = "service";
		else failedOn = "action";
	}
	return { index, rule, active, hostMatch, covers, marks, failedOn };
}

export function traceRules(rules: readonly TargetRule[], request: PolicyRequest, now: number = Date.now()): RuleTrace[] {
	return rules.map((rule, index) => traceRule(rule, index, request, now));
}

function ruleMatchesHost(rule: TargetRule, host?: string): boolean {
	return host !== undefined && rule.host === host;
}

function ruleCovers(rule: TargetRule, request: PolicyRequest): boolean {
	if (!ruleMatchesHost(rule, request.host)) return false;
	// ★ 服务维度显式性（P11 起双侧收紧）：
	//   请求带 service → 必须命中规则的 services 白名单（规则未约束 service = 通配）；
	//   规则带 services 白名单而请求未指定 service → 不覆盖——服务级规则（如 nginx/restart）
	//   不得连带放行无服务维度的请求（文件写入等），否则「最小服务授权」会被暗中扩大成整机授权。
	if (request.service !== undefined) {
		if (rule.services === undefined || !rule.services.includes(request.service)) return false;
	} else if (rule.services !== undefined) {
		return false;
	}
	// action 维度：请求带 action 且规则声明 actions → 必须命中。
	// P11 起 write 档工具携带显式 action（file-write / vault-write）——shell/services 规则
	// 不再连带放行写档工具；Owner 显式的全 host 规则（无 services 无 actions）仍覆盖一切。
	if (request.action !== undefined && rule.actions !== undefined && !rule.actions.includes(request.action)) {
		return false;
	}
	return true;
}

/**
 * 生产标记匹配（仅 isProduction 使用）：与 ruleCovers 的**极性相反**——
 * 规则指定的维度（services/actions）必须命中，未指定的维度 = 通配（整机/全动作标记）。
 * 例：{host:"prod-db", production:true} 标记 prod-db 上一切请求；
 *     {host:"@local", services:["core-db"], production:true} 只标记 core-db。
 * 标记只收紧（多拦须令牌），不授予任何权限，故取宽匹配是安全侧。
 */
function ruleMarks(rule: TargetRule, request: PolicyRequest): boolean {
	if (!ruleMatchesHost(rule, request.host)) return false;
	if (rule.services !== undefined && (request.service === undefined || !rule.services.includes(request.service))) {
		return false;
	}
	if (rule.actions !== undefined && (request.action === undefined || !rule.actions.includes(request.action))) {
		return false;
	}
	return true;
}

function describe(request: PolicyRequest): string {
	const parts = [request.host, request.service, request.action].filter((x) => x !== undefined);
	return parts.length > 0 ? parts.join("/") : "(空请求)";
}

/** 读取 policy.json（静态快照）；任何读取/解析失败 → 全拒策略（保守侧，§7.4.3 降级语义；不崩宿主） */
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

/** 读取文件 mtime；文件不存在 → -1（出现后 mtime 变化触发重载） */
export function statMtimeMs(path: string): number {
	try {
		return fs.statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

/**
 * 可重载目标策略：以 mtime 感知文件变化，Owner 编辑 policy.json 后**下次判定即生效**（§7.4.3 降级语义）。
 * 所有方法在判定前懒刷新——代价是一次 statSync，换取策略热更新。
 * 加载/解析失败 → 全拒（保守侧），与 loadTargetPolicy 相同。
 */
export class ReloadableTargetPolicy implements TargetPolicy {
	readonly path: string;
	private current: DefaultDenyPolicy;
	private mtimeMs: number;

	constructor(path: string) {
		this.path = path;
		this.current = loadTargetPolicy(path) as DefaultDenyPolicy;
		this.mtimeMs = statMtimeMs(path);
	}

	/** mtime 变化 → 重读文件（缺失/损坏 → 全拒） */
	refresh(): void {
		const mtime = statMtimeMs(this.path);
		if (mtime === this.mtimeMs) return;
		this.mtimeMs = mtime;
		this.current = loadTargetPolicy(this.path) as DefaultDenyPolicy;
	}

	get isConfigured(): boolean {
		this.refresh();
		return this.current.isConfigured;
	}

	/** 当前生效的规则快照（懒刷新；供 explain/lint 只读展示） */
	get rules(): readonly TargetRule[] {
		this.refresh();
		return this.current.rules;
	}

	isProduction(request: PolicyRequest): boolean {
		this.refresh();
		return this.current.isProduction(request);
	}

	allows(request: PolicyRequest): boolean {
		this.refresh();
		return this.current.allows(request);
	}

	/** defaultDeny；不通过抛 OpsError("POLICY_DENIED") */
	check(request: PolicyRequest): void {
		this.refresh();
		this.current.check(request);
	}
}
