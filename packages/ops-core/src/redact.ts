import * as fs from "node:fs";
import * as path from "node:path";

/**
 * redact —— 模型厂商边界**双向脱敏**引擎（纯逻辑，无宿主依赖）
 *
 * 移植自 `omp-redact-extension.js`（其本身移植自 dsh-redact），保持语义 1:1：
 *   - 出站：把即将发给模型厂商的 payload 深遍历掩码成占位符 [[CODE_n]]；
 *   - 入站：工具调用参数里的占位符还原为真实值（工具以真实值执行）；
 *   - 助手文本流中的占位符保持原样（宿主无流拦截点，安全方向退化——见 README「已知边界」）。
 *
 * 设计要点（勿轻改）：
 *   - **同一真实值全程同一占位符**（forward 记账），保证模型看到的一致性；
 *   - 匹配**按优先级取先到者**（overlap 直接丢弃后到 span），因此规则排序决定语义；
 *   - 只对命中 span 做替换，**惰性克隆**（未变更的子树按原引用返回，避免无谓分配）；
 *   - 账本按会话分账（TTL 7 天 / 上限 200 会话），落盘原子写 + 0600。
 */

/* ─────────────── 占位符与还原 ─────────────── */

const PLACEHOLDER_RE = /\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]/g;
/** 非全局副本：g 标志的 test() 有 lastIndex 状态，跨调用串值 */
const PLACEHOLDER_FORM = /\[\[[A-Z][A-Z0-9]{0,23}_\d{1,10}\]\]/;

export function isPlaceholderShape(text: string): boolean {
	return /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.test(text);
}

export interface MaskMap {
	forward: Map<string, string>;
	reverse: Map<string, string>;
	counters: Map<string, number>;
}

export function createMaskMap(): MaskMap {
	return { forward: new Map(), reverse: new Map(), counters: new Map() };
}

/** 占位符 → 真实值还原；未知的同形字面量原样保留。 */
export function restoreText(text: string, reverse: ReadonlyMap<string, string>): string {
	if (!text.includes("[[")) return text;
	return text.replace(PLACEHOLDER_RE, (placeholder) => reverse.get(placeholder) ?? placeholder);
}

/* ─────────────── 规则引擎 ─────────────── */

export const MAX_CUSTOM_RULES = 50;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_TERM_RULES = 100;
export const MAX_TERM_LENGTH = 64;
export const MAX_REPLACEMENT_LENGTH = 64;

export interface RedactRule {
	code: string;
	priority: number;
	regex: RegExp;
	/** 只脱敏捕获组（保留变量名/协议前缀可读性） */
	group?: number;
	validate?: (value: string) => boolean;
	/** 别名规则：直接替换为固定词，而非生成占位符 */
	replacement?: string;
}

