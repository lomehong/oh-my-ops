# 可执行技术方案：`/ops-audit [n]` 审计回看命令

```yaml
---
title: /ops-audit [n] 审计回看命令——只读读取面与收窄格式化纯函数
status: 草稿
requirement: docs/requirements/ops-audit-requirement-package.md（OPSAUDIT-1，已落定 781cef8）
author: omp-architect（omp_1c3610f27a3f）
created: 2026-09-14
review:
  score: 0
  conclusion: 待评审
---
```

## 0. 一句话与五问速答

| 五问 | 速答 |
|---|---|
| 改哪里？ | `packages/ops-extension` 内新增 `src/audit-view.ts`（收窄/参数/格式化纯函数）+ `src/commands.ts` 注册 `ops-audit` + `README.md` 命令表一行 + `test/audit-view.test.ts` 与 runtime 数据面探针 |
| 为什么改？ | A4 判据要求「当前分支内可读」，现状审计条目只写不读（E3 零读取调用点、E11 只能 grep 会话 JSONL） |
| 影响谁？ | 仅本仓 ops-extension 单包；宿主 API 零新增依赖（`registerCommand`/`ui.notify`/`getBranch`/`appendEntry` 全在既有已断言面）；无跨系统接口变更 |
| 如何验证？ | bun 单测（参数/收窄/格式化 16+ 用例）+ runtime 数据面探针 + `npm test`/`typecheck` 全绿 + 交互会话人工冒烟 `/ops-audit` |
| 还有什么没有确认？ | 2 条（U1 条目信封平台级时间戳字段未验证——设计不依赖；U2 交互端到端冒烟依赖人工执行），均不阻断 |

## A. 架构链路分析（前置）

### A.1 读取链路（新增）

```
用户输入 /ops-audit [n]
  → omp 命令派发（命令 handler 直调，不经 tool_call/tool_result，O19/E7）
  → commands.ts 注册的 handler(args, cmdCtx)
      1. parseAuditLimit(args)            ─ 纯函数（T1 定案口径）
      2. cmdCtx.sessionManager.getBranch() ─ 仅回溯当前 leaf 路径（E5）
      3. toAuditViews(entries)             ─ 纯函数收窄 unknown[] → AuditView[]
      4. formatAuditReport(views, …)       ─ 纯函数倒序切片 + 行格式化
      5. cmdCtx.ui.notify(report)          ─ 展示通道（T2 定案；不进 LLM 上下文/转录，E5/B9）
      6. pi.appendEntry("ops_audit", …)    ─ 命令自审计（B6/E2 先例；先读后写）
```

### A.2 数据面（既有，本方案不改）

三个既有写入点全部落 `data.ts`（ISO 字符串），读取排序以此为唯一时间基准：

| 写入点 | 条目字段 | 证据 |
|---|---|---|
| `tool_execution_end` 钩子（工具路径） | `tool, toolCallId, isError, ts, authz, reasonClass?, reason?` | `hooks.ts:90-107` |
| `/ops-inspect`、`/ops-health` 自审计（命令路径） | `tool, host, isError, ts, authz:"read"` | `commands.ts:79-80,88-89` |
| health 自动轮询（受管定时器） | `tool:"ops_health_poll(auto)", host, isError, ts, authz:"read"` | `hooks.ts:52-58` |

**条目信封形状（实证）**：`getBranch()` 返回条目为 `{type:"custom", customType:"ops_audit", data:{…}}`——判型用 `type`/`customType`，字段在 `data` 下（`docs/reports/probes/v42-layer-audit-probe.ts:28-29` 实测取数路径）。

### A.3 影响面与降级

- **波及面**：单包新增，无删改既有行为；`hooks.ts`/既有命令写入侧不动（B8）；`@ops-pi/core` 不动。
- **缺席降级**：vault/Yuyi/御符/SshPool 任一缺席不影响本命令（读取纯本地分支，A5 降级收敛成立）；`getBranch` 缺失在启动期已硬失败（E4），命令路径不会遇到静默缺失。
- **守卫纪律/访客可见性红线**：本变更不涉及会话/渠道/活动视图的访客面——不适用（输出仅达交互 UI，不进 LLM 上下文与转录，B9/D2；红线不适用已显式声明）。
- **一致性边界**：无自有状态、无缓存、无跨会话聚合（D1 排除）；读即分支当下快照。

### A.4 Gap Analysis（Reuse / Extend / Build）

