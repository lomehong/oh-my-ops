# 结构化需求包：`/ops-audit [n]` 审计回看命令

> 来源：主人 2026-09-14 试点需求「候选 A」——候选清单与踩点结论由本 Agent 于同日前置会话提出
> 产出：architect-prd-digest 六项覆盖检查（本文件）
> 状态：**待确认**（自报 ≠ 完成；本文件经主人确认后方可进入 architect-design）
> 关联基线：`docs/requirements/ops-pi-requirement-package.md`（A0–A6）、`docs/designs/ops-pi-architecture-design.md` v4.3（已落定）
> 台账任务：`OPSAUDIT-1`
> 评审：已请求 dsh 侧 architect 会话独立窗口评审（互不通气，见 §9）

---

## 0. 一句话需求

给 omo 增加一条**只读**斜杠命令 `/ops-audit [n]`：在当前会话分支内回看最近 n 条 `ops_audit` 审计条目，把「谁在什么授权来源下、对什么目标、做了什么、结果如何」直接呈现在会话 UI 上——补上 A4「当前分支内可读」目前**只写不读**的缺口。

**问题定式（先有问题，后有方案）**：A4 判据要求「当前分支内可读」（§1 E6），而现状是审计条目**写入了、没有任何读取路径**——`getBranch` 只在启动期被断言存在（E3/E4），运维人员要看审计只能手工 `grep` 会话 JSONL（E11）。`/ops-audit` 是问题找方案，不是方案找问题。

## 1. 可验收目标（Acceptance，可观测、可复跑）

| # | 目标 | 验收判据 |
|---|---|---|
| B1 | 命令可发现、可用 | 扩展加载后 `/ops-audit` 被注册（`pi.registerCommand("ops-audit", …)`）；交互会话内执行返回审计输出，**不是** unknown command |
| B2 | 读取面正确 | 数据源 = `ctx.sessionManager.getBranch()` 中 `type === "custom" && customType === "ops_audit"` 的条目；按 `ts` **倒序**取最近 n 条（默认 n=20） |
| B3 | 字段呈现完整且不臆造 | 每条输出含 `ts` / `tool` / `authz` / `isError`（以 `ok`/`blocked` 可辨）；有则显示 `reasonClass`、`host`，无则显示 `-`。**字段缺失不得补默认值语义** |
| B4 | 参数处理明确 | 无参 → 默认 20；`/ops-audit 5` → 5 条；非正整数/非数字 → 明确错误提示且**不输出条目**；超过上限（待确认 T1，暂定 200）→ 截断到上限并提示已截断 |
| B5 | 只读、无副作用 | 命令可达的 L1 方法集合 ⊆ `read` 档（对照方案 §7.7 可验证断言）；不产生任何变更/审批/令牌消费 |
| B6 | 自审计一致 | 命令自身落一条 `ops_audit`（`tool: "ops-audit"`，`authz: "read"`），与 `/ops-inspect`、`/ops-health` 先例一致（命令路径不产生 `tool_execution_end`，E2/E7） |
| B7 | 空态与边界显式 | 分支内无 `ops_audit` 条目 → 输出「本会话无审计条目」；输出同时声明可读范围 = **当前会话分支 leaf 路径**（RR-2 边界，E5） |
| B8 | 无回归 | 现有 11 个 runtime 探针与 `npm test` / L2 测试全绿；`ops_audit` **写入侧**（hooks.ts / commands.ts）不改语义 |
| B9 | 不扩大 LLM 可见面 | 命令输出**不注入** LLM 上下文、不新增工具、不改 systemPrompt（E5：custom entry 不进 LLM 上下文与转录）——审计仍只对人的 UI 可见 |

## 2. 范围（Do）

- `packages/ops-extension/src/commands.ts`：注册 `ops-audit`（只读命令），复用既有 `cmdCtx.ui.notify` 展示通道（E12 先例）；
- 新增审计读取的**收窄与格式化**纯函数（条目收窄 `unknown[] → AuditView[]`、参数解析、行格式化）；落点（同文件或独立模块）由 architect-design 决定，本需求包只给约束：**不新增运行时依赖、收窄函数须可单测**（`types/vendor-platform.d.ts:77` 的 `getBranch` 返回 `unknown[]`，必须有显式收窄）；
- 参数语义：`n` 默认 20、上限与截断口径 = T1；
- 测试：收窄函数（非 custom / 非 ops_audit / 字段缺失 / 顺序）与参数解析的单元测试；持久会话下的 runtime 探针断言（命令输出含 N 行 + 字段可辨）；
- 文档：`README.md`「斜杠命令（只读）」表新增一行；
- 回滚：删除命令注册即回到「仅写入」状态，无数据迁移、无状态残留。

