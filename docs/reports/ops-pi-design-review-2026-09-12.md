# 评审结论：OpsPi — 基于 pi (earendil-works/pi) 的运维智能体架构设计 v1.4

- 评审对象：`docs/designs/ops-pi-architecture-design.md`（v1.4，2026-09-12，状态「设计评审」，1210 行）
- 评审类型：方案评审（architect-review，流水线阶段 8/9 独立视角）
- 评审日期：2026-09-12
- 评审环境：oh-my-pi `omp` **18.1.18**（`/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent`，含 TS 源码与 `dist/types`）
- 结论：**驳回（退回 architect-design）**

## 五问得分：4/10

| # | 五问 | 分 | 依据 |
|---|---|---|---|
| Q1 | 改哪里？ | **2/2** | §3.1/§4.1 精确到包与文件级目录树；§4.5 给全工具名；§8 分 5 个 Phase。范围为「新建 monorepo，无存量改造」 |
| Q2 | 为什么改？ | **1/2** | §1.1/§1.2 有背景与目标，但**无需求包来源**（无 Do/Don't/To Confirm、无来源条目号、无验收判据）；目标不可验收 |
| Q3 | 影响谁？ | **1/2** | §2.2 依赖方向、§4.6 共载约束、§7 安全层有交代；但缺影响面矩阵、缺席降级影响、并发/多 ops Agent 场景，未评估与宿主原生 approval 子系统及共享 EventBus 的交互 |
| Q4 | 如何验证？ | **0/2** | 仅 §8 的 Phase 目标与两条冒烟想法；无单测/契约/回归/监控/回滚的可执行入口，§6.3 回滚仅一句「LLM 决定回滚」 |
| Q5 | 还有什么没有确认？ | **0/2** | **全文无任何「未知/待验证/待确认」登记**；反而把未被证据支撑的内容写成断言（base pi v0.84.1 逐项源码核实、`yuyi-pi-extension.ts` 第 430/542 行、Yuyi 工具计数、A2A 注入路径） |

## 六维度得分：16/60

| 维度 | 分 | 依据（缺什么） |
|---|---|---|
| 需求覆盖 | **2/10** | 无需求包；无 Do / Don't / To Confirm 三列；§1.2 目标无验收判据 |
| 系统覆盖 | **4/10** | §2.1/§9 映射表较全，但漏 OMP 原生 approval 子系统（`approval` 字段 + `approvalMode` + `tool_approval_*` 事件）、扩展间唯一共享对象 EventBus、工具重名 last-wins 语义、`ReadonlySessionManager` 读写边界、`@qianji/core` 实际直依赖 |
| 证据覆盖 | **3/10** | 抽查 6 条「当前行为」断言，**4 条与 OMP 18.1.18 源码冲突**（见附表）；base pi 与 Yuyi 两类证据在本机不存在，无法回源 |
| 风险覆盖 | **5/10** | §6/§7 纵深防御有价值；但缺兼容风险（approval 档位交互）、回滚方案、并发与幂等、治理增强缺席时的降级定义 |
| 验证覆盖 | **2/10** | 无可执行验收清单、无契约/回归/监控入口 |
| 不确定性治理 | **0/10** | 无 Unknown / Conflict / Human Decision 登记；未被证实的内容被写成事实 |

**评分口径**：≥50/60 且无维度 ≤5 且五问全答（5/5）才具备通过条件。本方案 16/60，**5 个维度 ≤5**，五问 4/10，三项均不达标。

---

## 缺口清单（逐条可执行）

### P0-1 斜杠命令绕过整个安全门与审计链路（§4.9 + §4.4 + §7.5）

**证据**

- 斜杠命令分发直调处理器，不经工具管线：`src/session/agent-session.ts:6657` `command.handler(args, ctx)`。
- 扩展自己的 `pi.exec` 直起子进程：`src/extensibility/extensions/loader.ts:277-279` `exec() → execCommand`。
- `tool_call` / `tool_result` **只**在两条缝上发射：agent loop 的 arg-prep（`agent-session.ts:1709` → `#beforeToolCall` → `runner.emitToolCall`）与 `ExtensionToolWrapper.execute`（`wrapper.ts:213` / `:372`）。
- 无 `runTool`/`callTool`/`executeTool` API；`ctx.invokeTool` 是同名原生转发且**显式跳过审批门**（`runner.ts:560-596`）。