/** 内置 SECRET 模式：group 指定只脱敏捕获组（保留变量名/协议前缀可读性）。 */
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; group?: number }> = [
	{ re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
	{ re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, group: 1 },
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
	{ re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|private[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
];

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = "10X98765432";

function plausibleDate(year: number, month: number, day: number): boolean {
	return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function validId18(id: string): boolean {
	for (let i = 0; i < 17; i++) {
		const c = id.charCodeAt(i) - 48;
		if (c < 0 || c > 9) return false;
	}
	if (!plausibleDate(Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14)))) return false;
	let sum = 0;
	for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i]!;
	return ID_CHECK[sum % 11] === id[17]!.toUpperCase();
}

function validId15(id: string): boolean {
	return plausibleDate(1900 + Number(id.slice(6, 8)), Number(id.slice(8, 10)), Number(id.slice(10, 12)));
}

function luhn(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (d < 0 || d > 9) return false;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

function compileBuiltin(code: string, priority: number, patterns: ReadonlyArray<{ re: RegExp; group?: number }>, validate?: (v: string) => boolean): RedactRule[] {
	return patterns.map(({ re, group }) => ({
		code,
		priority,
		regex: re,
		...(validate !== undefined ? { validate } : {}),
		...(group !== undefined ? { group } : {}),
	}));
}

export interface RedactCategories {
	secret: boolean;
	id: boolean;
	bank: boolean;
	phone: boolean;
	email: boolean;
}

/** 内置五类编译（优先级：密钥1 > 证件2 > 银行卡3 > 手机4 > 邮箱5）。 */
export function builtinRules(enabled: RedactCategories): RedactRule[] {
	const rules: RedactRule[] = [];
	if (enabled.secret) rules.push(...compileBuiltin("SECRET", 1, SECRET_PATTERNS));
	if (enabled.id) {
		rules.push(
			{ code: "ID", priority: 2, regex: /(?<!\d)\d{17}[\dXx](?!\d)/g, validate: validId18 },
			{ code: "ID", priority: 2, regex: /(?<!\d)\d{15}(?!\d)/g, validate: validId15 },
		);
	}
	if (enabled.bank) rules.push({ code: "BANK", priority: 3, regex: /(?<!\d)\d{13,19}(?!\d)/g, validate: luhn });
	if (enabled.phone) rules.push({ code: "TEL", priority: 4, regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g });
	if (enabled.email) rules.push({ code: "EMAIL", priority: 5, regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g });
	return rules;
}

export function customRuleCode(name: string): string {
	const ascii = (name.match(/[A-Za-z0-9]+/g) ?? []).join("").toUpperCase();
	return (ascii === "" ? "RULE" : ascii).slice(0, 20);
}

export interface CustomRuleInput {
	name?: unknown;
	pattern?: unknown;
}

export function compileCustomRules(rules: unknown): { rules: RedactRule[]; errors: string[] } {
	const out: RedactRule[] = [];
	const errors: string[] = [];
	const seenCodes = new Map<string, number>();
	const list = Array.isArray(rules) ? (rules as CustomRuleInput[]) : [];
	for (let i = 0; i < list.length && i < MAX_CUSTOM_RULES; i++) {
		const rule = list[i];
		const name = String(rule?.name ?? "").trim();
		const pattern = String(rule?.pattern ?? "");
		if (name === "" || pattern === "") {
			errors.push(`自定义规则 #${i + 1}：名称与正则均不能为空`);
			continue;
		}
		if (pattern.length > MAX_PATTERN_LENGTH) {
			errors.push(`自定义规则「${name}」：正则超过 ${MAX_PATTERN_LENGTH} 字符上限`);
			continue;
		}
		try {
			const regex = new RegExp(pattern, "g");
			let code = customRuleCode(name);
			const n = (seenCodes.get(code) ?? 0) + 1;
			seenCodes.set(code, n);
			if (n > 1) code = `${code}${n}`;
			out.push({ code, priority: 6 + i, regex });
		} catch (error) {
			errors.push(`自定义规则「${name}」：正则非法（${error instanceof Error ? error.message : String(error)}）`);
		}
	}
	if (list.length > MAX_CUSTOM_RULES) errors.push(`自定义规则超过 ${MAX_CUSTOM_RULES} 条上限，多余条目已忽略`);
	return { rules: out, errors };
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERM_PRIORITY_BASE = 1000;

export function compileTermRules(rules: unknown): { rules: RedactRule[]; errors: string[] } {
	const out: RedactRule[] = [];
	const errors: string[] = [];
	const seenTerms = new Set<string>();
	const list = Array.isArray(rules) ? (rules as Array<{ term?: unknown; replacement?: unknown }>) : [];
	const cleaned = list.map((rule) => ({ term: String(rule?.term ?? "").trim(), replacement: String(rule?.replacement ?? "").trim() }));
	if (cleaned.length > MAX_TERM_RULES) errors.push(`别名规则超过 ${MAX_TERM_RULES} 条上限，多余条目已忽略`);
	for (let i = 0; i < cleaned.length && i < MAX_TERM_RULES; i++) {
		const { term, replacement } = cleaned[i]!;
		if (term === "" || replacement === "") {
			errors.push(`别名规则 #${i + 1}：原词与替换词均不能为空`);
			continue;
		}
		if (term.length > MAX_TERM_LENGTH) {
			errors.push(`别名规则 #${i + 1}：原词超过 ${MAX_TERM_LENGTH} 字符上限`);
			continue;
		}
		if (replacement.length > MAX_REPLACEMENT_LENGTH) {
			errors.push(`别名规则 #${i + 1}：替换词超过 ${MAX_REPLACEMENT_LENGTH} 字符上限`);
			continue;
		}
		if (term === replacement) {
			errors.push(`别名规则 #${i + 1}：原词与替换词相同（无意义）`);
			continue;
		}
		if (PLACEHOLDER_FORM.test(term) || PLACEHOLDER_FORM.test(replacement)) {
			errors.push(`别名规则 #${i + 1}：原词/替换词不能是占位符形态 [[CODE_N]]`);
			continue;
		}
		if (seenTerms.has(term)) {
			errors.push(`别名规则 #${i + 1}：原词「${term}」重复（保留先定义的替换）`);
			continue;
		}
		seenTerms.add(term);
		out.push({ code: "ALIAS", priority: TERM_PRIORITY_BASE + out.length, regex: new RegExp(escapeRegExp(term), "g"), replacement });
	}
	out.sort((a, b) => b.regex.source.length - a.regex.source.length);
	return { rules: out, errors };
}

/* ─────────────── 匹配收集与替换 ─────────────── */

interface Span {
	start: number;
	end: number;
	value: string;
	code: string;
	replacement?: string;
	placeholder?: string;
}

function collectSpans(text: string, rules: readonly RedactRule[]): Span[] {
	const accepted: Span[] = [];
	for (const rule of rules) {
		regexScan(text, rule, (start, end, value) => {
			for (const span of accepted) {
				if (start < span.end && span.start < end) return; // 重叠：先到者胜（规则已按优先级排序）
			}
			accepted.push({ start, end, value, code: rule.code, ...(rule.replacement !== undefined ? { replacement: rule.replacement } : {}) });
		});
	}
	return accepted;
}

function regexScan(text: string, rule: RedactRule, emit: (start: number, end: number, value: string) => void): void {
	const needsIndices = rule.group !== undefined && rule.group > 0;
	const flags = needsIndices ? `${rule.regex.flags}d` : rule.regex.flags;
	const re = needsIndices ? new RegExp(rule.regex.source, flags) : rule.regex;
	re.lastIndex = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		if (needsIndices) {
			const indices = (m as unknown as { indices?: Array<[number, number] | undefined> }).indices;
			const index = indices?.[rule.group!];
			if (index === undefined || index[1] - index[0] === 0) continue;
			const value = text.slice(index[0], index[1]);
			if (rule.validate !== undefined && !rule.validate(value)) continue;
			emit(index[0], index[1], value);
		} else {
			if (rule.validate !== undefined && !rule.validate(m[0])) continue;
			emit(m.index, m.index + m[0].length, m[0]);
		}
	}
}

function assignPlaceholder(map: MaskMap, code: string, value: string): string {
	const existing = map.forward.get(value);
	if (existing !== undefined) return existing;
	const n = (map.counters.get(code) ?? 0) + 1;
	map.counters.set(code, n);
	const placeholder = `[[${code}_${n}]]`;
	map.forward.set(value, placeholder);
	map.reverse.set(placeholder, value);
	return placeholder;
}

export interface MaskHit {
	code: string;
	value: string;
}

/** 对一段文本脱敏；map 记账保证同一值全程同一占位符；尾向头替换保证偏移不失效。 */
export function maskText(text: string, rules: readonly RedactRule[], map: MaskMap): { text: string; hits: MaskHit[] } {
	const spans = collectSpans(text, rules);
	if (spans.length === 0) return { text, hits: [] };
	const hits = spans.map((span) => ({ code: span.code, value: span.value }));
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		if (span.replacement !== undefined) {
			span.placeholder = span.replacement;
			const existing = map.reverse.get(span.replacement);
			// 别名：同名替换词保留**更长**的原值（避免短词把长词挤掉）
			if (existing === undefined || span.value.length > existing.length) map.reverse.set(span.replacement, span.value);
		} else {
			span.placeholder = assignPlaceholder(map, span.code, span.value);
		}
	}
	spans.sort((a, b) => b.start - a.start);
	let out = text;
	for (const span of spans) out = out.slice(0, span.start) + span.placeholder! + out.slice(span.end);
	return { text: out, hits };
}

/* ─────────────── 映射账本（按会话分账） ─────────────── */

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const MAX_SESSIONS = 200;

export interface PersistedState {
	version: 1;
	maps: { sessions: Record<string, { lastActive: number; reverse: Record<string, string> }> };
}

export class MappingStore {
	readonly sessions = new Map<string, { map: MaskMap; lastActive: number }>();

	sessionMap(sessionId: string, now: number): MaskMap {
		let entry = this.sessions.get(sessionId);
		if (entry === undefined) {
			entry = { map: createMaskMap(), lastActive: now };
			this.sessions.set(sessionId, entry);
		}
		entry.lastActive = now;
		return entry.map;
	}

	sessionCount(): number {
		return this.sessions.size;
	}

	prune(now: number, ttlMs: number = SESSION_TTL_MS, maxSessions: number = MAX_SESSIONS): number {
		let removed = 0;
		for (const [id, entry] of this.sessions) {
			if (now - entry.lastActive > ttlMs) {
				this.sessions.delete(id);
				removed++;
			}
		}
		if (this.sessions.size > maxSessions) {
			const ordered = [...this.sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
			const excess = this.sessions.size - maxSessions;
			for (let i = 0; i < excess; i++) {
				this.sessions.delete(ordered[i]![0]);
				removed++;
			}
		}
		return removed;
	}

	toPersistable(): PersistedState["maps"] {
		const sessions: PersistedState["maps"]["sessions"] = {};
		for (const [id, entry] of this.sessions) {
			const reverse: Record<string, string> = {};
			for (const [placeholder, value] of entry.map.reverse) reverse[placeholder] = value;
			sessions[id] = { lastActive: entry.lastActive, reverse };
		}
		return { sessions };
	}

	loadPersistable(data: PersistedState["maps"], now: number): void {
		this.sessions.clear();
		for (const [id, saved] of Object.entries(data.sessions ?? {})) {
			if (saved === null || typeof saved !== "object") continue;
			const map = createMaskMap();
			const maxByCode = new Map<string, number>();
			for (const [placeholder, value] of Object.entries(saved.reverse ?? {})) {
				if (typeof placeholder !== "string" || typeof value !== "string") continue;
				if (!isPlaceholderShape(placeholder) || value === "") continue;
				map.reverse.set(placeholder, value);
				map.forward.set(value, placeholder);
				const m = /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.exec(placeholder);
				if (m !== null) {
					const seen = maxByCode.get(m[1]!) ?? 0;
					if (Number(m[2]) > seen) maxByCode.set(m[1]!, Number(m[2]));
				}
			}
			for (const [code, max] of maxByCode) map.counters.set(code, max);
			this.sessions.set(id, { map, lastActive: typeof saved.lastActive === "number" ? saved.lastActive : now });
		}
		this.prune(now);
	}
}

/* ─────────────── 深遍历：出站掩码 / 入站还原 ─────────────── */

/** 深遍历掩码：返回 { value, changed, hits }。value 为掩码后结构（惰性克隆）。 */
export function maskDeep(value: unknown, rules: readonly RedactRule[], map: MaskMap): { value: unknown; changed: boolean; hits: MaskHit[] } {
	let changed = false;
	const hits: MaskHit[] = [];
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const r = maskText(v, rules, map);
			if (r.hits.length > 0) {
				changed = true;
				hits.push(...r.hits);
			}
			return r.text;
		}
		if (Array.isArray(v)) {
			const out = new Array(v.length);
			let cloned = false;
			for (let i = 0; i < v.length; i++) {
				out[i] = walk(v[i]);
				if (out[i] !== v[i]) cloned = true;
			}
			return cloned ? out : v;
		}
		if (v !== null && typeof v === "object") {
			const out: Record<string, unknown> = {};
			let cloned = false;
			for (const key of Object.keys(v as Record<string, unknown>)) {
				out[key] = walk((v as Record<string, unknown>)[key]);
				if (out[key] !== (v as Record<string, unknown>)[key]) cloned = true;
			}
			return cloned ? out : v;
		}
		return v;
	};
	const result = walk(value);
	return { value: result, changed, hits };
}

