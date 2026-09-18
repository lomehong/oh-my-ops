// omp-redact-extension.js · 模型厂商边界双向脱敏扩展
//
// 移植自 dsh-redact（挂点从 dsh llm/stream waterfall 换为 omp 扩展事件）：
//   出站  pi.on("before_provider_request") → payload 深遍历掩码，返回替换 payload
//   入站  pi.on("tool_call")               → 参数占位符还原，返回 {input}（工具以真实值执行，
//                                          修订经 omp 契约持久化到会话历史——本机原文保留）
// 厂商永远收不到真实敏感值；本机工具执行全程真实值；助手文本流中的占位符保持原样
// （omp 无流拦截点，安全方向退化——README「已知边界」）。
//
// 配置：$HOME/.omp/redact/config.json（可选；缺省 = 全内置规则启用 + 还原开启）
// 状态：$HOME/.omp/redact/state.json（映射账本，0600，原子写）
// 调试：OMP_REDACT_DEBUG=1 时按请求追加 $HOME/.omp/redact/debug.log

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ─────────────── 占位符与还原 ─────────────── */

const PLACEHOLDER_RE = /\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]/g;
// 非全局副本：g 标志的 test() 有 lastIndex 状态，跨调用串值
const PLACEHOLDER_FORM = /\[\[[A-Z][A-Z0-9]{0,23}_\d{1,10}\]\]/;

export function isPlaceholderShape(text) {
  return /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.test(text);
}

export function createMaskMap() {
  return { forward: new Map(), reverse: new Map(), counters: new Map() };
}

/** 占位符 → 真实值还原；未知的同形字面量原样保留。 */
export function restoreText(text, reverse) {
  if (!text.includes("[[")) return text;
  return text.replace(PLACEHOLDER_RE, (placeholder) => reverse.get(placeholder) ?? placeholder);
}

/* ─────────────── 规则引擎（移植 dsh-redact rules.ts） ─────────────── */

export const MAX_CUSTOM_RULES = 50;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_TERM_RULES = 100;
export const MAX_TERM_LENGTH = 64;
export const MAX_REPLACEMENT_LENGTH = 64;

/** 内置 SECRET 模式：group 指定只脱敏捕获组（保留变量名/协议前缀可读性）。 */
const SECRET_PATTERNS = [
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

function plausibleDate(year, month, day) {
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function validId18(id) {
  for (let i = 0; i < 17; i++) {
    const c = id.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
  }
  if (!plausibleDate(Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14)))) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id[17].toUpperCase();
}

function validId15(id) {
  return plausibleDate(1900 + Number(id.slice(6, 8)), Number(id.slice(8, 10)), Number(id.slice(10, 12)));
}