## 3. 不做项（Don't，显式排除）

| # | 不做 | 原因 |
|---|---|---|
| D1 | 不做跨会话 / 跨分支 / 跨设备的审计聚合与追溯 | `getBranch()` 仅回溯当前 leaf 路径（E5）；跨会话不可变审计须另落 artifact/外部系统，方案 §6 已登记范围外 |
| D2 | 不把审计条目注入 LLM 上下文、不新增审计工具、不改 systemPrompt | E5：custom entry 不进 LLM 上下文与转录；一旦注入等于把审计面变成模型输入面（安全面扩大），且违背 A4 的「仅留痕」定位 |
| D3 | 不做过滤 / 搜索 / 分页 / 导出（`--tool`/`--layer`/`--host`/JSON 导出） | v1 只做「最近 n 条」；过滤需求待真实使用后再评估（T4） |
| D4 | 不做不可变审计存储、不对接外部审计系统 | 同 D1，方案 §6 范围外 |
| D5 | 不注册任何危险动作命令 | 方案 §7.7 规则：命令路径绕过 `tool_call`/`tool_result`（E7） |
| D6 | 不改 `ops_audit` 写入侧字段 schema（**不补 `layer` 字段**） | 本需求是「读既有数据」；A4 文案与实现的 `layer` / `reasonClass` 口径差异是独立漂移议题（T5），不在本需求扩范围 |
| D7 | 不自研输出截断 / 不落 artifact | 宿主已集中 spill（方案 N8）；但**命令输出走 `ui.notify`，不享该机制** → 以 T1 的行上限约束替代 |

## 4. 假设（Assumptions，未经确认即失效）

| # | 假设 | 依据 | 若不成立的影响 |
|---|---|---|---|
| H1 | `getBranch()` 在会话内可返回当前 leaf 路径上的全部 custom 条目，且 `ops_audit` 条目**可判型**（`type==="custom" && customType==="ops_audit"`） | 方案 O17 + **实测 X18**（探针在 `turn_end` 读 `getBranch()`，分支中 `ops_audit` 条目数 = 1 且字段保留）；本仓 `platform.ts` 启动期已断言该能力存在（E4） | 命令无法实现；须退回「grep 会话 JSONL」或改用其他宿主 API（需另立需求） |
| H2 | 运行时平台 = omp ≥ 18.1.18，`registerCommand` + `ui.notify` + `sessionManager.getBranch` 可用 | O16/O17；`commands.ts` 现有三条命令已实证（E12） | 命令不可用；但 `getBranch` 缺失已在 session_start 硬失败（E4），不会静默降级 |
| H3 | 审计条目字段面 = 现状：工具路径 `tool/toolCallId/isError/ts/authz/reasonClass/reason`，命令路径 `tool/host/isError/ts/authz` | **代码为准** E1/E2 | 展示字段表须随写入面变更同步；建议以收窄函数集中承载（本需求 Do 项） |
| H4 | 命令为交互态 UI 命令，非无人值守路径（`-p` 非交互不触发命令） | 方案 O19：命令由用户输入触发；无人值守经 LLM 走 `ops_*` 工具 | 无影响；`/ops-audit` 不参与 A1 无人值守验收 |
| H5 | 审计数据敏感度可接受在会话 UI 展示（含 host 与拒绝原因文本） | 数据本就落在同一会话分支内，UI 展示不新增读写面 | 若判定为敏感，须加遮蔽策略（T3） |
| H6 | 会话为持久会话时条目已落 JSONL；内存分支同样可读 | A4 现状 + 探针 05 的持久会话取证方式（E11） | 只影响「事后回看」，不影响当次会话内回看 |

## 5. 阻断项

**无。**（本需求为纯新增只读命令，无跨团队承诺、无合规硬约束、无高风险变更面。）

## 6. 待确认（需主人拍板；未清前不得进入 architect-design）

| # | 待确认 | 建议默认（若主人不另指示即按此设计） | 影响 |
|---|---|---|---|
| T1 | 条数上限 n 与单条文本截断口径 | `n ∈ [1, 200]`，默认 20；超限取最近上限条并提示「已截断至 200 条」；`reason` 单条单行截断 160 字符 | **决定 B4 能否验收**（上限是验收判据的一部分） |
| T2 | 展示通道 | 采用 `ctx.ui.notify`（既有先例、已实证）；`registerEntryRenderer`（矩阵注明 pi 侧存在、**omp 未实证**）登记为未来项，不采用 | 决定「是否要转录级渲染」；若要求转录可见，本需求范围须扩大（新增未验证平台能力） |
| T3 | 空态/错误文案与敏感字段遮蔽 | 中文提示；`host`/`reason` 原文展示（同分支本人数据）；不遮蔽 | 决定 B7/H5 |
| T4 | 是否要过滤参数（tool/layer/host） | v1 不做（D3） | 若要做，范围与验收判据需重开 |
| T5 | A4 文案「拒绝条目须可辨层级（`layer` 字段）」与实现（`reasonClass` + `reason`，**代码中无 `layer` 字段**）的口径差异如何处置 | 本需求不扩范围；另立知识漂移条目，由主人裁决「改 A4 文案」或「在写入侧补 `layer` 字段」 | **不阻断本需求**（B3 按实现字段展示）；但影响 A4 的判据可验收性 |

