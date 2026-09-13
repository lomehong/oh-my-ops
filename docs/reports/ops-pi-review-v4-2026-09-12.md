# 评审结论：omo 运维智能体架构设计 v4.0

- 评审对象：`docs/designs/ops-pi-architecture-design.md`（v4.0，状态 `草稿`）
- 配套需求包：`docs/requirements/ops-pi-requirement-package.md`
- 评审类型：方案评审（architect-review，流水线阶段 8/9 独立视角）
- 评审日期：2026-09-12
- 证据基准：oh-my-pi `omp` **18.1.18** 实装源码（`/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent`）+ 本轮实测探针
- **结论：驳回（退回 architect-design）**

---

## 五问得分：10/10（全部作答）

| # | 五问 | 分 | 依据 |
|---|---|---|---|
| Q1 | 改哪里？ | **2/2** | §7.1/§7.3 精确到包与文件级目录；§7.4.1 给全工具档位；§8 分 6 个 Phase；单平台目标明确 |
| Q2 | 为什么改？ | **2/2** | 需求包 §0/§1（A0–A5 可验收判据）+ 平台决策沿革 + 能力矩阵决策依据 |
| Q3 | 影响谁？ | **2/2** | §2 系统覆盖列全（L1/L2/omp 平台/Yuyi/御符/vault/沙箱/目标主机）+ 范围外参与方；明确影响 omp 审批面与审计面 |
| Q4 | 如何验证？ | **2/2** | §5 六手段齐全；**X8 端到端实证**；探针脚本已入库可复跑 |
| Q5 | 还有什么没有确认？ | **2/2** | B1–B5 + U1–U2 + §6 不确定性治理三类齐全；B1 阻断显式 |

---

## 六维度得分：48/60

| 维度 | 分 | 检查要点与扣分依据 |
|---|---|---|
| 需求覆盖 | **9/10** | Do/Don't/To Confirm 三列齐全，与需求包 A0–A5 双向映射，来源可溯。**扣 1**：A3「Owner 明示批准」在 yolo 模式下不成立（见 R-1），需求→方案存在未闭合处 |
| 系统覆盖 | **8/10** | 服务/仓库/依赖/缺席降级齐备；对照 dsh 套件矩阵无遗漏声明。**扣 2**：未把「平台审批模式」列为系统级部署约束；未说明与平台**原生审计条目**的复用/去重关系（见 R-5） |
| 证据覆盖 | **7/10** | O1–O19 逐条带 `文件:行`，X1–X8 实测可复跑，U1–U2 显式登记；回源核查 4 项。**扣 3**：两处自研样例与平台事实不符（R-1 依赖的 `override` 语义、R-2 的 `systemPrompt` 类型），说明抽验未覆盖到「代码样例级」 |
| 风险覆盖 | **6/10** | 六类齐全，主风险识别到位（`loadMode`/30s 上限/默认 yolo 均点名）。**扣 4**：**默认 yolo × `override` 组合会静默放行未授权操作**，方案仅在风险段落写"部署要求显式设 approvalMode"——把安全属性降级为文档约定，未工程化阻断，违反「治理缺席不得扩权/不得静默放行」 |
| 验证覆盖 | **9/10** | 单测/契约/回归/负测/监控/回滚六手段具体可执行；探针入库；负测含绕过变体。**扣 1**：负测清单缺「yolo 下未授权必须被拒」这一条（正是漏掉的洞） |
| 不确定性治理 | **9/10** | Unknown/Conflict/Human Decision 分类清晰，B1 阻断、平台版本未知均显式。**扣 1**：B5 处置为"由启动期探针兜底"，但**探针读不到 `approvalMode`**（实测扩展 API 无 settings 访问器），兜底能力未验证 |

**评分口径**：≥50/60 且无维度 ≤5 且五问全答 → 具备通过条件。本次 **48/60**，无维度 ≤5（6 为最低），五问 10/10，但**未达 50 分线** → 不具备通过条件，驳回。

---

## 证据回源核查（亲自复跑，4 项）

