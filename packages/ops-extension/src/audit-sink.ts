import type { AuditData, AuditRecord } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { OpsContext } from "./context.ts";
import type { AuditView } from "./audit-view.ts";

/**
 * 审计双写（唯一写入口）：会话条目（供 /ops-audit 回看当前分支）+ 独立 append-only 文件。
 * ★ 会话条目在 --no-session（README 无人值守标准用法）下为内存态、退出即丢
 *   （宿主 SessionManager.inMemory → MemorySessionStorage，appendEntry 直达 appendCustomEntry）；
 *   独立文件与会话解耦，是 A4「全过程留审计」的真正落点。
 */
export function recordAudit(pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<OpsContext, "audit">, data: AuditData): void {
	pi.appendEntry("ops_audit", data);
	ctx.audit.append(data);
}

/** 独立审计文件记录 → 展示视图（与会话条目的 toAuditViews 同形，复用 formatAuditReport） */
export function recordsToViews(records: readonly AuditRecord[]): AuditView[] {
	return records.map((r) => ({
		ts: typeof r.ts === "string" ? r.ts : undefined,
		tool: typeof r.tool === "string" ? r.tool : undefined,
		authz: typeof r.authz === "string" ? r.authz : undefined,
		isError: typeof r.isError === "boolean" ? r.isError : undefined,
		reasonClass: typeof r.reasonClass === "string" ? r.reasonClass : undefined,
		host: typeof r.host === "string" ? r.host : undefined,
		reason: typeof r.reason === "string" ? r.reason : undefined,
	}));
}