**影响**：§4.9 的 `/ops-deploy`、`runInspection()`、`runDeployPipeline()` 直接调 L1，**完全不过** §7.2 权限校验、§4.4 命令内容风控、§7.4 授权、§7.5 审计。`/ops-deploy <version> production` 是方案里风险最高的动作，恰好在防线之外。

**修改指引（推荐 (1)）**

1. 命令处理器不直调 L1：只做参数解析与提示，随后 `pi.sendUserMessage("/ops-deploy …")` 注入，危险动作一律经 `ops_*` 工具执行；
2. 或命令只保留只读聚合（`/ops-health`、`/ops-inspect` 只读），危险动作不注册命令；
3. 若坚持直调：命令内显式复用同一授权函数并自行 `pi.appendEntry("ops_audit", …)`，并在 §4.9 声明「这是绕过 `tool_call` 的第二条路径 + 等价审计保证」。

**验收**：`/ops-deploy` 全程在 session 分支留下 `ops_audit` 条目；非交互且无策略命中时被拒绝并返回 `[ERR_PERMISSION]`。

### P0-2 授权机制选错层：弃用宿主原生 approval，自研门存在 30s 能力倒退，并与已确认宿主适配冲突（§7.4）

**证据**

- OMP 原生能力齐备且**必须**由工具声明：`ToolDefinition.approval?: ToolApproval`（`extensions/types.ts:640-642`，注释「Defaults to `"exec"` when omitted」）；`resolveApproval()` 三级解析（工具档 → 用户 `tools.approval.<tool>: allow|deny|prompt` → `approvalMode` 档位比较），见 `src/tools/approval.ts:115-205`；模式 `always-ask|write|yolo`（`approval.ts:14`、`APPROVAL_MODE_MAX_TIER` `:37-41`）。
- 权限提升走 `ExtensionToolWrapper` 内**原生** UI `uiContext.select(prompt, ["Approve","Deny"])`（`wrapper.ts:333`），并有 `tool_approval_requested` / `tool_approval_resolved` 事件。
- 无 UI 且需审批 → **硬失败**（`wrapper.ts:315-325`：`Tool "…" requires approval but no interactive UI available.`）。
- `tool_call` handler 有 **30s fail-closed 上限**：`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`（`runner.ts:86`），超时返回 `{ block: true, reason: "…timed out after 30000ms" }`（`runner.ts:1470-1509`）。§4.4 在 hook 里 `await c.ui.confirm(...)` 一旦用户思考超 30s，**工具被判定超时并阻断**；而原生门用的 `uiContext.select` 不受该超时约束。
- 已确认知识冲突：`adapters/oh-my-pi.md`（status 已确认）规定 omp 侧合规/高风险门 = 「**强制 `ask` 主人确认 + 依赖宿主 approval-mode 权限门；不得静默放行**（降级收敛保守侧）」；§7.4 明写「该字段为 OMP 专有……ops-pi **不依赖它**，审批统一由本节 `authorize()` 承担」。

**修改指引**

- 每个 `ops_*` 工具声明 `approval`，用**函数式**按参数返档（OMP 一方工具同款：`grep`/`hub`/`ast_edit`/`computer`），例如 `ops_process_kill → "exec"`、`ops_ssh_upload → "write"`、`ops_log_tail → "read"`、`ops_service(action==="status") → "read"`。
- 删除 §4.4 的 `DANGEROUS_TOOLS` 授权分支与 §4.7 `policy.allow` 白名单，改由宿主 `approvalMode` + `tools.approval.*` 表达；`tool_call` 只保留**内容级拒绝**（`{block:true}`），不做交互确认。
- §7.4 的「交互弹窗 / 非交互策略授权」改写为「宿主 approval 档位 + 用户策略 + `tool_approval_*` 事件审计」。

**验收**：`omp --approval-mode always-ask -p` 下危险 ops 调用被拒且报错文案来自宿主；`write` 档下只读 ops 放行；交互态走原生审批；`tool_approval_requested` 可被外部观测。

### P0-3 `input` 事件返回契约错误 → §4.10 工具过滤代码不工作

**证据**：`InputEventResult = { handled?: boolean; text?: string; images?: ImageContent[] }`（`extensions/types.ts:1125-1132`）；消费侧 `runner.ts:1607-1614` 只读 `result.handled` / `result.text`。§4.10 返回的 `{ action: "transform"|"handled"|"continue" }` **无任何字段被消费**，等价于不干预（`"continue"` 值不存在）。`event.text` / `event.source` 字段本身正确。