/** 深遍历还原（占位符 + 别名）：返回 { value, changed }。 */
export function restoreDeep(value: unknown, reverse: ReadonlyMap<string, string>, aliasEntries?: ReadonlyArray<{ key: string; value: string }>): { value: unknown; changed: boolean } {
	let changed = false;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const out = restoreAll(v, reverse, aliasEntries);
			if (out !== v) {
				changed = true;
				return out;
			}
			return v;
		}
		if (Array.isArray(v)) {
			const out = new Array(v.length);
			let cloned = false;
			for (let i = 0; i < v.length; i++) {
				out[i] = walk(v[i]);
				if (out[i] !== v[i]) cloned = true;
			}
			return cloned ? out : v;
		}
		if (v !== null && typeof v === "object") {
			const out: Record<string, unknown> = {};
			let cloned = false;
			for (const key of Object.keys(v as Record<string, unknown>)) {
				out[key] = walk((v as Record<string, unknown>)[key]);
				if (out[key] !== (v as Record<string, unknown>)[key]) cloned = true;
			}
			return cloned ? out : v;
		}
		return v;
	};
	const result = walk(value);
	return { value: result, changed };
}

/** 完整还原：占位符 + 别名（aliasEntries 缺省时仅占位符）。 */
export function restoreAll(text: string, reverse: ReadonlyMap<string, string>, aliasEntries?: ReadonlyArray<{ key: string; value: string }>): string {
	let out = restoreText(text, reverse);
	if (aliasEntries !== undefined) {
		for (const { key, value } of aliasEntries) out = out.split(key).join(value);
	}
	return out;
}

