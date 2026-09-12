import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
/** N-4 验证：tool_call 内 appendEntry 是否落进会话分支 */
export default function (pi: ExtensionAPI): void {
  const OUT = "/tmp/v42/out3.json"
  const obs: Record<string, unknown>[] = []
  const dump = () => fs.writeFileSync(OUT, JSON.stringify(obs, null, 2))
  const rec = (o: Record<string, unknown>) => { obs.push(o); dump() }
  const z = pi.zod
  let round = 0

  pi.registerTool({
    name: "ops_g", label: "G", loadMode: "essential", approval: "read",
    description: "guard audit probe", parameters: z.object({ x: z.string() }),
    async execute() { return { content: [{ type: "text", text: "RAN" }] } },
  })

  pi.on("tool_call", async (event, c) => {
    if (event.toolName !== "ops_g") return
    rec({ ev: "guard-block", hasUI: c.hasUI })
    pi.appendEntry("ops_audit", { tool: event.toolName, layer: "guard-unattended", ts: new Date().toISOString() })
    return { block: true, reason: "[ERR_PERMISSION] guard-unattended" }
  })

  pi.on("turn_end", async (_e, c) => {
    round++
    const b = c.sessionManager.getBranch()
    const audits = b.filter((e: any) => e.type === "custom" && e.customType === "ops_audit")
    rec({ ev: "turn_end-branch", round, total: b.length, opsAudit: audits.length, layers: audits.map((e: any) => e.data?.layer) })
  })
}