> T5 属 AGENTS.md 纪律 4「知识漂移」：实证（代码无 `layer`）与需求包 A4 文案冲突时先修方案再回写知识 —— 本文件只登记，不擅自改 A4。

> **闭合标注（2026-09-14）**：T1–T5 已由主人本会话拍板，全部按上表「建议默认」列定案（台账 `docs/tasks/OPSAUDIT-1.yaml` owner-decision 事件，提交 `34f4c73`）。本节「待确认」就此闭合，停止条件解除；评审见 `docs/designs/2026-09-14-阶段3试点-OPSAUDIT-1-评审记录.md`。

## 7. 专项评审触发

| 触发项 | 是否命中 | 理由 |
|---|---|---|
| 安全评审 | **是**（轻度） | 读取的是授权与拒绝记录（含 host、拒绝原因文本）；虽为只读且限本分支，须确认「不注入 LLM 上下文」这条边界（B9/D2） |
| 合规评审 | **是**（轻度） | 审计「可读性」属留存有效性的组成部分（A4 判据本身即合规向） |
| 高风险变更评审 | **否** | 纯新增只读命令，无生产变更面 |
| 跨团队评审 | **否** | 无跨系统接口变更；仅依赖 omp 宿主既有 API |

## 8. 六项覆盖检查表

| # | 检查 | 结论 | 证据来源 |
|---|---|---|---|
| ① | 需求覆盖 | ✅ 主人原话（候选项）逐条归属：可回看 → B1–B3；`[n]` 参数 → B2/B4；只读 → B5/D5；无悬空条目 | 本文件 §1–§3 |
| ② | 系统覆盖 | ✅ 受影响：`packages/ops-extension/src/commands.ts`（+可能的新收窄模块）、`packages/ops-extension/test/`、`README.md` 命令表、runtime 探针；上游依赖：omp `registerCommand`/`sessionManager.getBranch`；**无关**：`@ops-pi/core`、Yuyi 适配器、御符、vault、SshPool。对照 `architect-knowledge/reference/dsh-suite-architecture-map.md`：本仓为单仓 omp 扩展，不涉套件其他系统的接口变更 | E7/E12；矩阵 §19 |
| ③ | 证据覆盖 | ✅ 关键结论全部带 `文件:行` 或实测编号（E1–E12）；含踩点回源三要点：**getBranch 零生产调用**、**custom entry 不进 LLM 上下文与转录**、**A4 判据原文** | 见 §10 证据表 |
| ④ | 风险覆盖 | ✅ 六类已过：兼容（omp 升级致 `getBranch` 语义/字段漂移 → 启动期断言 E4 + 探针复跑）／异常（`getBranch` 抛错或返回非预期 → 命令 fail-soft 显示错误，不崩）／灰度（无：纯新增）／缓存（无：实时读分支）／消息与状态机（无自有状态）／安全（数据可见性 B9/D2、T3） | E4/E5；§2/§3 |
| ⑤ | 验证覆盖 | ✅ 单测（收窄/参数/格式化）+ runtime 探针（持久会话内执行命令，断言行数与字段）+ 回归（现有 11 探针 + `npm test`）+ 监控（空态/错误态显式）+ 回滚（删注册即回滚）；「如何算完成」= B1–B9 全绿，其中 B4 依赖 T1 | §1；`packages/ops-extension/test/runtime/` |
| ⑥ | 不确定性治理 | ✅ 5 条待确认（T1–T5，含知识漂移）显式登记，均给建议默认值，**未擅自补全** | §6 |

### 8.1 prd-digest 五问准入

