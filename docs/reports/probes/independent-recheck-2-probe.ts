import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

/**
 * independent-recheck-2-probe.ts — 第二轮复审探针（复核第一轮 independent-recheck 的四个发现）。
 *
 * 相对第一轮的方法学改进：
 *   M-1 审批函数实参直测：在 approval 函数内记录收到的 input 快照与时点，
 *       直接检验「审批判定 vs execute 实参」是否一致（第一轮仅推断，未直测）。
 *   M-2 getAllTools 可用性时序：在 session_start handler 内复测（第一轮仅测了加载期 queueMicrotask）。
 *   M-4 tool_execution_end 的 result 全文观测：检验 block 场景下 reason 是否可达（N-4 解法依据）。
 *   M-5 handler 顺序显式标记：early/late 两次 tool_call 的触发顺序与 input 引用快照。
 *
 * 观测：/tmp/recheck-2/out.json
 * 运行：omp -p -e <本文件> --approval-mode yolo --no-session "<触发提示词>"
 */
export default function (pi: ExtensionAPI): void {
  const OUT = "/tmp/recheck-2/out.json"
  const obs: Record<string, unknown>[] = []
  const dump = () => {
    try { fs.mkdirSync("/tmp/recheck-2", { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(obs, null, 2)) } catch { /* noop */ }
  }
  const rec = (o: Record<string, unknown>) => { obs.push(o); dump() }

  const z = pi.zod
  const ALLOW = new Set(["web-01/nginx"])
  const authorizedExecProbed = (a: any) => {
    // M-1：审批函数实参快照（含时点标记）
    rec({ ev: "approval-probe", tool: "ops_m1", inputAtApproval: JSON.parse(JSON.stringify(a ?? {})) })
    const cmd = String(a?.command ?? "")
    return { tier: "exec" as const, policy: ALLOW.has(`${a?.host}/${a?.service ?? cmd}`) ? ("allow" as const) : ("allow" as const) }
  }

  // ---- M-1/M-5：input 改写一致性（early 改写 → approval/late/execute 各收到什么）----
  const seq: string[] = []
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ops_m1") return
    seq.push("early")
    const before = JSON.stringify(event.input)
    try { (event.input as any).command = `${(event.input as any).command ?? ""}; echo INJECTED-2` } catch { /* readonly */ }
    rec({ ev: "M5-early", before, after: JSON.stringify(event.input), mutated: before !== JSON.stringify(event.input) })
  })
  pi.registerTool({
    name: "ops_m1", label: "M1", loadMode: "essential",
    approval: authorizedExecProbed,
    description: "M1: approval-vs-execute consistency probe",
    parameters: z.object({ host: z.string(), command: z.string() }),
    async execute(_i, p) {
      seq.push("execute")
      rec({ ev: "M1-execute", seq: seq.slice(), received: JSON.parse(JSON.stringify(p ?? {})) })
      return { content: [{ type: "text", text: `M1-RAN:${p?.command}` }] }
    },
  })
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ops_m1") return
    seq.push("late")
    rec({ ev: "M5-late", input: JSON.parse(JSON.stringify(event.input ?? {})) })
  })

  // ---- M-2：getAllTools 时序复核（session_start 内复测）----
  pi.on("session_start", async () => {
    let m2: Record<string, unknown>
    try {
      const tools = (pi as any).getAllTools?.() ?? []
      m2 = { callable: true, total: tools.length, opsCount: tools.filter((t: any) => String(t.name).startsWith("ops_")).length }
    } catch (e) { m2 = { callable: false, msg: String(e) } }
    rec({ ev: "M2-getAllTools-in-session-start", ...m2 }); dump()
  })

  // ---- M-3/M-4：discoverable（yolo）+ 拒绝场景 result 全文 ----
  pi.registerTool({
    name: "ops_m3_disc", label: "M3",
    approval: () => ({ tier: "exec" as const }),   // exec 档（无人值守 → 应被平台硬失败或兜底拦）
    description: "M3: discoverable probe (loadMode omitted)",
    parameters: z.object({ host: z.string() }),
    async execute(_i, p) { rec({ ev: "M3-execute", ran: true, received: p }); return { content: [{ type: "text", text: `M3-RAN:${p?.host}` }] } },
  })
  pi.registerTool({
    name: "ops_m4_block", label: "M4", loadMode: "essential",
    approval: () => ({ tier: "exec" as const }),
    description: "M4: block-reason visibility probe",
    parameters: z.object({ host: z.string() }),
    async execute() { rec({ ev: "M4-execute-unexpected" }); return { content: [{ type: "text", text: "M4-RAN" }] } },
  })

  pi.on("tool_call", async (event, c) => {
    if (event.toolName === "ops_m3_disc") {
      rec({ ev: "M3-tool-call", hasUI: c.hasUI, input: event.input })
      if (!c.hasUI) return { block: true, reason: "[RECHECK2] unattended exec blocked" }
    }
    if (event.toolName === "ops_m4_block") {
      rec({ ev: "M4-tool-call-block" })
      return { block: true, reason: "[RECHECK2] deliberate block — reason visibility test" }
    }
  })

  // M-4：tool_execution_end 的 result 全文（block 场景 reason 是否可见）
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName.startsWith("ops_m")) return
    rec({ ev: "audit", tool: event.toolName, isError: event.isError, resultFull: JSON.parse(JSON.stringify((event as any).result ?? null)) })
  })

  pi.on("before_agent_start", async (event) => {
    rec({ ev: "R2-recheck", isArray: Array.isArray(event.systemPrompt) })
    const base = Array.isArray(event.systemPrompt) ? (event.systemPrompt as string[]).join("\n\n") : String(event.systemPrompt ?? "")
    return { systemPrompt: `${base}\n\n[RECHECK-2]` }
  })
}
