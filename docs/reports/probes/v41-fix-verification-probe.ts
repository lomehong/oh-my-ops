import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

/** v4.1 修复合成探针：R-1 兜底层 + R-2 systemPrompt 归一化 + R-4 审计落点 */
export default function (pi: ExtensionAPI): void {
  const z = pi.zod
  const audit: unknown[] = []
  const dump = () => fs.writeFileSync("/tmp/rev41/out.json", JSON.stringify(audit, null, 2))
  const ALLOW = new Set(["web-01/nginx"])            // 模拟 policy.allows
  const PROD = new Set(["prod-db"])                  // 模拟 policy.isProduction
  const req = (a: any) => `${a?.host}/${a?.service ?? ""}`
  const needsAuth = (t: string) => t !== "ops_read"

  // R-1：authorizedExec 不再用 override，未授权分支返朴素档位
  const authorizedExec = (a: any) =>
    ALLOW.has(req(a)) ? { tier: "exec" as const, policy: "allow" as const, reason: "命中预授权" }
    : PROD.has(a?.host) ? { tier: "exec" as const, policy: "deny" as const, reason: "生产目标禁止无人值守变更" }
    : { tier: "exec" as const }

  pi.registerTool({
    name: "ops_read", label: "R", loadMode: "essential", approval: "read",
    description: "read", parameters: z.object({ host: z.string() }),
    async execute(_i, p) { return { content: [{ type: "text", text: `READ:${p.host}` }], details: { authz: "read" } } },
  })
  pi.registerTool({
    name: "ops_change", label: "C", loadMode: "essential", approval: authorizedExec,
    description: "change", parameters: z.object({ host: z.string(), service: z.string() }),
    async execute(_i, p) { return { content: [{ type: "text", text: `CHANGED:${req(p)}` }], details: { authz: "preauth:" + req(p) } } },
  })

  // R-2：systemPrompt 归一化
  let spSent = ""
  pi.on("before_agent_start", async (event) => {
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : String(event.systemPrompt)
    spSent = `${base}\n\nOPS-HINTS-MARKER`
    audit.push({ ev: "BAS", inputWasArray: Array.isArray(event.systemPrompt) })
    dump()
    return { systemPrompt: spSent }
  })

  // R-1 ①-b：模式无关兜底
  pi.on("tool_call", async (event, c) => {
    if (!event.toolName.startsWith("ops_")) return
    const a = event.input as any
    audit.push({ ev: "tool_call", tool: event.toolName, hasUI: c.hasUI, req: req(a) })
    dump()
    if (!c.hasUI && needsAuth(event.toolName) && !ALLOW.has(req(a)))
      return { block: true, reason: "[ERR_PERMISSION] 无人值守且未预授权" }
  })

  // R-4：审计落点改 tool_execution_end
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName.startsWith("ops_")) return
    const details = (event as any).result?.details
    audit.push({ ev: "audit", tool: event.toolName, isError: event.isError,
                 authz: details?.authz ?? (event.isError ? "blocked" : "unknown") })
    dump()
  })
}