| # | 被核查断言 | 方法 | 结果 |
|---|---|---|---|
| E-a | `override:true` 在非交互下强制要求人工 | `omp --approval-mode yolo -e probe.ts -p` | **部分不符**：yolo 下 `override` 被忽略，工具**直接执行**（`OVR_RAN:prod-db`）→ 见 R-1 |
| E-b | 工具返回的 `details` 会回流到 `tool_result`（审计 `authz` 来源机制） | 注册返回 `details:{authz:...}` 的工具，读 `tool_result` | **成立**：`toolResultKeys` 含 `details`，值 `{authz:"preauth:web-01/nginx"}` → §7.8 机制可用（R-3 排除） |
| E-c | `before_agent_start` 的 `event.systemPrompt` 可直接字符串插值 | 在 handler 中探测类型 | **不符**：实测为 **`array`（长度 2）**；`\`${event.systemPrompt}\` ` 会拼成逗号串 → 见 R-2 |
| E-d | `tool_result` 覆盖「含被拒绝的调用」（需求包 A4） | 在 `tool_call` 返回 `{block:true}`，记录全部事件 | **不符**：事件序列为 `tool_call` → `tool_execution_start` → `tool_execution_end`，**无 `tool_result`**；`execute` 未运行 → 见 R-4 |

补充实测（成立）：`ctx.hasUI` 在 `tool_call` handler 中可读（`false`）；`ctx.setInterval` 为 function；`getBranch()` 返回数组。

---

## 缺口清单（逐条可执行）

### R-1（P0 · 安全）默认 `yolo` 模式下 `override:true` 被忽略 → 未授权操作静默执行

**证据**
- `resolveApproval` 在 `mode === "yolo"` 分支中：`decision.policy` 为空时直接返回 `{policy: effectiveUserPolicy ?? "allow"}`（`src/tools/approval.ts:160-176`），**`override` 不参与**（注释亦明示「In yolo mode, override-based tool prompts are ignored」）。
- 默认模式即 yolo：`wrapper.ts:198` `?? "yolo"`。
- 实测：`--approval-mode yolo` + 非交互，`approval: () => ({tier:"exec", override:true})` 的工具**执行成功**。
- 影响：§7.4 第①层用 `override:true` 表达「未授权 → 需 Owner 批准」，在宿主默认配置下**完全失效**；这正是联邦原则禁止的「静默放行」（`suite-federation-principles.md` 显式降级三要素之「安全收敛」）。

**修改指引**（修复已验证可行）
1. `authorizedExec()` **移除 `override`**，未授权分支返回朴素 `{tier:"exec"}`（交平台在 always-ask/write 下弹窗或硬失败）；
2. **新增模式无关兜底层**（并入第①层）：在 `tool_call` 内用 `ctx.hasUI` 判定——
   ```ts
   pi.on("tool_call", async (event, c) => {
     if (!event.toolName.startsWith("ops_")) return
     if (c.hasUI) return                                  // 交互态：交平台审批
     const req = asPolicyRequest(event.toolName, event.input)
     if (needsAuth(event.toolName, event.input) && !preauthorized(req))
       return { block: true, reason: "[ERR_PERMISSION] 无人值守且未预授权" }
   })
   ```
   **实测（`--approval-mode yolo` + 非交互）**：未预授权 → `[ERR_PERMISSION] 无人值守且未预授权`（工具未运行）；已预授权 → 正常执行。该层不受 `approvalMode` 影响。
3. §4 风险表把「默认 yolo」从"部署要求"升级为**工程化阻断**；并在 §6 登记**残留风险**：交互态 + 显式 yolo + 未授权 → 仍会执行（生产目标由 `policy:"deny"` 独立兜住，实测 yolo 下仍拒）。

**验收**：`--approval-mode yolo` 非交互下，未预授权的 `exec` 档工具被拒且工具未运行；已预授权者放行。

### R-2（P0 · 正确性）`event.systemPrompt` 是 `string[]`，样例字符串插值会损坏系统提示

**证据**：实测 `systemPromptType: "array"`、`systemPromptLen: 2`；`types.ts:1149-1152` 声明 `systemPrompt?: string[]`；`runner.ts:1750-1751` 仅对**返回值**做 `typeof === "string"` 兼容。

**修改指引**：§7.8 样例改为先归一化再拼接：
```ts
pi.on("before_agent_start", async (event) => {
  const hints = buildScenarioHints(config)
  if (!hints) return
  const base = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : String(event.systemPrompt)
  return { systemPrompt: `${base}\n\n${hints}` }   // 返回 string 被平台接受（runner.ts:1751）
})
```

**验收**：注册该 hook 后，系统提示中运维提示段完整、无逗号粘连（可用探针比对 `getSystemPrompt()`）。

### R-3（已排除）

`details` 正常回流至 `tool_result`（实测 `details:{authz:"preauth:web-01/nginx"}`）→ §7.8 的授权来源记录机制可用；但审计钩子本身需按 R-4 换位。