**修改指引**：不干预 → `return undefined`；改写输入 → `{ text }`；吞掉输入 → `{ handled: true }`。同步删掉 §4.10 注块里「handler 必须返回 `{ action }`」的表述。

**验收**：输入含「巡检」时激活集被替换（`getAllTools()` 观测）；`event.source === "extension"` 注入消息不改工具集。

### P0-4 §7.2 御符权限门无法复用同一实例，且与 §9「间接复用」自相矛盾

**证据**

- 扩展间唯一共享对象是 `EventBus`（`main.ts` 单实例 → `loadExtensions(paths, cwd, eventBus)`）；**无**服务注册表、无 `pi.getExtensions()`、无跨扩展工具调用（`getAllTools()` 只回 `ToolInfo` 元数据）。
- 扩展模块按 per-entry `?mtime=<tag>` 加载以支持同进程重载 → **直接 `import` 兄弟扩展文件得到第二个模块实例**（第二个 `YufuProxy` / `YuyiBridge`）。`withHostGuard` 只围栏 `process.exit`/stdin，不做模块隔离。
- 官方适配器的「多进程主从锁」防的是跨进程 4009 风暴，**不防同进程重复 Hub 连接**。
- §9 写「`@qianji/core`……ops-pi 仅通过共载**间接**复用」，但 §4.1/§7.2 要求 ops-pi 自己的 `context.ts` 封装 `YufuProxy.ensureAuthenticated()` → 实际是**直接依赖 + 第二实例**。

**附加违规（原则级）**：`principle/suite-federation-principles.md` 显式降级三要素 + `practice/suite-build-lessons.md` 事故教训 3「无账本 L2 降级曾为放行，违反『降级不扩权』」——方案**从未定义** Yuyi 适配器/御符缺席时的行为。治理增强缺席必须收敛保守侧（危险工具全部拒绝 + UI 显式提示），方案该分支为空。

**修改指引（三选一，需主人决策）**

- (a) 权限来源改为 ops-pi 自己的配置清单，与宿主 approval 档位叠加，不依赖御符；
- (b) 经共享 `EventBus` 与适配器约定显式请求/应答协议复用鉴权 —— 需改第三方适配器，**命中 Cross-team 承诺门**；
- (c) 承认权限门是可选增强，写明「适配器缺席 = 全部危险 `ops_*` 拒绝 + `ctx.ui.notify` 显式提示 + 下次探测自动恢复」。

**验收**：适配器缺席冒烟 —— 危险 `ops_*` 全部拒绝且提示可见；适配器在场时校验通过；`omp` 进程内 Hub 连接数为 1。

### P0-5 §6.4 截断：数字错误，且先截断会使宿主 artifact 只存到截断后文本

**证据**

- 真实上限：`DEFAULT_MAX_LINES = 3000`、`DEFAULT_MAX_BYTES = 50 * 1024`（`src/session/streaming-output.ts:9-10`）——**行数是 3000，不是 2000**。
- 截断是**宿主集中行为**：`spillLargeResultToArtifact()`（`src/tools/output-meta.ts:724`）在 `tools.artifactSpillThreshold`（默认 50KB）超限时把全文存 artifact，并把内联替换为 head+tail（默认 20KB head + 20KB tail ≈ 1000 行）；包装覆盖**全部**扩展工具（`sdk.ts:2863-2869`、`session-tools.ts:553/1649/1721`）。
- 无 per-tool 放宽字段；唯一跳过途径是工具预先设置 `details.meta.truncation.artifactId`（bash/python/eval 经 OutputSink 走此路）。
- 反证 doc 的 v1.4 处理：`truncateHead` / `truncateTail` / `DEFAULT_MAX_BYTES` **确实**从包根可达（`src/tools/index.ts:73` → `src/index.ts:59`），v1.4 的移除动机不成立。

**修改指引**：删除 L1 的 `truncateOpsOutput()`（或仅保留给 L1 独立 CLI 场景），L2 直接返回完整结果交由宿主 spill；若要自截断，阈值对齐 3000 行，并**必须**先把完整文本写入 artifact 再截断。

**验收**：返回 5MB 日志的 ops 工具，内联变为 head+tail，且 artifact 内是完整文本。

### P1-1 schema 走的是 legacy/compat 分支，v1.4 的加固动机已被实证证伪

**证据**