function luhn(digits) {
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

function compileBuiltin(code, priority, patterns, validate) {
  return patterns.map(({ re, group }) => ({
    code,
    priority,
    regex: re,
    ...(validate !== undefined ? { validate } : {}),
    ...(group !== undefined ? { group } : {}),
  }));
}

/** 内置五类编译（优先级：密钥1 > 证件2 > 银行卡3 > 手机4 > 邮箱5）。 */
export function builtinRules(enabled) {
  const rules = [];
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

export function customRuleCode(name) {
  const ascii = (name.match(/[A-Za-z0-9]+/g) ?? []).join("").toUpperCase();
  return (ascii === "" ? "RULE" : ascii).slice(0, 20);
}

export function compileCustomRules(rules) {
  const out = [];
  const errors = [];
  const seenCodes = new Map();
  for (let i = 0; i < rules.length && i < MAX_CUSTOM_RULES; i++) {
    const rule = rules[i];
    const name = String(rule?.name ?? "").trim();
    const pattern = String(rule?.pattern ?? "");
    if (name === "" || pattern === "") { errors.push(`自定义规则 #${i + 1}：名称与正则均不能为空`); continue; }
    if (pattern.length > MAX_PATTERN_LENGTH) { errors.push(`自定义规则「${name}」：正则超过 ${MAX_PATTERN_LENGTH} 字符上限`); continue; }
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
  if (rules.length > MAX_CUSTOM_RULES) errors.push(`自定义规则超过 ${MAX_CUSTOM_RULES} 条上限，多余条目已忽略`);
  return { rules: out, errors };
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERM_PRIORITY_BASE = 1000;

export function compileTermRules(rules) {
  const out = [];
  const errors = [];
  const seenTerms = new Set();
  const list = Array.isArray(rules) ? rules : [];
  const cleaned = list.map((rule) => ({ term: String(rule?.term ?? "").trim(), replacement: String(rule?.replacement ?? "").trim() }));
  if (cleaned.length > MAX_TERM_RULES) errors.push(`别名规则超过 ${MAX_TERM_RULES} 条上限，多余条目已忽略`);
  for (let i = 0; i < cleaned.length && i < MAX_TERM_RULES; i++) {
    const { term, replacement } = cleaned[i];
    if (term === "" || replacement === "") { errors.push(`别名规则 #${i + 1}：原词与替换词均不能为空`); continue; }
    if (term.length > MAX_TERM_LENGTH) { errors.push(`别名规则 #${i + 1}：原词超过 ${MAX_TERM_LENGTH} 字符上限`); continue; }
    if (replacement.length > MAX_REPLACEMENT_LENGTH) { errors.push(`别名规则 #${i + 1}：替换词超过 ${MAX_REPLACEMENT_LENGTH} 字符上限`); continue; }
    if (term === replacement) { errors.push(`别名规则 #${i + 1}：原词与替换词相同（无意义）`); continue; }
    if (PLACEHOLDER_FORM.test(term) || PLACEHOLDER_FORM.test(replacement)) { errors.push(`别名规则 #${i + 1}：原词/替换词不能是占位符形态 [[CODE_N]]`); continue; }
    if (seenTerms.has(term)) { errors.push(`别名规则 #${i + 1}：原词「${term}」重复（保留先定义的替换）`); continue; }
    seenTerms.add(term);
    out.push({ code: "ALIAS", priority: TERM_PRIORITY_BASE + out.length, regex: new RegExp(escapeRegExp(term), "g"), replacement });
  }
  out.sort((a, b) => b.regex.source.length - a.regex.source.length);
  return { rules: out, errors };
}

/* ─────────────── 匹配收集与替换 ─────────────── */

function collectSpans(text, rules) {
  const accepted = [];
  for (const rule of rules) {
    regexScan(text, rule, (start, end, value) => {
      for (const span of accepted) {
        if (start < span.end && span.start < end) return;
      }
      accepted.push({ start, end, value, code: rule.code, ...(rule.replacement !== undefined ? { replacement: rule.replacement } : {}) });
    });
  }
  return accepted;
}

function regexScan(text, rule, emit) {
  const needsIndices = rule.group !== undefined && rule.group > 0;
  const flags = needsIndices ? `${rule.regex.flags}d` : rule.regex.flags;
  const re = needsIndices ? new RegExp(rule.regex.source, flags) : rule.regex;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (needsIndices) {
      const index = m.indices?.[rule.group];
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

function assignPlaceholder(map, code, value) {
  const existing = map.forward.get(value);
  if (existing !== undefined) return existing;
  const n = (map.counters.get(code) ?? 0) + 1;
  map.counters.set(code, n);
  const placeholder = `[[${code}_${n}]]`;
  map.forward.set(value, placeholder);
  map.reverse.set(placeholder, value);
  return placeholder;
}

/** 对一段文本脱敏；map 记账保证同一值全程同一占位符；尾向头替换保证偏移不失效。 */
export function maskText(text, rules, map) {
  const spans = collectSpans(text, rules);
  if (spans.length === 0) return { text, hits: [] };
  const hits = spans.map((span) => ({ code: span.code, value: span.value }));
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.replacement !== undefined) {
      span.placeholder = span.replacement;
      const existing = map.reverse.get(span.replacement);
      if (existing === undefined || span.value.length > existing.length) map.reverse.set(span.replacement, span.value);
    } else {
      span.placeholder = assignPlaceholder(map, span.code, span.value);
    }
  }
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of spans) out = out.slice(0, span.start) + span.placeholder + out.slice(span.end);
  return { text: out, hits };
}

/* ─────────────── 映射账本（按会话分账） ─────────────── */

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const MAX_SESSIONS = 200;

export class MappingStore {
  constructor() {
    this.sessions = new Map();
  }

  sessionMap(sessionId, now) {
    let entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      entry = { map: createMaskMap(), lastActive: now };
      this.sessions.set(sessionId, entry);
    }
    entry.lastActive = now;
    return entry.map;
  }

  sessionCount() {
    return this.sessions.size;
  }

  prune(now, ttlMs = SESSION_TTL_MS, maxSessions = MAX_SESSIONS) {
    let removed = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActive > ttlMs) { this.sessions.delete(id); removed++; }
    }
    if (this.sessions.size > maxSessions) {
      const ordered = [...this.sessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
      const excess = this.sessions.size - maxSessions;
      for (let i = 0; i < excess; i++) { this.sessions.delete(ordered[i][0]); removed++; }
    }
    return removed;
  }

  toPersistable() {
    const sessions = {};
    for (const [id, entry] of this.sessions) {
      const reverse = {};
      for (const [placeholder, value] of entry.map.reverse) reverse[placeholder] = value;
      sessions[id] = { lastActive: entry.lastActive, reverse };
    }
    return { sessions };
  }

  loadPersistable(data, now) {
    this.sessions.clear();
    for (const [id, saved] of Object.entries(data.sessions ?? {})) {
      if (saved === null || typeof saved !== "object") continue;
      const map = createMaskMap();
      const maxByCode = new Map();
      for (const [placeholder, value] of Object.entries(saved.reverse ?? {})) {
        if (typeof placeholder !== "string" || typeof value !== "string") continue;
        if (!isPlaceholderShape(placeholder) || value === "") continue;
        map.reverse.set(placeholder, value);
        map.forward.set(value, placeholder);
        const m = /^\[\[([A-Z][A-Z0-9]{0,23})_(\d{1,10})\]\]$/.exec(placeholder);
        if (m !== null) {
          const seen = maxByCode.get(m[1]) ?? 0;
          if (Number(m[2]) > seen) maxByCode.set(m[1], Number(m[2]));
        }
      }
      for (const [code, max] of maxByCode) map.counters.set(code, max);
      this.sessions.set(id, { map, lastActive: typeof saved.lastActive === "number" ? saved.lastActive : now });
    }
    this.prune(now);
  }
}

/* ─────────────── 持久化（原子写 + 0600） ─────────────── */

export function redactHome() {
  return process.env.OMP_REDACT_HOME ?? process.env.HOME ?? os.homedir();
}

export function stateFilePath(home) {
  return path.join(home, ".omp", "redact", "state.json");
}

export function configFilePath(home) {
  return path.join(home, ".omp", "redact", "config.json");
}

export function loadStateSync(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (raw === null || typeof raw !== "object" || raw.version !== 1) return undefined;
    if (raw.maps === null || typeof raw.maps !== "object") return undefined;
    return raw;
  } catch {
    return undefined; // 文件不存在或损坏：全新状态
  }
}