### R-4（P1 · 审计完整性）`tool_result` 不覆盖被阻断的调用 → A4 不成立

**证据**：实测被 `tool_call` 阻断时事件序列为 `tool_call` → `tool_execution_start` → `tool_execution_end`（`{toolName, toolCallId, result, isError}`），**无 `tool_result`**，`execute` 未运行。§7.8 仅在 `tool_result` 记录审计 → **恰好漏掉 A4 要求的"含被拒绝的调用"**。

**修改指引**：审计钩子改用 `tool_execution_end`（阻断与执行都触发，且携带 `isError` 与 `result`）；授权来源从 `result.details.authz` 取（若被阻断则为空，记 `blocked`）。或在 `tool_call` 的拒绝分支内直接 `pi.appendEntry`。二者取一，并写清为何不用 `tool_result`。

**验收**：负测中每条被拒调用在会话分支留下 `ops_audit` 条目（含 `blocked` 标记）。

### R-5（P2 · 去重与复用）未说明与平台原生审计条目的关系

**证据**：平台已有原生审计 custom entry——`TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start"`（`src/session/exit-diagnostics.ts:5`），由平台在工具实现启动前写入会话 JSONL（同文件 `:200` 判型读取）。

**修改指引**：§7.8 说明分工——平台负责「工具执行启动标记」（用于 resume 诊断），ops-pi 只补**运维语义**字段（授权来源、策略判定、目标主机），避免双份重复审计；并在 §5 监控中说明读取方式。

### R-6（P2 · 系统覆盖）平台审批模式须列为部署约束

**证据**：扩展 API 面**无 settings 访问器**（实测 `apiKeys` 仅 `arktype/cwd/events/extension/flagValues/logger/pendingProviderRegistrations/pi/runtime/typebox/zod`），`ctx` 仅暴露 `ui` 为自有属性（其余在原型链）。故扩展**无法自检 `approvalMode`**。

**修改指引**：§2 系统覆盖新增一行「部署配置：`approvalMode` 不得为 `yolo`（无人值守场景）」；§7.2 明确「平台探针无法校验审批模式，该约束由部署规范 + R-1 的模式无关兜底层共同保证」，不得声称探针可兜底（修正 B5 的处置描述）。

---

## 联邦原则核查

- **显式降级三要素**：外部增强（Yuyi/御符/vault）均有「可发现 / 安全收敛 / 可恢复」三列 → 符合。
- **宿主平台注入不受限**：§1 Don't 的合规说明引用正确（「那是平台，不是邻居」）→ 符合。
- **治理缺席不得扩权 / 不得静默放行**：**违反（R-1）**——默认 yolo 下未授权操作静默执行。驳回的主要依据之一。

## 知识漂移登记

- **`architect-knowledge` 现有条目 vs 代码：无事实性冲突**（库内无 pi/OMP API 断言）。`review-queue.yaml` 保持为空。
- **待回写（本次新增，需主人确认）**：`adapters/oh-my-pi.md` 的合规/高风险门指引「依赖宿主 approval-mode 权限门；不得静默放行」**表述不足**——实测表明仅声明 `approval` 档在默认 yolo 下会静默放行；须补「必须叠加**模式无关**的 `tool_call` 兜底层（用 `ctx.hasUI` 区分交互/无人值守）」。建议以 `practice/` 教训条目 + `adapters/oh-my-pi.md` 增补落地；**`adapters/` 位于只读挂载**，需主人中介改动。
- **建议入 `practice/` 的教训**：①「宿主审批档在 yolo 模式失效——安全属性必须用模式无关的闸表达」；②「`tool_result` 不覆盖被阻断的调用，审计须用 `tool_execution_end`」；③「`before_agent_start` 的 `systemPrompt` 在 omp 是数组，插值前须归一化」。

## 待主人确认事项

| # | 门 | 待决内容 |
|---|---|---|
| 1 | High-risk Change | 接受 R-1 的处置口径吗？——**无人值守下 `exec` 档必须预授权**；交互态 + 显式 yolo + 未授权仍会执行（残留风险，生产由 `policy:"deny"` 独立兜住） |
| 2 | 合规 | 是否要求 `approvalMode ≠ yolo` 写入部署规范作为强制项（扩展无法自检） |
| 3 | Conflict | 知识回写：`adapters/oh-my-pi.md` 的合规门指引需增补（`adapters/` 只读，需你中介） |
| 4 | 既有 | B1（Yuyi 身份接口，阻断）、B2（仓库/git）、B3（目录命名）、B5（omp 最低版本承诺）|