/** 从会话映射提取别名还原条目（replacement → term），键长降序。 */
export function extractAliasEntries(reverse: ReadonlyMap<string, string>): Array<{ key: string; value: string }> {
	const out: Array<{ key: string; value: string }> = [];
	for (const [key, value] of reverse) {
		if (key === "" || value === "" || isPlaceholderShape(key)) continue;
		out.push({ key, value });
	}
	return out.sort((a, b) => b.key.length - a.key.length);
}

/* ─────────────── 状态持久化（原子写 + 0600；IO 与纯逻辑同模块，保持与参考实现一致） ─────────────── */

export function loadStateSync(statePath: string): PersistedState | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<PersistedState>;
		if (raw === null || typeof raw !== "object" || raw.version !== 1) return undefined;
		if (raw.maps === null || typeof raw.maps !== "object") return undefined;
		return raw as PersistedState;
	} catch {
		return undefined; // 文件不存在或损坏：全新状态
	}
}

/** 原子写（临时文件 + rename）。失败返回诊断，由调用方决定是否提示——库内不写 stderr。 */
export function saveStateSync(statePath: string, state: PersistedState): { ok: boolean; error?: string } {
	try {
		fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
		const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tmp, statePath);
		try {
			fs.chmodSync(statePath, 0o600);
		} catch {
			/* chmod 失败不致命（umask 已尽量收紧） */
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/* ─────────────── 配置 ─────────────── */

export interface RedactConfigFile {
	enabled?: boolean;
	restore?: boolean;
	categories?: Partial<RedactCategories>;
	customRules?: unknown;
	aliases?: unknown;
}

export interface RedactConfig {
	enabled: boolean;
	restore: boolean;
	categories: RedactCategories;
	rules: RedactRule[];
	warnings: string[];
}

/** 配置装载的中间形态（IO 由调用方负责；`finalizeConfig` 编译为 RedactConfig） */
export interface RedactConfigInput {
	enabled: boolean;
	restore: boolean;
	categories: RedactCategories;
	customRules: unknown[];
	aliases: unknown[];
}

export function defaultConfig(): RedactConfigInput {
	return {
		enabled: true,
		restore: true,
		categories: { secret: true, id: true, bank: true, phone: true, email: true },
		customRules: [],
		aliases: [],
	};
}

export function finalizeConfig(cfg: RedactConfigInput, warnings: string[]): RedactConfig {
	const custom = compileCustomRules(cfg.customRules);
	const terms = compileTermRules(cfg.aliases);
	const rules = [...builtinRules(cfg.categories), ...custom.rules, ...terms.rules].sort((a, b) => a.priority - b.priority);
	return {
		enabled: cfg.enabled,
		restore: cfg.restore,
		categories: cfg.categories,
		rules,
		warnings: [...warnings, ...custom.errors, ...terms.errors],
	};
}

/** 从已解析的配置对象构建（IO 由调用方负责，便于测试与宿主适配）。 */
export function configFromRaw(raw: unknown): RedactConfig {
	const cfg = defaultConfig();
	if (raw === null || typeof raw !== "object") return finalizeConfig(cfg, []);
	const r = raw as RedactConfigFile;
	try {
		if (typeof r.enabled === "boolean") cfg.enabled = r.enabled;
		if (typeof r.restore === "boolean") cfg.restore = r.restore;
		if (r.categories !== null && typeof r.categories === "object") {
			for (const key of Object.keys(cfg.categories) as Array<keyof RedactCategories>) {
				const v = (r.categories as Record<string, unknown>)[key];
				if (typeof v === "boolean") cfg.categories[key] = v;
			}
		}
		if (Array.isArray(r.customRules)) cfg.customRules = r.customRules;
		if (Array.isArray(r.aliases)) cfg.aliases = r.aliases;
	} catch {
		return finalizeConfig(defaultConfig(), ["配置解析异常，已使用缺省配置"]);
	}
	const warnings: string[] = [];
	if (!Array.isArray(r.customRules) && r.customRules !== undefined) warnings.push("customRules 需为数组");
	if (!Array.isArray(r.aliases) && r.aliases !== undefined) warnings.push("aliases 需为数组");
	return finalizeConfig(cfg, warnings);
}
