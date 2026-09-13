/**
 * omo 方案 v4.0 安全模型端到端探针（验证工件，可复跑）
 *
 * 用途：复刻方案 §7.3 的注册骨架（`pi.zod` + `loadMode:"essential"` + 四种 approval 形态），
 *       在【最严模式 + 非交互】下验证 §7.4 安全模型四个分支的行为。
 *
 * 复跑命令：
 *   omp --no-session --approval-mode always-ask -e ./v4-skeleton-probe.ts -p \
 *     "Call these four tools in order and report each exact result or error text, one line each:
 *      1. ops_probe_read with host=web-01
 *      2. ops_probe_exec_allowed with host=web-01, action=restart
 *      3. ops_probe_exec_denied with host=web-01
 *      4. ops_probe_unauthorized with host=web-01"
 *
 * 预期结果（omp 18.1.18 实测通过，见方案 §3.1 X8）：
 *   1. read        → 执行        read-ok:web-01:30
 *   2. policy:allow→ 执行        exec-ok:web-01:restart      （Owner 预授权放行，always-ask 亦放行）
 *   3. policy:deny → 硬拒        is blocked by tool policy. Reason: 生产目标禁止无人值守变更
 *   4. override    → 硬失败      requires approval but no interactive UI available
 *
 * 平台能力探针结果写入 /tmp/v4probe/registered.json。
 *
 * 回归用途：omp 升级后复跑本脚本，四个分支行为任一改变即须复核方案 §3 证据表与 §7.4。
 */
import * as fs from "node:fs"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"

// 复刻 v4.0 §7.3 注册骨架（pi.zod + loadMode + approval 档）
const READ = "read" as const
const EXEC = "exec" as const

export default function (pi: ExtensionAPI): void {
  const z = pi.zod
  const out: Record<string, unknown> = { platform: {} }

  // §7.2 平台能力探针
  out.platform = {
    zod: typeof pi.zod?.object,
    zodEnum: typeof pi.zod?.enum,
    appendEntry: typeof pi.appendEntry,
    getAllTools: typeof pi.getAllTools,
    typebox: typeof pi.typebox?.Type,
  }

  pi.registerTool({
    name: "ops_probe_read",
    label: "Probe Read",
    loadMode: "essential",
    approval: READ,
    description: "只读探针。输出超过 50KB / 3000 行时由宿主截断并把完整内容存入 artifact。",
    parameters: z.object({
      host: z.string().describe("目标主机 hostname 或 IP"),
      timeout: z.number().optional().describe("超时秒数（缺省 30）"),
    }),
    async execute(_id, params, _signal, _upd, _c) {
      out.executedRead = params
      return { content: [{ type: "text", text: `read-ok:${params.host}:${params.timeout ?? 30}` }], details: { authz: "test" } }
    },
  })

  pi.registerTool({
    name: "ops_probe_exec_denied",
    label: "Probe Exec Denied",
    loadMode: "essential",
    approval: () => ({ tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更" }),
    description: "高危探针（应被硬拒）。",
    parameters: z.object({ host: z.string().describe("目标主机") }),
    async execute() { return { content: [{ type: "text", text: "SHOULD-NOT-RUN" }] } },
  })

  pi.registerTool({
    name: "ops_probe_exec_allowed",
    label: "Probe Exec Allowed",
    loadMode: "essential",
    approval: () => ({ tier: "exec", policy: "allow", reason: "命中预授权 web-01/nginx" }),
    description: "高危探针（Owner 预授权，应放行）。",
    parameters: z.object({ host: z.string().describe("目标主机"), action: z.enum(["status", "restart"]).describe("动作") }),
    async execute(_id, params) { return { content: [{ type: "text", text: `exec-ok:${params.host}:${params.action}` }] } },
  })

  pi.registerTool({
    name: "ops_probe_unauthorized",
    label: "Probe Unauthorized",
    loadMode: "essential",
    approval: () => ({ tier: "exec", override: true, reason: "未授权，需 Owner 批准" }),
    description: "未授权高危探针（非交互应硬失败）。",
    parameters: z.object({ host: z.string().describe("目标主机") }),
    async execute() { return { content: [{ type: "text", text: "SHOULD-NOT-RUN" }] } },
  })

  fs.writeFileSync("/tmp/v4probe/registered.json", JSON.stringify(out, null, 2))
}