| 判定 | 对象 | 依据 |
|---|---|---|
| **Reuse** | `registerCommand` / `ctx.ui.notify` / `sessionManager.getBranch` / `pi.appendEntry`（E4 启动断言 + E12 命令先例）、`@ops-pi/core` 的 `LOCAL_HOST`、README 命令表 | 平台面全部已声明（`types/vendor-platform.d.ts:68-78,122-163`）且既有三条命令实证同款用法 |
| **Extend** | 无 | 平台无「审计读取」扩展点可挂（E3 零调用点）；本仓亦无既有格式化/收窄代码可扩展（全仓唯一审计面=写入侧） |
| **Build** | 仅 `src/audit-view.ts` 三个纯函数（`parseAuditLimit`/`toAuditViews`/`formatAuditReport`） | 读取面从零存在；需求包 Do 明示「收窄函数须可单测」→ 独立模块是最小新建面，无可复用替代 |

## 1. 需求覆盖（10 分）

### Do（做）

| # | 需求条目 | 方案响应 | 来源 |
|---|---|---|---|
| 1 | 命令可发现、可用（B1） | `pi.registerCommand("ops-audit", { description, handler })`，与既有三条命令同注册点 `registerOpsCommands` | 需求包 B1 |
| 2 | 读取面正确（B2） | `getBranch()` → `toAuditViews` 判型 `type==="custom" && customType==="ops_audit"` → 展示层按 `data.ts` 倒序取最近 n（默认 20） | B2/E5 |
| 3 | 字段呈现完整不臆造（B3） | 每行含 `ts/tool/authz(ok\|blocked)`，`reasonClass/host/reason` 有则显示无则 `-`；缺失不补默认语义（`AuditView` 字段类型即 `T \| undefined`） | B3/E1/E2 |
| 4 | 参数处理明确（B4） | `parseAuditLimit`：空→20；正整数→n；`0/负数/小数/非数字`→明确错误不输出条目；`n>200`→取 200 并提示「已截断至 200 条上限」（T1 定案） | B4/T1 |
| 5 | 只读无副作用（B5） | handler 路径零写操作（唯一写入=自身审计条目，B6）；不注册危险动作命令（D5/E7） | B5/D5 |
| 6 | 自审计一致（B6） | handler 末尾 `pi.appendEntry("ops_audit", { tool:"ops-audit", isError, ts, authz:"read" })`——**先读后写**：本次输出不含本次条目，语义与 inspect/health 先例一致 | B6/E2 |
| 7 | 空态与边界显式（B7） | 无条目 → `本会话无审计条目`；头部固定声明可读范围=`当前会话分支 leaf 路径`（RR-2/E5） | B7 |
| 8 | 无回归（B8） | 写入侧零改动；新增单测 + runtime 数据面探针；`npm test` + `typecheck` 全绿（N2 前置：先 `npm install`） | B8 |
| 9 | 不扩大 LLM 可见面（B9） | 不 `registerTool`、不改 `buildomoSystemPrompt`、不注入上下文；输出仅 `ui.notify` | B9/D2/E5 |
| 10 | 收窄函数集中可单测（Do 项） | 独立模块 `src/audit-view.ts`，三个导出纯函数，不依赖运行时上下文 | 需求包 §2 |

### Don't（不做，显式排除）

| # | 排除项 | 排除原因 |
|---|---|---|
| 1 | 跨会话/跨分支/跨设备聚合（D1） | `getBranch()` 仅 leaf 路径；范围外 |
| 2 | 审计注入 LLM/新增工具/改 systemPrompt（D2/B9） | 安全面扩大，违背 A4「仅留痕」定位 |
| 3 | 过滤/搜索/分页/导出（D3/T4） | v1 只做「最近 n 条」；T4 定案不做 |
| 4 | 不可变存储/外部审计系统对接（D4） | 方案 §6 范围外 |
| 5 | 危险动作命令（D5） | 命令路径绕过审批三层（E7） |
| 6 | 改写入侧字段 schema/补 `layer`（D6/T5） | 本需求只读既有数据；A4 漂移另立议题 |
| 7 | 自研截断/落 artifact（D7/T1） | 行上限（200/160）约束替代；宿主 spill 不覆盖 notify 通道 |

### To Confirm（待确认）

| # | 待确认项 | 问谁 | 状态 |
|---|---|---|---|
| 1 | T1–T5 全部 | 主人 | **已定案**（owner-decision，34f4c73；评审双方法采信，OPSAUDIT-1 已落定 781cef8） |

## 2. 系统覆盖（10 分）

