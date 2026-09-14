import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { formatAuditReport, toAuditViews } from "../../../src/audit-view.ts"

/**
 * OPSAUDIT-3 数据面探针（方案 §5 T5）：会话分支中的 ops_audit 条目
 * 可被 toAuditViews 按信封判据（{type:"custom",customType:"ops_audit",data}）收窄，
 * tool/ts/authz 字段可辨；formatAuditReport 头部含可读范围声明。
 *
 * 写入侧用与 hooks.ts/commands.ts 完全同款的 appendEntry 形状，覆盖两类条目：
 * 工具路径（authz=read，isError=false）与被拒路径（authz=blocked + reasonClass/reason）。
 * session_start 与 turn_end 各 dump 一次（后者覆盖前者）：即使 -p 模式 turn_end 不触发，
 * session_start 内的 getBranch 读取也足以完成数据面断言。
 */
export default function (pi: ExtensionAPI): void {
	const dir = process.env.OPS_AUDIT_PROBE_OUT_DIR ?? "/tmp/ops-audit-probe"
	const outFile = `${dir}/out.json`
	let dumped = false

	const dump = (label: string, ctx: { sessionManager: { getBranch: () => unknown[] } }) => {
		const views = toAuditViews(ctx.sessionManager.getBranch())
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(
			outFile,
			JSON.stringify(
				{
					label,
					count: views.length,
					seeded: views.filter((v) => v.tool === "ops_read_file" || v.tool === "ops_service"),
					report: formatAuditReport(views, 20),
				},
				null,
				2,
			),
		)
		dumped = true
	}

	pi.on("session_start", async () => {
		pi.appendEntry("ops_audit", {
			tool: "ops_read_file",
			isError: false,
			ts: new Date().toISOString(),
			authz: "read",
		})
		pi.appendEntry("ops_audit", {
			tool: "ops_service",
			isError: true,
			ts: new Date().toISOString(),
			authz: "blocked",
			reasonClass: "ERR_PERMISSION",
			reason: "[ERR_PERMISSION] guard-unattended\n第二行文本，验证单行化。",
		})
	})

	pi.on("turn_end", async (_e, c) => {
		if (!dumped) dump("turn_end", c)
	})

	// session_start 的 ctx 与 turn_end 同源；延后一拍读取以确保 appendEntry 已入分支
	pi.on("session_start", async (_e, c) => {
		dump("session_start", c)
	})
}