- `pi.typebox` 是 OMP 自己的 shim：`{ ...OmpType, Object, Unsafe }`（`src/extensibility/legacy-typebox.ts:175`）。**OMP 包内未安装 `typebox` 包**。
- 官方注释一律标 legacy/compat：`pi-ai/src/types.ts:1300-1314`（「Canonical authoring uses ArkType」）、`custom-tools/types.ts:69-74`（「legacy/compat — arktype-authored tools are preferred」）、`hooks/types.ts:583`、`custom-commands/types.ts:26-31`。
- OMP 全部示例用 `pi.zod`（`examples/extensions/hello.ts:9`、`api-demo.ts` 等），一方工具用 omptype `type`；**无一处使用 `pi.typebox`**。
- 扩展内的裸 `typebox` / `@sinclair/typebox` 被 specifier 重映射到**同一个 shim**（`legacy-pi-compat.ts:929/1207-1209/2863-2877`）。
- **实测（`omp 18.1.18`）**：静态 `import { Type } from "typebox"` 与 `import { StringEnum } from "@earendil-works/pi-ai"` 均正常加载并注册工具 —— §4.11 v1.4「消除 OMP 部署下顶层静态值导入的加载风险」针对的是**不存在的危险**。
- **实测（tsc strict）**：`typebox` 包缺席时，§4.11 的 `import type { Type as TypeBoxType } from "typebox"` 报 `TS2307: Cannot find module 'typebox'` → 该片段隐含一个**方案未声明**的第三方依赖。ESM 下 `require("typebox")` 依赖 OMP 注入的 CJS `require` 全局（实测存在，但非规范 API）。
- 类型与运行时不符：`typebox: typeof TypeBox` 声明为 omptype 门面，运行值是带 `Object`/`Unsafe` 覆写的 wrapper —— TS 看不到覆写。

**修改指引**：确认只跑 OMP → 直接用 `pi.typebox.Type`（或 `pi.zod`），删掉双运行时分支与 `typebox` 依赖；确需 base pi → 先补 base pi 证据与依赖声明，并把 schema 收敛到 arktype/JSON-Schema 交集。§4.11 的 `StringEnum` 结论可运行（经 legacy shim 转发），但其 Google 不兼容的理由在 OMP 不成立（`pi-ai` Google 路径**偏好** `parametersJsonSchema`，可携带 `anyOf`/`oneOf`/`const`；真正会因 union 报错的是 xAI 根对象与 Cursor）。

### P1-2 「双运行时」目标与「部署目标 = OMP」自相矛盾，base pi 证据不可回源

**证据**：全盘搜索无任何 `@earendil-works/*` 包；全盘无 `yuyi-pi-extension.ts`；本机 `omp` 为 **18.1.18**（文档写 18.1.10）。§2.1 的「对照本机 base pi v0.84.1 源码逐项验证」在本环境**不可复核**，论证链断裂。

**修改指引**：二选一 —— 删除 base pi 兼容目标（推荐，与 §1.3 一致，可一并去掉 §4.11 的 `schemaType` 适配层）；或保留但登记为 Unknown，给出取得 base pi v0.84.1 源码的路径与复核计划。

### P1-3 `terminate: true` 不是契约字段（§4.4）

`ToolCallEventResult = { block?: boolean; reason?: string; input?: Record<string, unknown> }`（`shared-events.ts:310-336`）；`terminate` 全源码无命中，会被静默忽略。修改：删除 `terminate`，中断用 `block`。

### P1-4 `ctx.setInterval` 的处理在 OMP 上是能力倒退（§4.4/§8/§9）

OMP **注入** `ctx.setInterval` 为受管定时器，`session_shutdown` 自动清理（`types.ts:501-509`、`runner.ts:1192`）。方案改用裸 Node `setInterval` + 手工清理，在部署运行时反而丢掉了宿主保证。修改：OMP 分支用 `ctx.setInterval`，仅在确证的 base pi 分支降级。

### P1-5 §7.3 内容风控覆盖面弱于宿主已有实现，误报面更大

OMP 已有 `CRITICAL_BASH_PATTERNS`（`src/tools/bash.ts:178-225`），覆盖 §4.4 `HIGH_RISK_CMD` **漏掉**的：`sudo rm`、`--no-preserve-root`、`chmod -R 777 /`、`chown -R … /`、`> /etc/passwd`、`tee /etc/sudoers`、`curl|bash` 及 `bash <(curl …)`、`nc -e`、`kill -9 1`、`cryptsetup`、`init 0`。反向：`HIGH_RISK_CMD` 的 `\brm\s+-rf\b` **无绝对路径锚点**，`rm -rf ./dist` 也弹窗 → 确认疲劳（`dsh-twin-pending-confirms` 同类教训）。修改：以 OMP 模式集为下界并加绝对路径锚点。