| 服务/插件/仓库 | 变更类型 | 关键依赖 | 缺席降级影响 |
|---|---|---|---|
| oh-my-ops `packages/ops-extension` | 增（`src/audit-view.ts`、`test/audit-view.test.ts`、`test/runtime/12-ops-audit.sh`）+ 改（`src/commands.ts` 注册装配、`README.md` 表） | omp `registerCommand`/`ExtensionContext.ui.notify`/`sessionManager.getBranch`/`appendEntry`（`types/vendor-platform.d.ts:68-78,122-163` 全部已声明并启动期断言） | 宿主 API 缺失 → 启动期硬失败拒启（E4），不静默降级 |
| oh-my-ops `packages/ops-core` | 不动 | — | — |
| omp 宿主（18.1.18） | 不动（纯消费既有 API） | — | omp 升级漂移风险见 §4 兼容行 |
| dsh 套件其他系统 | 不动 | — | — |

- 范围外参与方：无（读取面为本地会话分支，无网络/无跨进程）。
- 对照 `architect-knowledge/reference/dsh-suite-architecture-map.md` 核对结论：该图未收录 oh-my-ops（本仓为 ops-pi 试点新建单仓 omp 扩展，ops-pi 需求包 D6）；本变更无套件内跨系统接口，无遗漏声明。

## 3. 证据覆盖（10 分）

| 关键结论 | 证据类型 | 证据出处 | 核对人 |
|---|---|---|---|
| 审计只写不读（问题成立） | Code | `grep getBranch packages/*/src/` 仅 `platform.ts:38,69,73` 启动断言；E3/E11 | dsh 独立评审亲验 + 本方复核 |
| 平台命令面可用 | Code | `types/vendor-platform.d.ts:146-149`（registerCommand 签名）、`:70-75`（ui.notify）、`:77`（getBranch: unknown[]）、`:150`（appendEntry） | 本方案复核 |
| 条目信封形状 `{type,customType,data}` | Code+实测 | `docs/reports/probes/v42-layer-audit-probe.ts:28-29`（X18 取数路径） | 本方案复核 |
| 三写入点均含 `data.ts`（排序基准） | Code | `hooks.ts:56`、`hooks.ts:52-58`（auto-poll）、`commands.ts:80,89` | 本方案复核 |
| 命令路径自落审计先例与 notify 通道 | Code | `commands.ts:79-80,88-89`；README「斜杠命令（只读）」表（`README.md:172-178`） | dsh 亲验（E2/E12） |
| custom entry 不进 LLM 上下文/转录 | Architecture | 方案 O17（omp `session-manager.ts:2622,2466-2469`）；E5 | dsh 亲验（E6 关联） |
| 命令 handler 直调不经审批三层 | Architecture | 方案 O19 + §7.7；E7 | 需求包评审已过 |
| getBranch 启动期硬失败 | Code | `platform.ts:73-76`；`platform.test.ts:62-65`（E4） | dsh 亲验 |
| T1–T5 定案口径 | Business | 台账 owner-decision（34f4c73）；评审记录 §3 | 主人（一级） |
| 业务意图「可回看/只读/[n] 参数」 | Business | 需求包 §0/§1（主人候选 A 原话归属） | 主人（需求包已落定） |

> 四层装载记录：业务层=需求包（已落定）+ `meta/index`（边界无冲突）；架构层=`dsh-suite-architecture-map`（未收录本仓，无跨系统面）+ `suite-federation-principles`（降级收敛约束已用于 §A.3）；系统层=本仓 README/源码/类型声明（上表）；基建层=omp 扩展契约（`practice/omp-extension-contract-pitfalls.md`：坑 2 确认审计挂 `tool_execution_end` 语义与本命令无冲突；命令路径不产生该事件 → 自审计必要性与 E7 一致）。未发现知识与代码冲突，无漂移项。

## 4. 风险覆盖（10 分）

| 风险类 | 有无涉及 | 分析与对策 |
|---|---|---|
| Compatibility 兼容 | 有 | omp 升级致 `getBranch` 信封/字段漂移 → 启动断言挡 API 缺失（E4）；形状漂移时收窄函数零匹配 → 输出空态（显式可见，非静默错）；升级后按 `practice/omp-extension-contract-pitfalls.md` 复跑入口 + runtime 探针复验。字段新增（如未来补 `layer`）对读取面向后兼容（多字段忽略） |
| Exception 异常 | 有 | `getBranch` 抛错/返回非数组 → try/catch fail-soft：`notify(error, "error")` + 自审计 `isError:true`，不崩会话；`data.ts` 缺失/非法 → 排序按分支序兜底、呈现 `-`（不臆造） |
| Cache 缓存 | 不涉及 | 实时读分支，无缓存层 |
| MQ 消息 | 不涉及 | 无消息面 |
| State 状态机 | 不涉及 | 命令无自有状态；分支为唯一事实源 |
| Security 安全 | 有（轻度，评审已过） | 只读（B5）、不注入 LLM（B9/D2）、`host/reason` 原文展示不遮蔽（T3 定案，同分支本人数据）；输出行不包含令牌/凭据（审计条目 schema 本就无凭据字段，E1/E2） |

