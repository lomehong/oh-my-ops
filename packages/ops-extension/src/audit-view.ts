/**
 * `/ops-audit [n]` 读取面纯函数——参数解析、审计条目收窄、报告格式化。
 *
 * 设计依据：docs/designs/ops-audit-command-design.md（OPSAUDIT-2 已落定）；
 * 数据面事实：ops_audit 条目信封为 `{type:"custom", customType:"ops_audit", data:{…}}`
 * （探针 docs/reports/probes/v42-layer-audit-probe.ts:28-29 实测），三写入点均落 `data.ts`
 * ISO 字符串（hooks.ts:56/90-107、commands.ts:80/89）——排序唯一时间基准。
 *
 * 纪律：本模块零运行时上下文依赖（可单测）；字段缺失保持 undefined（呈现 `-`），
 * 不补默认语义（需求包 B3）；不注入 LLM 上下文（B9/D2）——本模块不与 pi API 交互。
 */

/** 单条审计条目的展示视图；`undefined` = 源数据缺失（呈现为 `-`，不臆造） */
export interface AuditView {
	ts: string | undefined;
	tool: string | undefined;
	authz: string | undefined;
	isError: boolean | undefined;
	reasonClass: string | undefined;
	host: string | undefined;
	reason: string | undefined;
}

export interface ParsedLimit {
	ok: true;
	n: number;
	truncated: boolean;
}

export interface ParseFailure {
	ok: false;
	reason: string;
}

/** T1 定案口径：n ∈ [1, 200]，默认 20 */
export const AUDIT_DEFAULT_LIMIT = 20;
export const AUDIT_LIMIT_MAX = 200;
/** T1 定案口径：reason 单条单行截断 160 字符 */
export const REASON_MAX_CHARS = 160;

const SCOPE_NOTE = "可读范围=当前会话分支 leaf 路径";

/** 参数解析（B4）：留空=默认 20；正整数=原样；`0/负数/小数/非数字`=明确错误；超 200=截断并标记 */
export function parseAuditLimit(raw: string | undefined): ParsedLimit | ParseFailure {
	const s = String(raw ?? "").trim();
	if (s === "") return { ok: true, n: AUDIT_DEFAULT_LIMIT, truncated: false };
	if (!/^\d+$/.test(s)) {
		return { ok: false, reason: `/ops-audit 参数须为正整数（1–${AUDIT_LIMIT_MAX}；收到「${s}」）；留空 = 默认 ${AUDIT_DEFAULT_LIMIT} 条` };
	}
	const n = Number(s);
	if (n < 1) return { ok: false, reason: `/ops-audit 参数须为正整数（1–${AUDIT_LIMIT_MAX}；收到「${s}」）；留空 = 默认 ${AUDIT_DEFAULT_LIMIT} 条` };
	if (n > AUDIT_LIMIT_MAX) return { ok: true, n: AUDIT_LIMIT_MAX, truncated: true };
	return { ok: true, n, truncated: false };
}

/** 审计条目判型：信封形状以代码实证为准（B2），非命中一律剔除 */
export function isAuditEntry(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return e.type === "custom" && e.customType === "ops_audit";
}

/** 收窄 `unknown[]` → `AuditView[]`：保序（排序职责在展示层）；字段缺失/类型不符 → undefined */
export function toAuditViews(entries: readonly unknown[]): AuditView[] {
	const views: AuditView[] = [];
	for (const entry of entries) {
		if (!isAuditEntry(entry)) continue;
		const raw = (entry as { data?: unknown }).data;
		const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		views.push({
			ts: typeof d.ts === "string" ? d.ts : undefined,
			tool: typeof d.tool === "string" ? d.tool : undefined,
			authz: typeof d.authz === "string" ? d.authz : undefined,
			isError: typeof d.isError === "boolean" ? d.isError : undefined,
			reasonClass: typeof d.reasonClass === "string" ? d.reasonClass : undefined,
			host: typeof d.host === "string" ? d.host : undefined,
			reason: typeof d.reason === "string" ? d.reason : undefined,
		});
	}
	return views;
}

/** 展示层排序：`ts` 倒序（ISO 字符串可解析）；缺失/非法排最后，稳定排序保持相对序 */
function byTsDesc(a: AuditView, b: AuditView): number {
	const ta = a.ts !== undefined ? Date.parse(a.ts) : Number.NaN;
	const tb = b.ts !== undefined ? Date.parse(b.ts) : Number.NaN;
	const fa = Number.isNaN(ta) ? Number.NEGATIVE_INFINITY : ta;
	const fb = Number.isNaN(tb) ? Number.NEGATIVE_INFINITY : tb;
	return fb - fa;
}

/** reason 单行化 + 160 字符截断（T1）；换行折叠为单空格 */
function singleLine(text: string, max = REASON_MAX_CHARS): string {
	const flat = text.replace(/\s*\r?\n\s*/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function formatLine(v: AuditView): string {
	const state = v.isError === undefined ? "-" : v.isError ? "blocked" : "ok";
	const head = `[${v.ts ?? "-"}] ${v.tool ?? "-"} ${v.authz ?? "-"}/${state}`
		+ ` class=${v.reasonClass ?? "-"} host=${v.host ?? "-"}`;
	return v.reason === undefined ? head : `${head} ${singleLine(v.reason)}`;
}

/** 格式化回看报告（B3/B7）：头部含可读范围声明（RR-2/E5）与截断提示（T1）；空态显式 */
export function formatAuditReport(views: readonly AuditView[], limit: number, truncated = false): string {
	if (views.length === 0) return `本会话无审计条目（${SCOPE_NOTE}）`;
	const recent = [...views].sort(byTsDesc).slice(0, limit);
	const truncNote = truncated ? `；已截断至 ${AUDIT_LIMIT_MAX} 条上限` : "";
	const head = `ops-audit：显示 ${recent.length} 条（${SCOPE_NOTE}${truncNote}）`;
	return [head, ...recent.map(formatLine)].join("\n");
}