### P1-6 审计与跨会话追溯未用到宿主既有机制，且 `getBranch` 语义有坑（§5.7/§7.5）

`getBranch(fromId?): SessionEntry[]` 只回溯**当前 leaf 路径**，兄弟分支不可见；`pi.appendEntry` **返回 void**（拿不到 entry id）；`ReadonlySessionManager` 无 flush；custom entry 也不进展示转录（仅进 JSONL）。OMP 已有 `tool_execution_start` / `session_exit` 审计 custom entry、`user_todo_edit` 原生任务记忆、`experimental_context_notes`。修改：写明「同分支 leaf 路径可读」边界；评估复用 `tool_execution_*`；不可变审计另落 artifact/文件而非 session 树。

### P2 级

| # | 问题 | 修改指引 |
|---|---|---|
| P2-1 | 工具重名是**静默 last-wins**，不抛错（跨扩展取最后注册者：`runner.ts:getRegisteredTool` 逆序；`sdk.ts:3874` 注释 last-wins） | §8 Phase 0 的「确认两扩展工具名无冲突」改为**可执行断言脚本**：启动期用 `getAllTools()` 校验 `ops_*`/`yuyi_*`/`yufu_*` 前缀不相交且数量符合预期 |
| P2-2 | §4.8/§5.6 写 `pi -p`，部署运行时只有 `omp` | 统一改 `omp -p`；并注明 `-p` 无 UI 时需审批的档位会硬失败，无人值守须配 `approvalMode`/`tools.approval` |
| P2-3 | 全文**无依赖清单**（实测 `typebox` 缺包即 TS2307） | 补 package.json 依赖矩阵：`@ops-pi/core`、宿主类型、`typebox`（若保留）、`@qianji/core`（若直依赖） |
| P2-4 | 文档结构不符 `templates/executable-design.md` | 补 §0 五问速答、Do/Don't/To Confirm 三列、证据表（含核对人）、风险六类、验证五手段、不确定性治理表、决策门记录 |
| P2-5 | 目录约定漂移：当时为 `docs/design/`（单数），适配层规定「designs/reports/tasks 分目录」 | **后续已统一为 `docs/designs/`**；本评审报告落 `docs/reports/` |

---

## 附：证据回源表（抽查，当前行为以代码为准）

| # | 方案断言（节） | 判定 | 证据 |
|---|---|---|---|
| 1 | `input` handler 必须返回 `{ action: "transform"\|"handled"\|"continue" }`（§4.10） | **冲突** | `extensions/types.ts:1125-1132` `InputEventResult { handled?, text?, images? }`；`runner.ts:1607-1614` 只读 `handled`/`text` |
| 2 | `{ block, reason, terminate: true }`（§4.4） | **部分冲突** | `shared-events.ts:310-336` 无 `terminate` |
| 3 | 截断上限「约 50KB / 2000 行」（§6.4/§9） | **冲突** | `streaming-output.ts:9-10` `DEFAULT_MAX_LINES=3000`、`DEFAULT_MAX_BYTES=50*1024`；集中 spill 见 `output-meta.ts:724` |
| 4 | `approval` 为 OMP 专有且「ops-pi 不依赖它」（§7.4） | **冲突（决策）** | `extensions/types.ts:640-642` 默认 `"exec"`；`approval.ts:115-205`；`wrapper.ts:198-343`；且与 `adapters/oh-my-pi.md` 已确认规则冲突 |
| 5 | 顶层静态 `import { Type } from "typebox"` 在 OMP 会加载期失败（§4.11 v1.4） | **冲突（实证）** | 实测 `omp 18.1.18` 加载并注册成功；specifier 重映射 `legacy-pi-compat.ts:929/2863-2877` |
| 6 | `schemaType()` 双运行时适配（§4.11） | **可编译但依赖未声明** | tsc strict 实测：缺 `typebox` 包报 TS2307 |
| 7 | `ctx.sessionManager.getBranch()` 返回 `SessionEntry[]`（§5.7） | **成立** | `session-manager.ts:2622`；补充：仅当前 leaf 路径 |
| 8 | `pi.appendEntry(customType, data)`、`ctx.hasUI`、`confirm/notify`、`sendUserMessage({deliverAs})`、`registerCommand((args: string, ctx))`、`setActiveTools` 整体替换、`execute(toolCallId, params, signal, onUpdate, ctx)`、`ToolResultEvent.{toolName,input,isError}` | **成立** | `types.ts:1451-1452 / 467 / 267,279 / 1446-1449 / 1196-1200 / 1460-1464 / 655-661 / 988-993` |
| 9 | `pi.typebox`、`pi.logger` 在 OMP 存在（§1.3） | **成立** | `types.ts:1228-1229,1225-1226`；`loader.ts:156-157`；实测 `pi.typebox.Type === "object"`
| 10 | `--extension` 可重复、`-p` 存在、`--eval` 不存在（§4.8/§5.6） | **成立** | `omp --help`：`-e, --extension=<value> … (can be used multiple times)`、`-p, --print`；无 `--eval` |
| 11 | 「base pi v0.84.1 源码逐项核实」「`yuyi-pi-extension.ts` 第 430/542 行」（§2.1/§4.11） | **本机不可回源** | 全盘无 `@earendil-works/*`、无 `yuyi-pi-extension.ts` |