## 5. 验证覆盖（10 分）

| 验证手段 | 内容 | 可执行入口 |
|---|---|---|
| Unit 单测 | `test/audit-view.test.ts`：`parseAuditLimit`（空→20 / 5→5 / 0、负、小数、非数字→错误 / 201→200+truncated）；`toAuditViews`（非 custom 剔除 / 非 ops_audit 剔除 / 字段缺失留 undefined / 保序）；`formatAuditReport`（空态 / 倒序切片 / 缺字段 `-` / reason 单行化+160 截断 / 头部范围声明与截断提示） | `npm test`（bun；N2 前置 `npm install`） |
| Contract 契约 | 信封判据与字段面锁定在单测断言（判型 `type/customType`、取数 `data.*`）；平台面由 `platform.test.ts` 既有断言守护 | `packages/ops-extension/test/audit-view.test.ts` |
| Regression 回归 | 既有 11 支 runtime 探针 + 167 用例全绿；写入侧 diff 为零（review 抽查 `git diff 9142a43..HEAD -- packages/ops-extension/src/hooks.ts` 应为空） | `npm test`；`bash packages/ops-extension/test/runtime/01..11` |
| Monitoring 监控 | 空态/错误态显式输出（B7 + fail-soft）；命令自审计条目可被自身回看（下次调用可见 `ops-audit` 条目，B6 闭环可观测） | 交互会话 `/ops-audit` 两次，第二次应见第一次的自审计条目 |
| Rollback 回滚 | 删除 `registerOpsCommands` 中 `ops-audit` 注册块即回滚；无数据迁移、无状态残留（需求包 §2） | git revert 单提交 |

**runtime 数据面探针（`test/runtime/12-ops-audit.sh`）**：模式照抄 05（真实 omo 会话触发审计后读持久化分支）；断言=探针内调 `toAuditViews(sessionManager.getBranch())` 返回条目数 ≥1 且 `tool/ts/authz` 字段可辨。**交互端到端不进自动化**：命令由用户输入触发（O19/H4），`-p` 非交互不触发——UI 面由 formatAuditReport 单测覆盖 + 人工冒烟一次（验收清单项，U2）。

## 6. 不确定性治理（10 分）

| # | 类型 | 描述 | 处置 |
|---|---|---|---|
| U1 | Unknown | `getBranch` 条目信封是否携带平台级时间戳字段（如 `entry.timestamp`）未验证 | **不依赖**：排序唯一基准=`data.ts`（三写入点全覆盖，实证）；缺失时按分支序兜底。设计无需行动 |
| U2 | Unknown | 交互端到端（真实 TUI 输入 `/ops-audit` 看 notify 渲染）无法自动化 | 登记「待验证」：实现落定后人工冒烟一次，结果回填台账 evidence；不阻断方案评审 |
| — | Human Decision | T1–T5 口径 | 已定案（owner-decision 34f4c73，OPSAUDIT-1 已落定） |
| — | Conflict | 无（四层装载未发现知识与代码冲突） | — |

## 7. 任务拆解（落定后填）

待 architect-review 通过、主人确认后按 `scripts/task-ledger.mjs` 任务面拆解（预期单实现任务：ops-extension 收窄模块 + 命令注册 + 单测/探针 + README；可验收条目对齐需求包 B1–B9）。

## 8. 决策门记录

| 命中门 | 决策 | 决策人/时间 |
|---|---|---|
| Unknown | U1/U2 均不阻断，设计内消化 | omp-architect（本方案） |
| Conflict | 未命中 | — |
| Business Trade-off | 未命中（T1–T5 已定案） | 主人（2026-09-14） |
| Cross-team Commitment | 未命中（单仓单包，无跨系统） | — |
| Compliance | 未命中（安全/合规轻度评审已在需求准入通过，边界 B9/D2 方案内保持） | 需求包 §7 |
| High-risk Change | 未命中（纯新增只读命令，无生产变更面） | 需求包 §7 |
