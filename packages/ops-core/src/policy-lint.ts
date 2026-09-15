import { normalizeTargetHost } from "./ssh.ts";
import { LOCAL_HOST } from "./policy.ts";
import type { TargetRule } from "./policy.ts";
import type { ApprovalToken } from "./tokens.ts";

/**
 * policy.json / approval-token.json 静态检查（Owner 侧可见性）。
 * 运行时对损坏/可疑配置的处置是「保守侧静默」（解析失败 → 全拒、过期 → 失效、未知字段 → 忽略），
 * 这对安全是对的，但对 Owner 是不可见的——本模块把这些静默行为显式报告出来。
 * 纯函数：只看文本与时间，不读文件、不做 I/O。
 */
export type LintLevel = "error" | "warn" | "info";

export interface LintFinding {
	level: LintLevel;
	/** 定位：如 targets[2] / tokens[0] / (file) */
	where: string;
	message: string;
}

/** action 词表：无 service 维度的 action（shell/file-write/…）与必须带 service 的 action（restart/exec/…） */
export interface ActionVocabulary {
	serviceless: readonly string[];
	serviceBound: readonly string[];
}

export interface LintOptions {
	now?: number;
	/** 即将过期提示窗口（毫秒），缺省 7 天 */
	expiringWithinMs?: number;
	/** 未提供则跳过 action 词表相关检查 */
	actions?: ActionVocabulary;
}