---

## 知识漂移登记

- **知识库条目 vs 代码：无漂移**（`architect-knowledge/` 内无 pi/OMP API 内部断言与源码冲突；`adapters/oh-my-pi.md` 关于「依赖宿主 approval-mode 权限门」的表述与 18.1.18 源码一致）。`review-queue.yaml` 保持为空。
- **方案 vs 已确认知识：有冲突 1 处** —— §7.4「ops-pi 不依赖宿主 `approval`」 ⨯ `adapters/oh-my-pi.md`「依赖宿主 approval-mode 权限门，不得静默放行」。按「先修方案，再回写知识」处理，本次只修方案（见 P0-2），无需回写知识库。
- **待蒸馏素材（建议入库，状态 `待审核`）**：本次产出的 OMP 18.1.18 扩展面实证（`approval` 语义与档位、`tool_call` 全局分发与 30s fail-closed、斜杠命令/`pi.exec` 不经工具管线、扩展间仅共享 EventBus 与 per-entry `?mtime` 双实例、TypeBox 为 legacy shim、截断常量与 artifact spill、工具重名 last-wins）。建议落 `architect-knowledge/reference/`（宿主事实类），入库前需主人确认。
- **本体不涉及联邦四原则的套件既有限制**；但方案违反**显式降级三要素**（治理增强缺席无定义），见 P0-4。

## 待主人确认事项（人工决策门，不静默放行）

| # | 门 | 待决内容 | 影响 |
|---|---|---|---|
| 1 | **Conflict** | 安全门用宿主 `approval`/`approvalMode`（已确认适配层规则）还是自研 `authorize()`？ | 决定 §4.4/§7.4 整段重写方向 |
| 2 | **Business Trade-off** | 是否保留 base pi 双运行时兼容目标？ | 决定删/留 `schemaType()` 与 `typebox` 依赖 |
| 3 | **Cross-team 承诺** | 若选 P0-4(b)（与 Yuyi 适配器约定 EventBus 协议复用鉴权），需第三方适配器配合 | 跨团队承诺，须主人拍板 |
| 4 | **High-risk Change** | 无人值守下的授权边界：允许自动执行的 `ops_*` 白名单、`approvalMode` 档位、自愈/部署是否允许无人工 | 决定 §7.4 与 §8 Phase 3/4 可落地性 |
| 5 | **Unknown（需求来源）** | 本方案无需求包来源；Do / Don't 需主人补（是否存在可引用的需求记录） | 需求覆盖维度无法评分达标 |
| 6 | 环境（流程侧） | `/workspace` **不是 git 仓库**（无 remote、无 `.gitmodules`），且无 `scripts/task-ledger.mjs`；「改动仓测试全绿 + 工作区干净」提交前纪律与任务台账痕迹当前**无法执行** | 需主人指示是否初始化 git / 提供台账落点 |

## 下一步

驳回 → 退回 architect-design。建议修订顺序：先答 #1/#2/#4 三个决策门 → 按 P0-1…P0-5 重写 §4.4/§4.9/§6.4/§7.2/§7.4 → 按 `templates/executable-design.md` 补结构（P2-4）→ 重新提交评审。

评审通过 **≠** 完成；本结论亦需主人确认方为落定。

---

# 勘误（2026-09-12 追加，主人指出方向错误后自查）

## 根因