## 下一步

驳回 → 退回 architect-design。修复顺序：**R-1 → R-2 → R-4 →（R-5/R-6）** → 更新 §5 负测清单（补 yolo 用例）→ 重新提交评审。

按纪律，本轮结论与后续修订版**均需主人确认方为落定**。

---

# 复评（v4.1，2026-09-12 同日）

按缺口清单修复后复评。**修复证据已亲自复跑**（最不安全模式 `--approval-mode yolo` + 非交互，一次运行覆盖四个分支）：

| 调用 | 结果 | 覆盖缺口 |
|---|---|---|
| `ops_read(host=web-01)` | ✅ `READ:web-01`（放行） | A1 只读巡检 |
| `ops_change(web-01, nginx)` 已预授权 | ✅ `CHANGED:web-01/nginx` | Owner 预授权在 yolo 下仍生效 |
| `ops_change(prod-db, postgres)` 生产目标 | ✅ 拦截：`生产目标禁止无人值守变更`，**未执行** | `policy:"deny"` 不受模式影响 |
| `ops_change(lab-9, redis)` 未授权 | ✅ 拦截：`[ERR_PERMISSION] 无人值守且未预授权`，**未执行** | **R-1 修复生效**（v4.0 此处会执行） |

审计侧同时验证（R-4）：三次调用（含**两次被拒**）均留下 `ops_audit` 条目，被拒者 `isError=true` / `authz=blocked` —— v4.0 用 `tool_result` 时这两条会**完全丢失**。`before_agent_start` 亦实测确认 `inputWasArray: true`（R-2 修复路径生效）。

验证工件已入库：`docs/reports/probes/v41-fix-verification-probe.ts`（含调用序列与预期结果）。

## 逐维度复核（修复后）

| 维度 | v4.0 | v4.1 | 变化依据 |
|---|---|---|---|
| 需求覆盖 | 9 | **10** | A3 闭环：未授权=拒绝、生产=硬拒、预授权=放行，三种情形均有实证 |
| 系统覆盖 | 8 | **9** | 新增「部署配置 `approvalMode ≠ yolo`」约束行；补齐与平台原生审计的分工 |
| 证据覆盖 | 7 | **9** | 新增 X9–X14；样例与平台事实对齐（数组归一化、审计落点、无 settings 访问器） |
| 风险覆盖 | 6 | **9** | yolo 由"部署要求"升级为**模式无关工程化阻断**；残留风险 RR-1/RR-2 显式登记 |
| 验证覆盖 | 9 | **10** | 负测补入「yolo + 非交互 未授权必须被拒」与「被拒调用须留审计」两条回归项 |
| 不确定性治理 | 9 | **9** | B5 处置更正为「探针读不到审批模式，改由部署规范 + 兜底层」；未新增未知 |
| **合计** | **48** | **56** | — |

## 复评结论

- **预估 56/60**，五问 10/10，无维度 ≤5 → **达到通过条件线**。
- 但按纪律：**这是修复方自评的预估分，不构成通过**。R-1/R-2/R-4 的修复涉及安全语义与审计完整性，**建议由非编码会话或另起会话做一次独立复评**（复核点：① ①-b 兜底层是否真无绕过路径——特别是 `input` 事件被改写、`loadMode` 被误删、共载扩展同名覆盖三种情形；② 审计是否覆盖全部拒绝路径，含 `policy:"deny"` 短路与斜杠命令路径）。
- **落定仍以主人确认为准。**

## 知识回写

本次实证已按回写机制入库（`architect-knowledge`，`status: 待审核`）：

| 条目 | 内容 |
|---|---|
| `practice/omp-extension-contract-pitfalls.md` | omp 扩展四坑：默认 yolo×override 静默放行、`tool_result` 漏审计被拒调用、`systemPrompt` 是数组、`loadMode` 默认 discoverable —— 含逐条**复跑入口** |
| `practice/review-baseline-discipline.md` | 评审基准纪律：先锁定被评审对象声明的基准并取证，再评分 |

已同步 `practice/index.md`、`review-queue.yaml`、`source-manifest.yaml`。
**另需主人中介**：`adapters/oh-my-pi.md` 的合规门指引「依赖宿主 approval-mode 权限门；不得静默放行」表述不足（实测仅声明 `approval` 档在默认 yolo 下会静默放行，须补「叠加模式无关的 `tool_call` 兜底层」）——`adapters/` 位于只读挂载，无法自行改动。