const RULE_KEYS = new Set(["host", "services", "actions", "expiresAt", "production"]);
const RULE_KEY_HINTS: Readonly<Record<string, string>> = {
	action: "actions（缺 actions = 全动作通配，规则会被暗中放宽）",
	service: "services（缺 services = 无服务维度规则）",
	hosts: "host",
	hostname: "host",
	expires: "expiresAt",
	expire: "expiresAt",
	expiry: "expiresAt",
	prod: "production",
};
const TOKEN_KEYS = new Set(["id", "scope", "issuedBy", "issuedAt", "expiresAt", "consumedAt", "nonce"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((x) => typeof x === "string" && x !== "");
}

function checkHost(raw: unknown, where: string, out: LintFinding[]): string | undefined {
	if (typeof raw !== "string" || raw === "") {
		out.push({ level: "error", where, message: "host 缺失或非字符串——规则不匹配任何请求" });
		return undefined;
	}
	if (raw === LOCAL_HOST) return raw;
	try {
		normalizeTargetHost(raw);
		return raw;
	} catch (error) {
		out.push({ level: "error", where, message: `host 非法：${error instanceof Error ? error.message : String(error)}` });
		return undefined;
	}
}

/** 到期检查：返回 true 表示当前生效 */
function checkExpiry(raw: unknown, where: string, subject: string, opts: LintOptions, out: LintFinding[]): boolean {
	if (raw === undefined) return true;
	const now = opts.now ?? Date.now();
	const ts = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
	if (Number.isNaN(ts)) {
		out.push({ level: "error", where, message: `expiresAt 不可解析（${JSON.stringify(raw)}）——${subject}被视为已过期而永久失效` });
		return false;
	}
	if (ts <= now) {
		out.push({ level: "warn", where, message: `expiresAt 已过期（${raw}）——${subject}已失效` });
		return false;
	}
	if (ts - now <= (opts.expiringWithinMs ?? 7 * DAY_MS)) {
		out.push({ level: "info", where, message: `expiresAt 将于 ${Math.ceil((ts - now) / DAY_MS)} 天内到期（${raw}）` });
	}
	return true;
}

function parseJson(text: string | undefined, where: string, absent: LintFinding, out: LintFinding[]): unknown {
	if (text === undefined) {
		out.push(absent);
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		out.push({ level: "error", where, message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}——运行时按「文件损坏」处理（全拒/空库），不会报错` });
		return undefined;
	}
}

/** policy.json 全文检查；text=undefined 表示文件不存在 */
export function lintPolicySource(text: string | undefined, opts: LintOptions = {}): LintFinding[] {
	const out: LintFinding[] = [];
	const parsed = parseJson(text, "(file)", { level: "warn", where: "(file)", message: "policy.json 不存在——变更类操作全拒（read 档不受影响）" }, out);
	if (parsed === undefined) return out;
	if (!isRecord(parsed)) {
		out.push({ level: "error", where: "(file)", message: "根节点须为对象 { targets: [...] }" });
		return out;
	}
	if (parsed.targets === undefined) {
		out.push({ level: "warn", where: "(file)", message: "缺少 targets 数组——等同空策略（变更类全拒）" });
		return out;
	}
	if (!Array.isArray(parsed.targets)) {
		out.push({ level: "error", where: "targets", message: "targets 须为数组——运行时视为无规则（全拒）" });
		return out;
	}
	out.push(...lintPolicyRules(parsed.targets, opts));
	return out;
}

/** 逐条规则检查（已解析的 targets 数组） */
export function lintPolicyRules(targets: readonly unknown[], opts: LintOptions = {}): LintFinding[] {
	const out: LintFinding[] = [];
	const seen = new Map<string, number>();
	let grantingActive = 0;
	targets.forEach((raw, i) => {
		const where = `targets[${i}]`;
		if (!isRecord(raw)) {
			out.push({ level: "error", where, message: "规则须为对象——运行时会在匹配时抛错或被忽略" });
			return;
		}
		for (const key of Object.keys(raw)) {
			if (RULE_KEYS.has(key) || key.startsWith("$")) continue;
			const hint = RULE_KEY_HINTS[key];
			out.push({ level: "warn", where, message: `未知字段 "${key}" 被运行时忽略${hint ? `——是否想写 ${hint}？` : ""}` });
		}
		checkHost(raw.host, where, out);
		const active = checkExpiry(raw.expiresAt, where, "规则", opts, out);

		if (raw.production !== undefined && typeof raw.production !== "boolean") {
			out.push({ level: "error", where, message: `production 须为布尔值（当前 ${JSON.stringify(raw.production)}）——非 true 值会让本条变成「放行规则」而非生产标记` });
		}
		const granting = raw.production !== true;

		let services: string[] | undefined;
		if (raw.services !== undefined) {
			if (!isStringArray(raw.services)) out.push({ level: "error", where, message: "services 须为非空字符串数组" });
			else if (raw.services.length === 0) out.push({ level: "warn", where, message: "services 为空数组——不匹配任何服务请求（死规则）" });
			else services = raw.services;
		}
		let actions: string[] | undefined;
		if (raw.actions !== undefined) {
			if (!isStringArray(raw.actions)) out.push({ level: "error", where, message: "actions 须为非空字符串数组" });
			else if (raw.actions.length === 0) out.push({ level: "warn", where, message: "actions 为空数组——不匹配任何动作请求（死规则）" });
			else actions = raw.actions;
		}

		if (granting && actions !== undefined && opts.actions !== undefined) {
			const { serviceless, serviceBound } = opts.actions;
			for (const action of actions) {
				if (!serviceless.includes(action) && !serviceBound.includes(action)) {
					out.push({ level: "warn", where, message: `未知 action "${action}"——没有工具会产生该 action，永不匹配（已知：${[...serviceBound, ...serviceless].join("/")}）` });
				} else if (services !== undefined && serviceless.includes(action)) {
					out.push({ level: "warn", where, message: `action "${action}" 无 service 维度，但本条带 services——服务级规则不覆盖无服务请求，该 action 永不匹配` });
				} else if (services === undefined && serviceBound.includes(action)) {
					out.push({ level: "warn", where, message: `action "${action}" 需要 service 维度，但本条未声明 services——永不匹配（请加 services 白名单）` });
				}
			}
		}
		if (granting && active) {
			grantingActive++;
			if (raw.services === undefined && raw.actions === undefined) {
				out.push({ level: "warn", where, message: `全权规则：覆盖 ${String(raw.host)} 上全部动作（含 shell/file-write/kb-*）——建议收窄到 services 或 actions` });
			} else if (actions?.includes("shell")) {
				out.push({ level: "warn", where, message: `actions 含 "shell"：等价于授予该主机上 omo 进程用户的全部权限（第②层只是绊线）——无人值守建议改用 service/docker/k8s 动作级授权` });
			}
		}
		const sig = JSON.stringify({ h: raw.host, s: services, a: actions, p: raw.production === true });
		const dup = seen.get(sig);
		if (dup !== undefined) out.push({ level: "info", where, message: `与 targets[${dup}] 重复（同 host/services/actions/production）` });
		else seen.set(sig, i);
	});
	if (grantingActive === 0) out.push({ level: "info", where: "targets", message: "当前没有生效的放行规则——变更类操作全拒（仅令牌可放行）" });
	return out;
}

/** approval-token.json 全文检查；text=undefined 表示文件不存在 */
export function lintTokenSource(text: string | undefined, opts: LintOptions = {}): LintFinding[] {
	const out: LintFinding[] = [];
	const parsed = parseJson(text, "(file)", { level: "info", where: "(file)", message: "approval-token.json 不存在——无批准令牌（正常：按需签发）" }, out);
	if (parsed === undefined) return out;
	if (!isRecord(parsed) || (parsed.tokens !== undefined && !Array.isArray(parsed.tokens))) {
		out.push({ level: "error", where: "(file)", message: "根节点须为 { tokens: [...] }——运行时视为空库" });
		return out;
	}
	((parsed.tokens ?? []) as readonly unknown[]).forEach((raw, i) => {
		const where = `tokens[${i}]`;
		if (!isRecord(raw)) {
			out.push({ level: "error", where, message: "令牌须为对象" });
			return;
		}
		for (const key of Object.keys(raw)) {
			if (!TOKEN_KEYS.has(key) && !key.startsWith("$")) out.push({ level: "warn", where, message: `未知字段 "${key}" 被忽略` });
		}
		for (const key of ["id", "scope", "issuedBy", "issuedAt"]) {
			if (typeof raw[key] !== "string" || raw[key] === "") out.push({ level: "error", where, message: `${key} 缺失或非字符串` });
		}
		if (typeof raw.scope === "string" && raw.scope !== "") {
			const segs = raw.scope.split("/");
			if (segs.length > 3 || segs.some((s) => s === "")) out.push({ level: "error", where, message: `scope "${raw.scope}" 非法——须为 host[/service[/action]]，段不可为空` });
			else checkHost(segs[0], where, out);
			if (segs.length === 1) out.push({ level: "warn", where, message: `scope "${raw.scope}" 覆盖该主机全部操作——建议精确到 service/action` });
		}
		if (raw.consumedAt !== undefined) {
			out.push({ level: "info", where, message: `已消费（${String(raw.consumedAt)}），不再生效` });
			return;
		}
		const active = checkExpiry(raw.expiresAt, where, "令牌", opts, out);
		if (raw.expiresAt === undefined) out.push({ level: "warn", where, message: "未设 expiresAt——令牌永不过期，直到被消费（建议签发时设置到期时间）" });
		if (active) out.push({ level: "info", where, message: `有效：scope=${String(raw.scope)} issuedBy=${String(raw.issuedBy)}` });
	});
	return out;
}

/** 汇总计数（供 CLI 退出码与摘要行） */
export function summarizeLint(findings: readonly LintFinding[]): { errors: number; warns: number; infos: number } {
	let errors = 0, warns = 0, infos = 0;
	for (const f of findings) {
		if (f.level === "error") errors++;
		else if (f.level === "warn") warns++;
		else infos++;
	}
	return { errors, warns, infos };
}