本评审的**证据基准选错了**：我以本机唯一可得的 omp 18.1.18 源码为「标准」，判定方案的每一处 API 断言。但方案的原始要求是**基于上游 pi 扩展**。pi 与 omp 是**两个不同宿主**，API 面存在实质差异；用 omp 的契约去判 pi 的设计，把「pi 上正确」判成了「错误」。

当时我还把「base pi 与 Yuyi 适配器本机不可得」记为 *UNVERIFIABLE-LOCALLY* 就继续评分——正确做法是**先取得上游 pi 再评审**。上游 pi 一直在 npm 上（`@earendil-works/pi-coding-agent`，0.80.3–0.85.1），我在追加轮次中已实装解包取得全部权威证据（`dist/core/extensions/types.d.ts` + `docs/extensions.md`）。

## 逐条勘误

| 原结论 | 判定 | 事实（上游 pi 0.84.1 证据） |
|---|---|---|
| **P0-3** `input` 返回 `{action}` 是错误契约 | ❌ **误判** | `types.d.ts:639-647`：`InputEventResult = {action:"continue"} \| {action:"transform",text,images?} \| {action:"handled"}`。`{action}` **就是** pi 的契约；§4.10 的写法在 pi 上正确。真分歧在 omp（`{handled,text}`，无 `action`，无翻译层） |
| **P0-2** 自研 `authorize()` 与宿主机制重复，应全交宿主 | ❌ **误判（方向性）** | 上游 pi **没有审批子系统**：`ToolDefinition` 无 `approval` 成员，`approval`/`approvalMode` 在 pi 的 `dist/core` 与 `docs/` **零命中**；`docs/extensions.md:19` 把 "Permission gates (confirm before `rm -rf`, `sudo`)" 明确列为**扩展自己实现**的用例。→ 自研审批门在 pi 上是**必需**设计，v1.4 方向正确；我据此出的「D1=C 全交宿主」建议会把方案绑死在 omp |
| **P0-5** 截断常量错误（2000 应为 3000）、自截断有害 | ❌ **误判** | `docs/extensions.md:2138-2152`：**"Tools MUST truncate their output"**，内置上限 **50KB / 2000 行**，导出 `truncateHead/truncateTail/DEFAULT_MAX_BYTES/DEFAULT_MAX_LINES`。即 v1.4 的数字与做法**正是 pi 的规定**。3000 行是 omp 的常量。真冲突是「omp 有宿主级 spill」这一 omp 特性 |
| **P1-1** schema 走 legacy/compat 分支，v1.4 加固动机被证伪 | ❌ **误判** | pi 的 `docs/extensions.md` Quick Start 与「Available Imports」**官方就是** `import { Type } from "typebox"`。所谓"legacy/compat"是 omp 侧对自身 shim 的标注。且实测该写法在 omp 下同样加载成功（X1） |
| **P1-2** `StringEnum` 的 Google 理由在 OMP 不成立 | ❌ **误判** | pi 文档「Available Imports」明确写：`@earendil-works/pi-ai` — "AI utilities (`StringEnum` for Google-compatible enums)"。方案引用「官方 extensions.md」是**准确**的 |
| **P1-3** `terminate: true` 非契约字段 | ❌ **误判** | `types.d.ts:786` 与 `docs/extensions.md:765-766`：`{ block?, reason?, terminate? }`，且有明确语义（同批全部 terminate 才提前结束）。`terminate` **是** pi 契约 |
| **P1-4** `ctx.setInterval` 处理是能力倒退 | ✅ **原判正确** | pi 的 `ExtensionContext` 确无 `setInterval`（成员仅 `ui/mode/hasUI/cwd/sessionManager/.../getSystemPrompt`）。v1.4 用 Node 定时器在 pi 上是对的；`ctx.setInterval` 是 omp 增强 |
| **P0-1** 斜杠命令绕过审批与审计 | ✅ **成立** | pi 生命周期明示「extension commands checked first, **bypass if found**」（`docs/extensions.md:287`），命令处理器不经 `tool_call`。两宿主同理 |
| **P0-4** 御符门无法复用实例 + 无降级定义 | ✅ **成立** | pi 的 `ExtensionAPI`/`ExtensionContext` **无**跨扩展服务注册表、无 `getExtension`、无 `invokeTool`。两宿主都无 |
| **P1-5** 内容风控弱于宿主 | 🟡 **部分成立** | pi 无内置 `CRITICAL_BASH_PATTERNS`（该模式集是 omp 的）→ 自研内容风控在 pi 上必需；omp 的模式集可作下界参考 |
| **P1-6 / P2-1 / P2-4** | ✅ 成立 | `getBranch` 仅当前 leaf 路径；工具重名静默 last-wins；结构不符模板 |

