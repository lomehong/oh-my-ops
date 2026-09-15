import * as fs from "node:fs";
import { READ, criticalReason, evaluateAuthorization, lintPolicySource, lintTokenSource, summarizeLint, traceRules, traceTokens } from "@ops-pi/core";
import type { ApprovalToken, AuthorizationVerdict, LintFinding, PolicyRequest, RuleTrace, TargetPolicy, TargetRule, Tier, TokenStore, TokenTrace } from "@ops-pi/core";
import { TIER_TABLE, tierFor } from "./approvals.ts";
import { POLICY_ACTIONS, policyRequestFor } from "./request.ts";

/**
 * 授权 dry-run（explain）与策略静态检查（lint）——Owner 侧可见性工具。
 * explain 复用与 ①-a/①-b/③ 完全相同的 policyRequestFor + evaluateAuthorization 单一事实源，
 * 只读：不消费令牌、不执行工具、不写审计以外的任何状态。
 */

/** 授权判定所需的最小只读视图（OpsContext 满足；测试可用内存实现） */
export interface ExplainView {
	targetPolicy: TargetPolicy & { readonly rules: readonly TargetRule[] };
	tokens: TokenStore & { list(): readonly ApprovalToken[] };
}

export interface ExplainReport {
	tool: string;
	registered: boolean;
	tier?: Tier;
	input: Record<string, string>;
	/** 第②层：入参含 command 时的内容硬拒原因（null = 未命中） */
	contentGuard?: string | null;
	request?: PolicyRequest;
	requestError?: string;
	verdict?: AuthorizationVerdict;
	rules: RuleTrace[];
	tokens: TokenTrace[];
}

export type ParsedExplainArgs = { ok: true; tool: string; input: Record<string, string> } | { ok: false; reason: string };

/** 按空白切词；单/双引号内的空白不切分（`command="ls -la"` → `command=ls -la`），引号可出现在词中任意位置 */
function tokenize(src: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (const ch of src) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (has) out.push(cur);
			cur = "";
			has = false;
			continue;
		}
		cur += ch;
		has = true;
	}
	if (has) out.push(cur);
	return out;
}

/** 解析 `<tool> key=value key="quoted value" …` */
export function parseExplainArgs(raw: string): ParsedExplainArgs {
	const tokens = tokenize(raw);
	const tool = tokens.shift();
	if (tool === undefined || tool === "") return { ok: false, reason: "用法：explain <ops_工具名> [key=value …]（如 explain ops_service service=nginx action=restart）" };
	if (!tool.startsWith("ops_")) return { ok: false, reason: `工具名须以 ops_ 开头：${tool}` };
	const input: Record<string, string> = {};
	for (const t of tokens) {
		const eq = t.indexOf("=");
		if (eq <= 0) return { ok: false, reason: `参数须为 key=value 形式：${t}` };
		input[t.slice(0, eq)] = t.slice(eq + 1);
	}
	return { ok: true, tool, input };
}

export function explainAuthorization(view: ExplainView, tool: string, input: Record<string, string>, now: number = Date.now()): ExplainReport {
	const report: ExplainReport = { tool, registered: tool in TIER_TABLE, input, rules: [], tokens: [] };
	if (!report.registered) return report;
	report.tier = tierFor(tool, input);
	const command = input.command ?? input.script;
	if (command !== undefined) report.contentGuard = criticalReason(command);
	try {
		report.request = policyRequestFor(tool, input);
	} catch (error) {
		report.requestError = error instanceof Error ? error.message : String(error);
		return report;
	}
	report.rules = traceRules(view.targetPolicy.rules, report.request, now);
	report.tokens = traceTokens(view.tokens.list(), report.request, now);
	if (report.tier !== READ) report.verdict = evaluateAuthorization(view.targetPolicy, view.tokens, report.request);
	return report;
}

function describeRule(rule: TargetRule): string {
	const parts = [rule.host];
	if (rule.services) parts.push(`services=[${rule.services.join(",")}]`);
	if (rule.actions) parts.push(`actions=[${rule.actions.join(",")}]`);
	if (rule.production === true) parts.push("production");
	if (rule.expiresAt) parts.push(`expiresAt=${rule.expiresAt}`);
	return parts.join(" ");
}

function describeRequest(request: PolicyRequest): string {
	return [request.host, request.service, request.action].filter((x) => x !== undefined).join("/") || "(空请求)";
}