export function saveStateSync(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, statePath);
    try { fs.chmodSync(statePath, 0o600); } catch {}
  } catch (error) {
    process.stderr.write(`[omp-redact] 状态落盘失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/* ─────────────── 配置加载（缺省 = 全内置启用 + 还原开） ─────────────── */

export function defaultConfig() {
  return {
    enabled: true,
    restore: true,
    categories: { secret: true, id: true, bank: true, phone: true, email: true },
    customRules: [],
    aliases: [],
  };
}

export function loadConfigSync(configPath) {
  const cfg = defaultConfig();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return finalizeConfig(cfg, []);
  }
  try {
    if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
    if (typeof raw.restore === "boolean") cfg.restore = raw.restore;
    if (raw.categories && typeof raw.categories === "object") {
      for (const key of Object.keys(cfg.categories)) {
        if (typeof raw.categories[key] === "boolean") cfg.categories[key] = raw.categories[key];
      }
    }
    if (Array.isArray(raw.customRules)) cfg.customRules = raw.customRules;
    if (Array.isArray(raw.aliases)) cfg.aliases = raw.aliases;
  } catch {
    process.stderr.write(`[omp-redact] 配置解析异常，使用缺省配置\n`);
    return finalizeConfig(defaultConfig(), []);
  }
  const warnings = [];
  if (!Array.isArray(raw.customRules) && raw.customRules !== undefined) warnings.push("customRules 需为数组");
  if (!Array.isArray(raw.aliases) && raw.aliases !== undefined) warnings.push("aliases 需为数组");
  return finalizeConfig(cfg, warnings);
}

function finalizeConfig(cfg, warnings) {
  const custom = compileCustomRules(cfg.customRules);
  const terms = compileTermRules(cfg.aliases);
  const rules = [
    ...builtinRules(cfg.categories),
    ...custom.rules,
    ...terms.rules,
  ].sort((a, b) => a.priority - b.priority);
  return {
    enabled: cfg.enabled,
    restore: cfg.restore,
    categories: cfg.categories,
    rules,
    warnings: [...warnings, ...custom.errors, ...terms.errors],
  };
}

/* ─────────────── 深遍历：出站掩码 / 入站还原 ─────────────── */

/** 深遍历掩码：返回 { value, changed, hits }。value 为掩码后结构（惰性克隆）。 */
export function maskDeep(value, rules, map) {
  let changed = false;
  const hits = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const r = maskText(v, rules, map);
      if (r.hits.length > 0) { changed = true; hits.push(...r.hits); }
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
      const out = {};
      let cloned = false;
      for (const key of Object.keys(v)) {
        out[key] = walk(v[key]);
        if (out[key] !== v[key]) cloned = true;
      }
      return cloned ? out : v;
    }
    return v;
  };
  const result = walk(value);
  return { value: result, changed, hits };
}

/** 深遍历还原（占位符 + 别名）：返回 { value, changed }。 */
export function restoreDeep(value, reverse, aliasEntries) {
  let changed = false;
  const walk = (v) => {
    if (typeof v === "string") {
      const out = restoreAll(v, reverse, aliasEntries);
      if (out !== v) { changed = true; return out; }
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
      const out = {};
      let cloned = false;
      for (const key of Object.keys(v)) {
        out[key] = walk(v[key]);
        if (out[key] !== v[key]) cloned = true;
      }
      return cloned ? out : v;
    }
    return v;
  };
  const result = walk(value);
  return { value: result, changed };
}

/** 完整还原：占位符 + 别名（aliasEntries 缺省时仅占位符）。 */
export function restoreAll(text, reverse, aliasEntries) {
  let out = restoreText(text, reverse);
  if (aliasEntries !== undefined) {
    for (const { key, value } of aliasEntries) out = out.split(key).join(value);
  }
  return out;
}

/** 从会话映射提取别名还原条目（replacement → term），键长降序。 */
export function extractAliasEntries(reverse) {
  const out = [];
  for (const [key, value] of reverse) {
    if (key === "" || value === "" || isPlaceholderShape(key)) continue;
    out.push({ key, value });
  }
  return out.sort((a, b) => b.key.length - a.key.length);
}

/* ─────────────── 扩展工厂 ─────────────── */

export default function (pi) {
  const home = redactHome();
  const dir = path.join(home, ".omp", "redact");
  const statePath = stateFilePath(home);
  const configPath = configFilePath(home);

  const cfg = loadConfigSync(configPath);
  for (const warning of cfg.warnings) process.stderr.write(`[omp-redact] ${warning}\n`);
  if (process.env.OMP_REDACT_DEBUG === "1") {
    process.stderr.write(`[omp-redact] 已加载（enabled=${cfg.enabled} restore=${cfg.restore} rules=${cfg.rules.length}）\n`);
  }

  const store = new MappingStore();
  const persisted = loadStateSync(statePath);
  if (persisted !== undefined) store.loadPersistable(persisted.maps, Date.now());

  let sessionId = "default";
  let dirty = false;
  let saveTimer = null;

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      saveStateSync(statePath, { version: 1, maps: store.toPersistable() });
    }, 500);
    if (typeof saveTimer.unref === "function") saveTimer.unref();
  }

  function debugLog(line) {
    if (process.env.OMP_REDACT_DEBUG !== "1") return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "debug.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {}
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      const candidate =
        ctx?.sessionManager?.sessionId ??
        ctx?.sessionId ??
        (typeof ctx?.sessionManager?.id === "string" ? ctx.sessionManager.id : undefined);
      if (typeof candidate === "string" && candidate !== "") sessionId = candidate;
    } catch {
      sessionId = "default";
    }
    store.sessionMap(sessionId, Date.now());
    scheduleSave();
  });

  // 出站：payload 深遍历掩码，返回替换 payload（no-op 时返回 undefined 零干预）
  pi.on("before_provider_request", (event) => {
    if (!cfg.enabled) return undefined;
    const map = store.sessionMap(sessionId, Date.now());
    const { value, changed, hits } = maskDeep(event.payload, cfg.rules, map);
    if (!changed) return undefined;
    const byCategory = {};
    for (const hit of hits) byCategory[hit.code] = (byCategory[hit.code] ?? 0) + 1;
    debugLog(`MASK session=${sessionId} ${JSON.stringify(byCategory)}`);
    scheduleSave();
    return value;
  });

  // 入站（功能性）：工具参数占位符还原；无占位符时 no-op（工具以原始参数执行）
  pi.on("tool_call", (event) => {
    if (!cfg.enabled || !cfg.restore) return undefined;
    const map = store.sessionMap(sessionId, Date.now());
    const aliasEntries = extractAliasEntries(map.reverse);
    if (map.reverse.size === 0 && aliasEntries.length === 0) return undefined;
    const { value, changed } = restoreDeep(event.input, map.reverse, aliasEntries);
    if (!changed) return undefined;
    debugLog(`RESTORE session=${sessionId} tool=${event.toolName}`);
    scheduleSave();
    return { input: value };
  });

  // 周期清理 + 落盘
  const timer = setInterval(() => {
    store.prune(Date.now());
    if (dirty) { dirty = false; saveStateSync(statePath, { version: 1, maps: store.toPersistable() }); }
  }, 60_000);
  if (typeof timer.unref === "function") timer.unref();
}