## 结论变更

- **原结论「驳回（16/60）」中，五问 Q4/Q5 与六维度「需求/验证/不确定性」的判据成立**（方案确无需求包、无验证矩阵、无未知登记）——这部分维持。
- **「证据覆盖 3/10」的判据不成立**：该分主要来自上述 5 条误判。方案对 pi API 的核实实际相当扎实（v1.3 的「对照本机 base pi v0.84.1 逐项验证」经本轮复核，多项**确实正确**）。
- **新增的 omp 侧发现仍然有效**：`loadMode` 默认 `discoverable` 导致工具自身审批声明失效（X6/X7）、`tool_call` 30s fail-closed、审批默认 `yolo`、集中 spill——这些是**真问题**，但归属是「omp 适配层」，不是「核心契约」。
- **重评建议**：以 `docs/reports/pi-vs-omp-host-capability-matrix.md` 为基准，对方案 v3.0 重跑五问+六维度。修订后的关键评审点应是：**核心是否真正宿主中立**（静态可验证：omp 专有成员只出现在 `src/host/omp.ts`）、**跨宿主分歧处置是否完备**（D-A/D-B/D-C 三项）、**需求/验证/不确定性三维度是否补齐**。

## 教训（建议入知识库 `practice/`）

**评审前必须先确认「基准」是什么，再取基准方的证据；不得用"唯一可得"的实现替代"被评审对象声明的"基准。**

- 症状：只有一个实现可得（omp），就把它当契约标准 → 把 5 处 pi 正确写法判成错误。
- 正确动作：被评审对象声明了外部基准（上游 pi）时，**先取得该基准的可验证证据**（npm 实装 / 源码 checkout），再开始评分；取不到就**先标阻断**，而不是带着 UNVERIFIABLE 继续评分。
- 同类风险：任何「A 是 B 的分支/别名」的假设都需实测确认（本轮的 `PI_SCOPE_ALIASES` 重映射只说明 specifier 能解析，**不代表 API 面一致**——事实上有 3 处分歧）。

---

# 后续（2026-09-12）：平台决策最终落定

主人随后定稿：**运行时目标 = oh-my-pi（omp）**，理由是上游 pi 的扩展平台能力过于简陋（无审批子系统、无受管定时器、无输出 spill，schema 侧偏 legacy）。

对本次评审的影响：

1. **v4.0 方案已按此重写**（`docs/designs/ops-pi-architecture-design.md`）：撤销宿主适配层，直接依赖 omp 平台，并新增**平台能力前置校验**（区分「外部增强缺席 → 降级」与「平台能力缺失 → 硬失败」）。
2. **本评审中「用宿主审批」的方向被保留，但依据已更正**：v2.0 的结论基于错误基准（以为 pi 有审批子系统），v4.0 采纳同一做法是基于**平台已选定**且 omp 原生审批能力确实完备（判定顺序支持 `policy:"allow"|"deny"`，可表达目标级授权）。
3. **`loadMode` 发现成为必修项**（X4–X6）：omp 扩展工具默认 `discoverable`（挂 `xd://`，经外层 `write` 派发），使工具自身 `approval` 声明失效；必须显式 `loadMode:"essential"`。
4. **安全模型获端到端实证**（X8）：v4.0 注册骨架在**最严 `always-ask` + 非交互**下一次运行验证四分支全部符合预期——
   - `approval:"read"` → 执行（无人值守只读巡检可行）
   - `policy:"allow"` → 执行（Owner 预授权在 always-ask 下亦可放行）
   - `policy:"deny"` → 硬拒（生产禁止无人值守）
   - `override:true` → 硬失败（须 Owner 明示批准）
   复跑脚本：`docs/reports/probes/v4-skeleton-probe.ts`。

**当前状态（修订版 v4.0）**：`草稿`，可送 `architect-review` 复评。复评基准 = omp 18.1.18 实装证据 + `docs/reports/pi-vs-omp-host-capability-matrix.md`；重点核查**需求/验证/不确定性三维度是否补齐**（早期判据成立）、**平台能力前置校验是否覆盖全部平台依赖**、以及 §7.4 三层分工是否无绕过路径。**通过仍需主人确认。**
