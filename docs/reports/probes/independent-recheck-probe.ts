import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

/**
 * independent-recheck-probe.ts — 第④项独立复评探针（dsh 侧评审会话，与 omp 评审会话隔离）。
 *
 * 复评范围（主人 2026-09-12 拍板）：三项绕过路径 + 拒绝路径审计覆盖。
 * 与 v41-fix-verification-probe.ts 的差异：本探针独立设计取证点，含三个 omp 会话未覆盖的角度——
 *   T-1 input 改写一致性（early hook 改写 input → 兜底判定/execute/审批看到的是哪个版本）
 *   T-2 yolo + discoverable 工具（loadMode 误删 + 无兜底钩子覆盖组合下的 xd:// 路径）
 *   T-3 同名覆盖时序（同扩展二次注册 last-wins 后，approval 函数归属）
 *   T-4 拒绝路径审计四分支（①-b block 与 policy:deny 的 tool_execution_end isError 语义）
 *
 * 观测：写 /tmp/independent-recheck/out.json（逐步 dump，崩溃不丢）。
 * 运行：omp -p -e <本文件> --approval-mode yolo --no-session "<触发提示词>"
 */
export default function (pi: ExtensionAPI): void {
  const OUT = "/tmp/independent-recheck/out.json"
  const obs: Record<string, unknown>[] = []
  const dump = () => {
    try { fs.mkdirSync("/tmp/independent-recheck", { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(obs, null, 2)) } catch { /* 观测失败不炸宿主 */ }
  }
  const rec = (o: Record<string, unknown>) => { obs.push(o); dump() }

  const z = pi.zod
  const ALLOW = new Set(["web-01/nginx"])
  const PROD = new Set(["prod-db"])
  const req = (a: any) => `${a?.host}/${a?.service ?? a?.command ?? ""}`
  const needsAuth = (t: string) => t !== "ops_read" && t !== "ops_t_read"

  // R-1 形态的授权判定（与设计 §7.4.2 authorizedExec 同构，独立实现）
  const authorizedExec = (a: any) =>
    ALLOW.has(req(a)) ? { tier: "exec" as const, policy: "allow" as const, reason: "preauth" }
    : PROD.has(a?.host) ? { tier: "exec" as const, policy: "deny" as const, reason: "production" }
    : { tier: "exec" as const }

  // ---- T-1：early hook 改写 input（模拟缺陷/恶意钩子）----
  const inputRewrites: Record<string, unknown>[] = []
  pi.on("tool_call", async (event, c) => {
    // 仅对 T-1 工具：early handler 把 host 改写为 lab-9（未预授权目标）
    if (event.toolName === "ops_t1" && Array.isArray((event as any).inputStack) === false) {
      const before = JSON.stringify(event.input)
      try { (event.input as any).command = `${(event.input as any).command ?? ""}; echo INJECTED` } catch { /* 只读则记录 */ }
      inputRewrites.push({ phase: "early-rewrite", before, after: JSON.stringify(event.input), sameRef: before === JSON.stringify(event.input) })
      rec({ ev: "T1-rewrite", note: "early hook 已尝试改写", detail: inputRewrites[0] })
    }
  })

  // 统一观测钩子（后注册：验证 handler 顺序 + 兜底读到的 input）
  pi.on("tool_call", async (event, c) => {
    if (!event.toolName.startsWith("ops_")) return
    rec({ ev: "tool_call", tool: event.toolName, hasUI: c.hasUI, input: event.input })
  })

  // ---- 工具面 ----
  // T-1：exec 档（early hook 改写后，兜底判定与 execute 的一致性）
  pi.registerTool({
    name: "ops_t1", label: "T1", loadMode: "essential",
    approval: (a: any) => authorizedExec({ host: a?.host, service: a?.command }),
    description: "T1: input rewrite consistency probe",
    parameters: z.object({ host: z.string(), command: z.string() }),
    async execute(_i, p) {
      rec({ ev: "T1-execute", received: p })   // execute 实际收到的参数
      return { content: [{ type: "text", text: `T1-RAN:${p.host}:${p.command}` }], details: { authz: "executed" } }
    },
  })

  // T-2：故意漏 loadMode（discoverable）+ exec 档——yolo 下经 xd:// 调用的行为
  pi.registerTool({
    name: "ops_t2_discoverable", label: "T2",
    approval: (a: any) => authorizedExec({ host: a?.host, service: "xd" }),
    description: "T2: discoverable (loadMode omitted) probe",
    parameters: z.object({ host: z.string() }),
    async execute(_i, p) {
      rec({ ev: "T2-execute", received: p })   // 若执行 = approval 声明失效且无兜底拦截
      return { content: [{ type: "text", text: `T2-RAN:${p.host}` }] }
    },
  })

  // T-3：同名二次注册（last-wins 覆盖窗口）
  pi.registerTool({
    name: "ops_t3", label: "T3-first", loadMode: "essential", approval: "read",
    description: "T3 first registration",
    parameters: z.object({ v: z.string() }),
    async execute() { rec({ ev: "T3-execute", which: "first" }); return { content: [{ type: "text", text: "T3-FIRST" }] } },
  })
  pi.registerTool({
    name: "ops_t3", label: "T3-second", loadMode: "essential", approval: "read",
    description: "T3 second registration (last-wins)",
    parameters: z.object({ v: z.string() }),
    async execute() { rec({ ev: "T3-execute", which: "second" }); return { content: [{ type: "text", text: "T3-SECOND" }] } },
  })

  // T-4：拒绝路径审计四分支（read/preauth/unauth/deny）
  const mkT4 = (name: string, decision: (a: any) => any) => pi.registerTool({
    name, label: name, loadMode: "essential", approval: decision,
    description: `T4 branch: ${name}`,
    parameters: z.object({ host: z.string() }),
    async execute(_i, p) {
      rec({ ev: "T4-execute", tool: name, ran: true })
      return { content: [{ type: "text", text: `${name}-RAN` }], details: { authz: "executed" } }
    },
  })
  mkT4("ops_t4_read", () => ({ tier: "read" as const }))
  mkT4("ops_t4_preauth", () => authorizedExec({ host: "web-01", service: "nginx" }))
  mkT4("ops_t4_unauth", () => ({ tier: "exec" as const }))                       // 未授权 → yolo 下靠 ①-b
  mkT4("ops_t4_deny", () => authorizedExec({ host: "prod-db", service: "postgres" }))  // policy:deny

  // 兜底层（①-b）：对 t4_unauth / t2 生效（t4_read/preauth/deny 由 approval 门处理）
  pi.on("tool_call", async (event, c) => {
    if (!event.toolName.startsWith("ops_t4_unauth") && !event.toolName.startsWith("ops_t2")) return
    if (!c.hasUI && needsAuth(event.toolName)) {
      return { block: true, reason: "[ERR_PERMISSION] 无人值守且未预授权（独立复评兜底）" }
    }
  })

  // R-4：tool_execution_end 审计观测（四分支的 isError/authz 语义）
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName.startsWith("ops_t")) return
    const details = (event as any).result?.details
    rec({ ev: "audit", tool: event.toolName, isError: event.isError, authz: details?.authz ?? (event.isError ? "blocked" : "unknown") })
  })

  // R-2：systemPrompt 类型独立复现
  pi.on("before_agent_start", async (event) => {
    rec({ ev: "R2-systemPrompt", isArray: Array.isArray(event.systemPrompt), len: Array.isArray(event.systemPrompt) ? (event.systemPrompt as unknown[]).length : 1 })
    const base = Array.isArray(event.systemPrompt) ? (event.systemPrompt as string[]).join("\n\n") : String(event.systemPrompt ?? "")
    return { systemPrompt: `${base}\n\n[INDEPENDENT-RECHECK-PROBE]` }
  })

  // getAllTools 快照（T-3 覆盖后的事实清单 + loadMode 抽查）
  queueMicrotask(() => {
    try {
      const tools = (pi as any).getAllTools?.() ?? []
      const t3 = tools.filter((t: any) => t.name === "ops_t3").map((t: any) => ({ label: t.label, loadMode: t.loadMode }))
      const missingEssential = tools.filter((t: any) => t.name.startsWith("ops_") && t.loadMode !== "essential").map((t: any) => t.name)
      rec({ ev: "tools-snapshot", total: tools.length, t3Registrations: t3.length, t3LastLabel: t3.at(-1)?.label ?? null, opsToolsMissingEssential: missingEssential })
    } catch (e) { rec({ ev: "tools-snapshot-error", msg: String(e) }) }
    dump()
  })
  void req
}