export function formatExplain(r: ExplainReport): string {
	const lines: string[] = [`explain ${r.tool} ${Object.entries(r.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`.trim()];
	if (!r.registered) {
		lines.push(`✗ 未登记工具（不在 TIER_TABLE）——运行时按最严档（exec）处理且 policyRequestFor 会 fail-fast`);
		return lines.join("\n");
	}
	lines.push(`档位：${r.tier}${r.tier === READ ? "（read 档免授权，宿主自动放行；PathGuard 仍生效）" : ""}`);
	if (r.contentGuard !== undefined) {
		lines.push(r.contentGuard === null ? "② 内容硬拒：未命中" : `② 内容硬拒：✗ 命中——${r.contentGuard}（任何授权都不能放行）`);
	}
	if (r.requestError !== undefined) {
		lines.push(`✗ 入参映射失败：${r.requestError}`);
		return lines.join("\n");
	}
	if (r.request !== undefined) lines.push(`策略请求：${describeRequest(r.request)}`);
	if (r.tier === READ) return lines.join("\n");

	const v = r.verdict;
	if (v !== undefined) {
		if (v.allowed) lines.push(`结论：✓ 放行（来源 ${v.source}${v.tokenId ? `，令牌 ${v.tokenId}` : ""}）`);
		else lines.push(`结论：✗ 拒绝（${v.reason}）${v.reason === "guard-production" ? "——生产目标，仅 Owner 批准令牌可放行" : "——无预授权规则/令牌命中；交互模式下交平台审批，无人值守下 ①-b 拒绝"}`);
	}
	if (r.contentGuard) lines.push("（内容硬拒优先于上述结论：实际结果 = 拒绝）");
	lines.push(`规则轨迹（${r.rules.length} 条）：`);
	if (r.rules.length === 0) lines.push("  （无规则：policy.json 缺失/损坏/为空）");
	for (const t of r.rules) {
		const mark = t.covers ? "✓ 放行" : t.marks ? "● 生产标记" : `· 不覆盖（${t.failedOn}）`;
		lines.push(`  [${t.index}] ${mark}  ${describeRule(t.rule)}${!t.active ? "  ⚠ 已过期" : ""}`);
	}
	lines.push(`令牌轨迹（${r.tokens.length} 枚）：`);
	if (r.tokens.length === 0) lines.push("  （无令牌）");
	for (const t of r.tokens) {
		const mark = t.covers && t.active ? "✓ 命中" : t.covers ? `· 覆盖但不生效（${t.inactiveReason}）` : "· scope 不覆盖";
		lines.push(`  ${t.token.id} ${mark}  scope=${t.token.scope}${t.token.expiresAt ? ` expiresAt=${t.token.expiresAt}` : ""}`);
	}
	lines.push("（dry-run：不消费令牌、不执行；不含 PathGuard 与远程 host 可达性判定）");
	return lines.join("\n");
}

// ── lint：读文件 → core 纯函数检查 → 报告 ──

export interface LintReport {
	policyPath: string;
	tokenPath: string;
	policy: LintFinding[];
	tokens: LintFinding[];
	summary: { errors: number; warns: number; infos: number };
}

function readOptional(path: string): string | undefined {
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function runPolicyLint(policyPath: string, tokenPath: string, now: number = Date.now()): LintReport {
	const policy = lintPolicySource(readOptional(policyPath), { now, actions: POLICY_ACTIONS });
	const tokens = lintTokenSource(readOptional(tokenPath), { now });
	return { policyPath, tokenPath, policy, tokens, summary: summarizeLint([...policy, ...tokens]) };
}

const LEVEL_MARK: Record<LintFinding["level"], string> = { error: "✗", warn: "⚠", info: "·" };

export function formatLint(r: LintReport): string {
	const lines: string[] = [];
	const section = (title: string, findings: readonly LintFinding[]) => {
		lines.push(title);
		if (findings.length === 0) lines.push("  ✓ 无发现");
		for (const f of findings) lines.push(`  ${LEVEL_MARK[f.level]} ${f.where}: ${f.message}`);
	};
	section(`policy：${r.policyPath}`, r.policy);
	section(`令牌：${r.tokenPath}`, r.tokens);
	const { errors, warns, infos } = r.summary;
	lines.push(`合计：${errors} 错误 / ${warns} 警告 / ${infos} 提示${errors > 0 ? "——错误项在运行时会被静默降级为「全拒/失效」，请修正" : ""}`);
	return lines.join("\n");
}