| # | 问 | 答 |
|---|---|---|
| 1 | 问题与方案是否匹配 | ✅ 问题：A4 要求「当前分支内可读」但**无读取路径**（E3/E11）；方案：加只读回看命令 —— 问题找方案 |
| 2 | 价值依据 | ✅ 现需人工 `grep` 会话 JSONL（E11）才能回答「这条被拒是哪个层拒的、授权来源是什么」；命令把同一数据做成一次调用可读，且不新增权限面 |
| 3 | 范围是否受控 | ✅ 单命令 + 收窄纯函数 + 单测 + README 一行；7 条不做项显式排除聚合/过滤/存储/注入 |
| 4 | 是否复用既有能力（Reuse → Extend → Build） | ✅ **Reuse**：`registerCommand`/`ui.notify`（E12）、`sessionManager.getBranch`（E4 已断言）、`ops_audit` 既有字段（E1/E2）。**不 Extend 宿主**、**不 Build 新机制**；Build 仅限格式化纯函数 |
| 5 | 验收是否可逆/可回滚 | ✅ 删除命令注册即回滚；无持久化副作用（新增一条自审计条目，B6） |

## 9. 准入结论

**有条件通过（Conditional Pass）。**

- 六项覆盖齐备，无阻断项；五问通过；
- **停止条件**：T1–T5 未清前**不得进入 architect-design**（按 `architect-prd-digest` 停止条件：不得带未知进入设计）。T1 直接决定验收判据 B4 的形状，须优先拍板；
- 本文件为**自报**产出，落定以主人确认为准（AGENTS.md 纪律 1）。

## 10. 证据表（踩点回源）

| # | 结论 | 来源（`文件:行` / 实测编号） |
|---|---|---|
| E1 | 工具路径审计写入点与字段：`tool, toolCallId, isError, ts, authz, reasonClass, reason`（`authz` 取 `details.authz`，被拒记 `blocked`） | `packages/ops-extension/src/hooks.ts:90-107` |
| E2 | 只读命令**自落审计**（命令路径不产生 `tool_execution_end`）：`/ops-inspect` 写 `{tool:"ops-inspect",host,isError,ts,authz:"read"}`，`/ops-health` 同构 | `packages/ops-extension/src/commands.ts:79-80,88-89` |
| E3 | **`getBranch` 零生产调用**：全仓 `src/` 仅 3 处引用，全在启动期能力断言（`platform.ts:38,69,73`），**无任何读取审计条目的调用点** → 审计当前只写不读 | `grep -rn "getBranch" packages/*/src/` = 仅 `platform.ts` |
| E4 | `getBranch` 属启动期硬失败断言项：缺失即抛错拒启（非降级） | `packages/ops-extension/src/platform.ts:73-76`；`test/platform.test.ts:62-65` |
| E5 | **custom entry 不进 LLM 上下文、也不进展示转录**；`getBranch(fromId?)` 仅回溯当前 leaf 路径；`appendEntry` 返回 void | 方案 §3 O17（引 omp `src/session/session-manager.ts:2622,2466-2469`、`src/session/session-context.ts`）；`docs/reports/pi-vs-omp-host-capability-matrix.md` #17/#18 |
| E6 | **A4 判据原文**：「每一次 `ops_*` 调用（含被拒绝的）在会话分支留下 `ops_audit` 条目，含工具名、输入、结果状态、时间戳、授权来源；拒绝条目须可辨层级（`layer` 字段…）；**当前分支内可读**」 | `docs/requirements/ops-pi-requirement-package.md` §1 A4 |
| E7 | 命令 handler 直调、**不经** `tool_call`/`tool_result` → 危险动作不注册命令；镜像地，只读命令须自落审计 | 方案 O19 + §7.7；`commands.ts:104-105`（`/ops-status` 后注释：「危险场景不注册命令」） |
| E8 | 分支内可读性**实测**：`turn_end` 读 `getBranch()`，分支中 `ops_audit` 条目数 = 1，`layer` 字段保留 | 方案 §3.1 **X18**；探针 `docs/reports/probes/v42-layer-audit-probe.ts` |
| E9 | 被 `tool_call` 阻断的调用**无 `tool_result`**（序列 `tool_call → tool_execution_start → tool_execution_end`）→ 审计必须覆盖「执行 + 拒绝」两类 | 方案 §3.1 **X11**；方案 §7.8 说明 |
| E10 | 当前实现**无 `layer` 字段**：拒绝层级以 `reasonClass`（`ERR_PERMISSION`/`ERR_POLICY`，按原因文本前缀分类）+ `reason` 原文表达 | `grep -rn "layer" packages/ops-extension/src/` 零命中；E1 字段表；方案 §7.4.5「按前缀分类」 |
| E11 | 现状回看手段 = 人工 `grep` 会话 JSONL（runtime 探针即如此取证） | `packages/ops-extension/test/runtime/05-service-policy.sh:147-152` |
| E12 | 只读命令先例与展示通道：`/ops-inspect`、`/ops-health`、`/ops-status` 经 `cmdCtx.ui.notify(...)` 输出；README 有「斜杠命令（只读）」表 | `packages/ops-extension/src/commands.ts:44-100`；`README.md`「斜杠命令（只读）」 |
