# 可执行技术方案：omo — 基于 oh-my-pi（omp）的运维智能体

```yaml
---
title: omo — 基于 oh-my-pi（omp, pi 血统 harness）的运维智能体扩展
status: 已落定          # 草稿 → 已评审 → 已落定 → 已执行（主人 2026-09-12 确认）
requirement: docs/requirements/ops-pi-requirement-package.md
author: 架构师会话（2026-09-12）
created: 2026-09-12
supersedes: v1.4 / v2.0 / v3.0 / v4.0 / v4.1 / v4.2（版本演进见附录 B）
review:
  score: 56             # v4.1 修复后自评预估（56/60）；v4.0 实评 48/60
  conclusion: 通过（主人 2026-09-12 确认落定）
  trail: v4.0 驳回(48/60) → v4.1 修复 R-1/R-2/R-4/R-5/R-6 → 独立复评① 复现修复+提出 N-1..N-4 → v4.2 修订 → 独立复审② 升级N-1/修正N-2/确认N-3/判定N-4有解 → v4.3 定案
  confirmedBy: 主人
  confirmedVia: 会话确认（2026-09-12）
---
```

> **v4.3 定位（宿主决策落定 + 两轮独立复审定案）**：主人 2026-09-12 定稿——**运行时目标 = oh-my-pi（omp）**，理由是上游 pi 的扩展平台能力过于简陋（无审批子系统、无受管定时器、无输出 spill、schema 侧偏 legacy）。本版以 **omp 18.x 为唯一平台**，直接使用其原生能力，删除为「双宿主/宿主中立」而设的适配层与折衷。
> **评审轨迹**：v4.0 经 architect-review 得 **48/60 驳回** → v4.1 修复 R-1/R-2/R-4/R-5/R-6 → **独立复评第一轮**（隔离会话 + 独立探针）复现三项修复全部成立并新发现 N-1～N-4 → v4.2 修订 → **独立复审第二轮**（新探针）**升级 N-1、修正 N-2、加重确认 N-3、判定 N-4 有解**，并附发现「`approval` 被求值 3 次」→ **v4.3 定案 N-1（default-deny 在钩子前短路）与 N-4（结果文本携带原因）**。报告：`docs/reports/ops-pi-review-v4-2026-09-12.md`、`independent-recheck-2026-09-12.md`、`independent-recheck-2-2026-09-12.md`。
> **证据基准**：omp `@oh-my-pi/pi-coding-agent@18.1.18` 实装源码（`/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent`）。宿主能力对照与逐条出处见 `docs/reports/pi-vs-omp-host-capability-matrix.md`（该矩阵保留为决策依据与升级复核清单）。

---

## 0. 一句话与五问速答

**一句话**：在 omp 上扩展一套运维智能体——无人值守完成只读巡检、对「指定服务」执行重启，高危敏感操作须 Owner 明示批准，全过程留审计；安全与效率机制尽量复用 omp 原生能力而非自造。

| 五问 | 速答 |
|---|---|
| 改哪里？ | 新建 monorepo：`packages/ops-core`（L1，纯 Node，不依赖 omp）+ `packages/ops-extension`（L2，**omp 扩展**）；无存量改造 |
| 为什么改？ | 运维依赖人工与散落脚本，缺统一 Agent 化能力；可验收判据 = 需求包 §1 A1–A5 |
| 影响谁？ | omp 的工具注册面、**原生审批面**、会话审计面、输出 spill 面；共载的 Yuyi 适配器；被运维的目标主机/集群；Owner（审批责任） |
| 如何验证？ | §5 六手段，核心是**拒绝路径负测**与**平台能力契约断言**（含 `loadMode`、`approval` 档位、spill 行为） |
| 还有什么没有确认？ | 4 项：B1 Yuyi 身份接口（跨团队，阻断）、B2 目标仓/git、B3 目录命名、B4 Yuyi 适配器实际接口面 |

---

## 1. 需求覆盖（10 分）

### Do（做）

| # | 需求条目 | 方案响应 | 来源 |
|---|---|---|---|
| 1 | **基于 omp 扩展**（运行时目标落定） | L2 是 omp 扩展，规范导入 `@oh-my-pi/pi-coding-agent`（官方示例同款）；直接使用 omp 原生能力 | 主人 2026-09-12 决策 |
| 2 | 无人值守完成只读巡检 | 只读工具声明 `approval: "read"` → **三模式均自动放行**（含最严 `always-ask`），实测 X1/X8 | 需求包 A1 |
| 3 | 对「指定服务」执行重启 | 函数式 `approval` 按 `action` 返档 + L1 `targetPolicy` 校验「主机+服务名」允许清单 | 需求包 A2 |
| 4 | 高危敏感操作须 Owner 明示批准 | 函数式 `approval`：命中预授权 → `{policy:"allow"}`（任何模式放行）；生产目标 → `{policy:"deny"}`（任何模式硬拒，实测 X3/X8）；其余未授权 → **①-b 模式无关兜底拒绝**（无人值守，实测 X10）+ 交互态交平台弹窗 | 需求包 A3 |
| 5 | 全过程留审计 | `tool_result` 钩子强制 `pi.appendEntry("ops_audit", …)`，含授权来源 | 需求包 A4 |
| 6 | 增强缺席不阻断核心 | 每项外部增强（Yuyi/御符/vault）有显式降级分支，降级收敛保守侧；平台能力缺失则**启动期硬失败**（非静默） | 需求包 A5 |
| 7 | 共载 Yuyi 官方适配器，不自研通信 | L2 不注册 `yuyi_*`；同进程共载，工具名前缀不相交（启动期断言，防静默覆盖） | 需求包 N3 |
| 8 | 沙箱隔离弥补 harness 无内建权限系统 | 容器 + 挂载/网络策略；生产 docker.sock 不挂控制节点 | pi README「no built-in permission system」+ omp 同源 |

### Don't（不做，显式排除）

见需求包 §3 N1–N8。要点：不自研跨 Agent 通信；不在扩展内 import 第三方内部类复用其实例；**不造宿主适配层**（宿主即平台，直接依赖）；不用斜杠命令直调 L1 执行危险动作；不自研输出截断；不在 `tool_call` 内做长交互等待。

> **关于「直接依赖宿主平台」的合规性**：`architect-knowledge/principle/suite-federation-principles.md` 明文——**「对宿主（平台）的注入不受此限——那是平台，不是邻居」**。omp 是本方案的**平台**（不是套件里的兄弟插件），因此直接使用 `pi.approval`/`pi.zod`/`ctx.setInterval`/`loadMode` 等平台能力是正当的，无需为「平台中立」造抽象层。兄弟插件层面的耦合约束（Yuyi 适配器、御符）仍然适用，见 §7.6 与 N2/N3。

### To Confirm（待确认）

| # | 待确认项 | 问谁 | 状态 |
|---|---|---|---|
| 1 | Yuyi 是否提供「查询调用方御符身份/权限」的受支持接口（B1） | 主人中转向 Yuyi 方 | **阻断（跨团队）** |
| 2 | 目标仓库位置与 git 化（B2） | 主人 | 延后；先落 `/workspace` |
| 3 | ~~目录命名统一（B3）~~ | — | **已解决**：统一为 `docs/designs/`（适配层标准）；6 份文档交叉引用已同步更新 |
| 4 | Yuyi 适配器实际接口面与 `@qianji/core` 依赖（B4） | 共载冒烟 | Unknown |
| 5 | omp 最低版本承诺（本方案按 18.1.18 验证） | 主人/运维 | 待定；见 §4 兼容风险 |

---

## 2. 系统覆盖（10 分）

| 服务/包 | 变更类型 | 关键依赖 | 缺席降级影响 |
|---|---|---|---|
| `packages/ops-core`（L1） | 增 | Node.js 标准库、`ssh2`、`docker`/`kubectl` CLI。**不依赖 omp** | 不存在则 L2 无能力可注册（构建期依赖） |
| `packages/ops-extension`（L2） | 增 | omp 18.x 平台：`@oh-my-pi/pi-coding-agent`（类型）、`pi.zod` / `pi.typebox`（注入）、`pi.logger`（注入） | 不存在则无 `ops_*` 工具面 |
| **omp 宿主** | **不动**（平台） | — | 不可缺席。**启动期校验最低版本 + 必需平台能力**，缺失则报错退出（不静默降级） |
| **部署配置**：`approvalMode` | **约束**（非代码） | 扩展 API 无 settings 访问器（X14），**无法自检** | **禁止 `yolo`**（无人值守场景）：yolo 会关闭档位审批且忽略 `override`（X9）。安全属性不依赖它——由 §7.4 ①-b 模式无关兜底保证（X10）；该约束由部署规范落地 |
| Yuyi 官方适配器（共载） | **不动**（外部） | `@qianji/core` | **显式降级**：`yuyi_*` 消失 → 跨 Agent 入口关闭（含只读）；本地巡检/重启不受影响 |
| 御符（Yufu）身份 | **不动**（经 Yuyi） | Hub 可达 | **显式降级**：无身份源 → 跨 Agent 路径整体关闭；本地 Owner 路径不受影响 |
| vault（L1 内） | 增 | `OPS_VAULT_PASSPHRASE` | **显式降级**：未解锁 → 需 vault 的主机不可操作 + UI 提示；无凭据主机不受影响 |
| 沙箱运行时（容器） | 增 | Docker | 缺席降级为「进程级隔离」并在 UI 显式标注（不静默） |
| 目标主机/集群 | 被操作方 | SSH / kubeconfig | 不可达 → `CONNECTION_REFUSED` |

- **范围外参与方**：Yuyi 团队（需交付身份接口，B1）；omp 升级节奏（18.1.10→18.1.18 为本机实测跨距，升级后须按矩阵复核）。
- **对照 `architect-knowledge/reference/dsh-suite-architecture-map.md`**：本方案**不属 dsh 套件成员**，不引入套件包依赖，不受联邦四原则的**成员准入**约束；但**适用其显式降级三要素**（可发现/安全收敛/可恢复），见 §7.4.3。无遗漏声明。

---

## 3. 证据覆盖（10 分）

> 纪律：**当前行为以代码为准**。证据基准 = 本机 omp 18.1.18 实装源码；实测项 X# 为探针复跑结果。核对人 = 本次评审会话。
> 上游 pi 对照证据（P#）保留在矩阵文件中，本版仅引用结论。

| # | 关键结论 | 出处 |
|---|---|---|
| O1 | 扩展 API 注入 `typebox` / `arktype` / `zod` / `logger` 四个成员 | `src/extensibility/extensions/loader.ts:155-158`；`types.ts:1225-1235` |
| O2 | **原生审批子系统**：`ToolDefinition.approval?: ToolApproval`（省略默认 `"exec"`）；`approvalMode: always-ask\|write\|yolo`；用户覆盖 `tools.approval.<policyKey 或工具名>: allow\|deny\|prompt`；事件 `tool_approval_requested` / `tool_approval_resolved` | `types.ts:640-642`；`src/tools/approval.ts:13-14, 37-41, 115-214`；`wrapper.ts:296-343` |
| O3 | 审批判定顺序：工具 `policy:"deny"`（最优先短路）→ 用户策略（含 `deny`）→ yolo 分支 → 工具 `override` → 工具 `policy` → **模式档位比较**。`read` 档在三种模式下均自动放行 | `approval.ts:115-214`（`modeApprovesTier`） |
| O4 | **默认审批模式 `yolo`**（未显式配置即不生效）；无 UI 且需审批 → **硬失败**并给出三条出路 | `wrapper.ts:198-199, 315-325`；`session-tools.ts:702-706` |
| O5 | `ctx.setInterval` 为受管定时器，`session_shutdown` 自动清理 | `types.ts:501-509`；`runner.ts:1192` |
| O6 | `tool_call` handler **30s fail-closed**（超时返回 `{block:true}`） | `runner.ts:86`（`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`）；`runner.ts:1455-1509` |
| O7 | **宿主集中输出截断**：`DEFAULT_MAX_LINES=3000`、`DEFAULT_MAX_BYTES=50*1024`；超 `tools.artifactSpillThreshold`（默认 50KB）时**全文存 artifact**、内联换 head+tail（默认 20KB+20KB）；覆盖全部扩展工具；无 per-tool 放宽字段 | `src/session/streaming-output.ts:9-10`；`src/tools/output-meta.ts:724, 897, 933`；`src/sdk.ts:2863-2869` |
| O8 | **`loadMode` 默认 `discoverable`**（`ESSENTIAL_BUILTIN_TOOL_NAMES` 之外一律如此）→ 从顶层 schema 移除、挂 `xd://` 设备 / BM25 检索 | `src/tools/essential-tools.ts:23-47`；`types.ts:637` |
| O9 | `input` 事件返回 `{handled?: boolean; text?: string; images?}`，消费侧只读 `handled`/`text` | `types.ts:1125-1132`；`runner.ts:1607-1614` |
| O10 | `before_agent_start` 返回值 `{systemPrompt}` 声明 `string[]` 但运行时接受 `string`（`typeof === "string" ? [x] : x`），多 handler 链式 | `types.ts:1149-1152`；`runner.ts:1750-1761` |
| O11 | 工具重名**静默 last-wins**（跨扩展取最后注册者），不抛错 | `runner.ts` `getRegisteredTool` 逆序遍历；`sdk.ts:3874-3877` |
| O12 | 扩展间唯一共享对象 `EventBus`；扩展按 per-entry `?mtime` 独立加载（import 得**第二实例**）；`withHostGuard` 仅围栏 `process.exit`/stdin，不做模块隔离 | `src/main.ts`（单 `new EventBus()`）→ `loader.ts`；`legacy-pi-compat.ts`；`extensibility/utils.ts` |
| O13 | 规范导入 scope 为 `@oh-my-pi`（`CANONICAL_PI_SCOPE`）；官方示例统一 `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`；`@earendil-works/*`、`@mariozechner/*` 为兼容别名并被重映射到同一份内置运行时 | `legacy-pi-compat.ts:845-861, 852, 893`；`examples/extensions/hello.ts:6` |
| O14 | `pi.zod`（omptype 支持的 Zod 门面）支持 `object/string/number/boolean/optional/default/describe/enum`；官方示例统一使用 | `node_modules/@oh-my-pi/omptype/dist/types/zod.d.ts:37-89`；`examples/extensions/api-demo.ts:19-21` |
| O15 | `pi.typebox` 是宿主自建 shim（`{...OmpType, Object, Unsafe}`），官方注释标注为 legacy/compat；OMP 包内**未安装** `typebox` 包，裸 `typebox` specifier 被重映射到该 shim | `src/extensibility/legacy-typebox.ts:175`；`extensions/types.ts:1228-1235`；`custom-tools/types.ts:69-74` |
| O16 | 运行时 API 存在性：`registerTool`/`registerCommand`/`appendEntry`/`getAllTools`/`setActiveTools`/`sendUserMessage({deliverAs:"steer"\|"followUp"\|"aside"})`/`on("tool_call"\|"tool_result"\|"session_start"\|"session_shutdown"\|"before_agent_start")`/`ctx.hasUI`/`ctx.ui.confirm/notify`/`ctx.sessionManager`/`execute(toolCallId, params, signal, onUpdate, ctx)`；CLI `-e/--extension` 可重复、`-p`、`--mode text\|json\|rpc\|rpc-ui`、`--approval-mode`、`--auto-approve`；`--eval` **不存在** | `types.ts:455-509, 655-661, 1196-1200, 1446-1464, 1290-1300`；`omp --help` |
| O17 | `getBranch(fromId?): SessionEntry[]` 仅回溯**当前 leaf 路径**；`pi.appendEntry` 返回 void；custom entry 不进 LLM 上下文、也不进展示转录 | `src/session/session-manager.ts:2622, 2466-2469`；`src/session/session-context.ts` |
| O18 | 宿主已有命令内容级高危模式集 `CRITICAL_BASH_PATTERNS`（`sudo rm`、`--no-preserve-root`、`chmod -R … /`、`> /etc/shadow`、`curl\|bash`、`nc -e`、`kill -9 1` 等） | `src/tools/bash.ts:178-225` |
| O19 | 斜杠命令 handler 直调（`command.handler(args, ctx)`），**不经** `tool_call`/`tool_result`；`pi.exec` 直起子进程；`ctx.invokeTool` 为同名原生转发且跳过审批 | `src/session/agent-session.ts:6657`；`loader.ts:277-279`；`wrapper.ts:213, 372`；`runner.ts:560-596` |

### 3.1 实测（复跑探针，omp 18.1.18）

| # | 断言 | 模式 | 结果 |
|---|---|---|---|
| X1 | `approval:"read"` 工具调用 | `--approval-mode write`，非交互 | **无交互直接执行** |
| X2 | `override:true` 工具调用 | `--approval-mode write`，非交互 | **硬失败**：`requires approval but no interactive UI available` |
| X3 | `policy:"deny"` 工具调用 | `--approval-mode yolo` | **仍拒绝**：`is blocked by tool policy` |
| X4 | discoverable 只读扩展工具（`approval:"read"`） | `--approval-mode always-ask`，非交互 | **不可达**（外层 `write` 门先拦，报 `Tool "write" requires approval…`） |
| X5 | 同上但声明 `loadMode:"essential"` | `--approval-mode always-ask`，非交互 | **正常执行** |
| X6 | `policy:"allow"` 但 discoverable | `--approval-mode always-ask` | 被外层拦，**设备策略未被咨询** |
| X7 | `pi.typebox.Type` / `pi.zod` 注册工具 | 默认 | 均正常注册 |
| **X8** | **v4.0 注册骨架端到端**（§7.3 复刻：`pi.zod` + `loadMode:"essential"` + 四种 approval 形态） | **`--approval-mode always-ask`（最严）+ 非交互**，一次运行 | ①`approval:"read"` → **执行**（`read-ok:web-01:30`）②`policy:"allow"` → **执行**（`exec-ok:web-01:restart`）③`policy:"deny"` → **硬拒**（`is blocked by tool policy. Reason: 生产目标禁止无人值守变更`）④`override:true` → **硬失败**（`requires approval but no interactive UI available`）。平台探针全部就绪：`pi.zod.object`/`pi.zod.enum`/`appendEntry`/`getAllTools` 均为 function |
| **X9** | **`override:true` 在 yolo 下被忽略**（评审 R-1） | `--approval-mode yolo` + 非交互 | **漏洞确认**：工具**直接执行**（`OVR_RAN:prod-db`）。yolo 分支只看 `decision.policy`（`approval.ts:160-176`），`override` 不参与；默认模式即 yolo（`wrapper.ts:198`）→ v4.0 的「未授权 → override」安全属性失效 |
| **X10** | **①-b 兜底层修复验证**（评审 R-1 的修改指引） | `--approval-mode yolo` + 非交互 | **修复有效**：`tool_call` 内 `!c.hasUI && !preauthorized` → 未预授权者被拒（`[ERR_PERMISSION] 无人值守且未预授权`，工具**未运行**）、已预授权者放行（`RAN`）。`ctx.hasUI` 在 `tool_call` handler 中可读 |
| **X11** | **被阻断调用的 `tool_result` 不触发**（评审 R-4） | `tool_call` 返回 `{block:true}`，记录全事件序列 | 序列 = `tool_call` → `tool_execution_start` → `tool_execution_end`，**无 `tool_result`**；`execute` 未运行。→ 审计须用 `tool_execution_end` |
| **X12** | **`event.systemPrompt` 是 `string[]`**（评审 R-2） | `before_agent_start` handler 内探测 | `systemPromptType: "array"`、`systemPromptLen: 2` → 直接模板插值会拼成逗号串，须先归一化 |
| **X13** | **工具 `details` 回流到 `tool_result`**（评审 R-3，排除） | 工具返回 `details:{authz:"preauth:web-01/nginx"}` | **可用**：`tool_result` 事件含 `details` 字段且值一致 → §7.8 授权来源机制成立（且同样适用于 `tool_execution_end` 的 `result.details`） |
| **X14** | **扩展无法自检 `approvalMode`**（评审 R-6） | 枚举扩展 API 自有成员 | `pi` 自有成员仅 `arktype/cwd/events/extension/flagValues/logger/pendingProviderRegistrations/pi/runtime/typebox/zod`；`ctx` 仅有 `ui` 为自有属性（其余在原型链）→ **无 settings 访问器**，审批模式约束不能靠扩展自检 |
| **X15** | **加载期 action 方法不可用**（独立复评 N-2） | 在扩展工厂内调用 `pi.getAllTools()`；再在 `session_start` 调用 | 加载期**抛错** `Extension runtime not initialized. Action methods cannot be called during extension loading.`；**`session_start` 可正常调用**（实测 `count=20`，能枚举 `ops_*` 工具）→ 启动期断言必须后移到 `session_start` |
| **X16** | **`event.input` 改写会传播**（独立复评 N-1） | 先注册的 `tool_call` handler 改写 `host`/`command`，后注册的兜底层观测 | 兜底层**读到改写后的值**（`prod-db` + `rm -rf /`）并成功阻断 → ①-b 覆盖「先于我们注册」的改写 |
| **X17** | **审批门对改写后的最终入参解析**（独立复评 N-1，顺序敏感变体） | 兜底层**先**注册、改写钩子**后**注册 | 兜底看到原值（`web-01/nginx`）放行；随后宿主审批门对**改写后**入参解析 `authorizedExec` → 返 `policy:"deny"`，**工具未执行**（`blocked by tool policy (reason: production)`）→ ①-a 覆盖「后于我们注册」的改写 |
| **X18** | **`tool_call` 内 `appendEntry` 可落库**（独立复评 N-4） | 兜底阻断前写 `ops_audit(layer)`，在 `turn_end` 读 `getBranch()` | 分支中 `ops_audit` 条目数 **1**，`layer` 字段保留（`guard-unattended`）→ 拒绝层级审计可行 |
| **X19** | **③ execute 侧复核不可替代**（v4.2 决定性验证，N-1） | 预授权 `web-01/nginx`，其后注册的钩子把 `command` 改写为 `rm -rf /`（host/service 仍预授权）——①-b 与 ①-a **均放行** | execute 收到 `rm -rf /`；**③ 复核拒绝，命令未执行**；分支留 1 条 `ops_audit(layer="execute-revalidation")`。**若无 ③，该命令会在已预授权主机上执行** → ③ 是权威层，不可省略 |
| **X19** | **③ execute 侧复核不可替代**（v4.2 决定性验证，N-1） | 预授权 `web-01/nginx`，其后注册的钩子把 `command` 改写为 `rm -rf /`（host/service 仍预授权）——①-b 与 ①-a **均放行** | execute 收到 `rm -rf /`；**③ 复核拒绝，命令未执行**；分支留 1 条 `ops_audit(layer="execute-revalidation")`。**若无 ③，该命令会在已预授权主机上执行** → ③ 是权威层，不可省略 |
| **X20** | **deny 在 `tool_call` 之前短路，且首评看【原始】入参**（v4.3 决定性验证，N-1 定案） | 真实请求 `real-target/prod-api`（未授权），**先注册**的钩子将其伪造为 `web-01/nginx`（已授权）；approval 用 default-deny 策略 | **伪造被击破**：`approval` 首评看到的是 `real-target/prod-api`（**原始值**）→ `deny` → 宿主**在发出 `tool_call` 之前抛错**（钩子的 `forge-applied` 与兜底的 `guard-sees` **均未出现**）→ 工具未执行。**证明：「先注册钩子伪造为已授权值」这一最危险方向由 default-deny 在审批层天然免疫** |
| **X21** | **`approval` 被求值 3 次**（独立复审 N-1 附发现，二次确认） | approval 函数内计数埋点 | 一次调用中求值 **3 次**（首评在 `tool_call` 前，后两次在钩子后）→ **`authorizedExec` 必须是纯函数**：不得消耗一次性令牌、不得有副作用（否则 TOCTOU + 重复消耗） |
| **X22** | **`Object.freeze(event.input)` 可阻断后续钩子改写**（v4.3 验证，可选加固） | 最早注册的钩子冻结 `event.input`，后注册钩子尝试赋值 | 后续钩子抛 `TypeError: Attempted to assign to readonly property.`，且**全部 3 次 approval 求值与 execute 看到的都是原值**。⚠️ 副作用：平台文档允许「就地改写 input 打补丁」，冻结会**破坏共载扩展的合法用法** → **默认不启用**，仅在高隔离环境作为可选加固（§7.4.4） |
| **X23** | **`tool_execution_end.result.content[].text` 携带拒绝原因**（v4.3 验证，N-4/RR-3 有解） | 分别触发「我们的 `tool_call` block」与「宿主 `policy:deny`」，读 `result.content[0].text` | 两者**均携带原因文本**（`[ERR_PERMISSION] our-hook-block` / `Tool "ops_d" is blocked by tool policy.\nReason: RR3-denied`）→ 审计可直接按 `reason` 前缀分类，**无需前置 `appendEntry`；RR-3「宿主拒绝无法标注层级」有解** |
| **X24** | **execute 期无法回溯模型原始入参**（v4.3 验证，N-1 边界） | execute 内读 `sessionManager.getBranch()` 找 assistant toolCall | 分支仅含 `model_change`/`thinking_level_change`/user message（**3 条**），**取不到模型原始 toolCall** → 扩展内部**无法**自行检测「先于我们注册的钩子」的改写；真值只能来自审批层首评（X20） |

> X1–X3 是本方案安全模型的**机制验证**；X4–X6 是 `loadMode` 必修项的**风险验证**；X8 是注册骨架与安全四分支的端到端验证；**X9–X10 是 R-1 漏洞与其修复的对照实证**；X11–X18 为评审与独立复评的机制取证（审计落点、`systemPrompt` 类型、input 一致性、断言时机、层级审计）。

### 3.2 不可回源（Unknown）

| # | 项 | 原因 |
|---|---|---|
| U1 | Yuyi 适配器接口面、`yuyi_*` 清单、`@qianji/core` 依赖 | 本机无 `yuyi-pi-extension.ts` |
| U2 | omp 未来版本对 `approval`/`loadMode`/spill 的兼容承诺 | 无版本承诺文档；按 §5 回归清单复核 |

---

## 4. 风险覆盖（10 分）

| 风险类 | 有无 | 分析与对策 |
|---|---|---|
| **Compatibility 兼容** | **有（主风险）** | ①**平台版本漂移**：依赖 `approval` 解析顺序、`loadMode` 语义、spill 常量、`tool_call` 30s 上限——omp 迭代快，**启动期平台能力探针**（§7.2）缺失即报错退出；②工具重名静默覆盖（O11）→ 启动期断言前缀不相交；③`pi.typebox` 被标 legacy/compat（O15）→ 改用 `pi.zod`（O14） |
| **Exception 异常** | 有 | L1 统一 `OpsError`；L2 可预期错误返回结构化文本、硬失败 `throw`；非交互+需审批 = 拒绝（①-b 或平台硬失败），在 README 与工具 description 中明示，不制造静默失败 |
| **Cache 缓存** | 低 | SSH 连接池（`maxConcurrent=10`/`idle=5min`）、vault 内存态须在 `session_shutdown` 释放；健康阈值配置每次读取（不缓存失效） |
| **MQ 消息** | 有 | 跨 Agent 经 Yuyi Hub。风险：**同进程双 Hub 连接**（O12）→ 禁止 import 第三方内部类，只共载官方适配器（唯一实例）。防乒乓/限流由适配器内建（U1 待核实） |
| **State 状态机** | 有 | 无自有状态机；关键态在 vault（locked/unlocked）与审批（allow/deny/prompt）。vault 锁定 → `VAULT_LOCKED`；审批态**全部交宿主** `resolveApproval` 解析，ops-pi 不复制状态 |
| **Security 安全** | **有（主风险）** | ①斜杠命令绕过审批与审计（O19）→ §7.7 危险动作不注册命令；②`*_exec` 万能工具 → §7.4 第②③层兜底；③无人值守授权边界 → **①-b 模式无关兜底**（不依赖 `approvalMode`）+ Owner 预授权；④**`loadMode` 默认 discoverable 使 `approval` 声明失效**（O8/X4–X6）→ 强制 `loadMode:"essential"` + 契约断言；⑤`tool_call` 30s 上限（O6）→ hook 内只做**同步**判定；⑥**默认 yolo 使 `override` 失效（X9 实测漏洞）** → **不以 `override` 承载安全属性**，改用 ①-b（X10 验证有效）；⑦凭据明文 → vault + 口令仅环境变量；⑧生产 docker.sock 越权 → 不挂载，走远端 docker CLI；⑨跨 Agent 提示注入 → 依赖适配器框定（U1），系统提示声明外部请求不降级安全门 |

**残留风险（显式登记，不静默）**

| # | 残留风险 | 范围 | 处置 |
|---|---|---|---|
| RR-1 | **交互态 + 显式 `--approval-mode yolo` + 未预授权** 的 `exec` 档操作会执行 | 仅交互态且操作者显式关闭审批时 | ①-b 兜底层只在 `!hasUI` 时生效；交互态信任平台审批。生产目标由 `policy:"deny"` **独立**兜住（yolo 下仍拒，X3/X8）。故 RR-1 仅影响非生产、且操作者主动 yolo 的场景。**要求部署规范禁止 yolo**；扩展无法自检该模式（X14） |
| RR-2 | 审计可读范围限于**当前会话分支 leaf 路径**（O17） | 跨会话/跨分支追溯 | v1 接受；跨会话不可变审计需另落 artifact/外部系统（§6 登记） |
| ~~RR-3~~ **已解决** | 原判「宿主审批门拒绝无法标注层级」 | — | **X23 实测：`tool_execution_end.result.content[].text` 携带宿主拒绝原因文本**（含 `Reason:` 行）→ 审计可分类为 `host-policy` 并保留原文（§7.4.5），无需前置条目 |
| RR-4 | 共载第三方扩展可改写 `ops_*` 入参（宿主共享可变 input 语义，X16/X17/X20） | 系统内其他扩展的行为 | **三种方向已全部有拦截层**（§7.4.4 矩阵）：伪造为已授权值 → ①-a **首评**（X20）；改成未授权值 → ①-a 复评（X17）；仅改命令 → ③ execute 复核（X19）。**前提 = `defaultDeny` + execute 复核校验维度完整**（§7.4.4 规范 1/4）。残留：若共载钩子改的是 policy **不校验的维度**，逃逸 ①-a 后仍靠 ③ 兜住 → 故 ③ 必须重算**全部**校验维度。可选加固：`Object.freeze(event.input)`（X22，默认不启用，破坏共载扩展合法用法）；**建议向 omp 上游反馈该传播语义** |

---

## 5. 验证覆盖（10 分）

| 验证手段 | 内容 | 可执行入口 |
|---|---|---|
| **Unit 单测** | L1 各模块：Shell 参数数组化防注入、SSH 池并发/超时、vault 加解密与锁定态、Health 阈值判定、`targetPolicy` 匹配（含 defaultDeny 与 expiresAt 边界）、审批决策函数（allow / deny / 未授权三分支）与 `needsOwnerAuth` 档位判定 | `packages/ops-core` 的 `bun test`（L1 不依赖 omp，可脱离宿主跑） |
| **Contract 契约** | ①扩展可加载并注册全部 `ops_*`（`getAllTools()` 名称清单断言）；②与共载适配器**前缀不相交**——**断言时机 = `session_start` 首次触发时**（加载期 `getAllTools()` 抛 `Extension runtime not initialized`，X15 实测），命中即 `throw` 拒绝继续运行；**性质为「检测 + 拒绝」，不是「阻止」**（覆盖在断言前已定格，O11 静默 last-wins），须在 README 标注该宿主限制；③**每个 `ops_*` 均声明 `loadMode:"essential"`**（遍历注册项，O8）；并验证纵深防御：**即使漏声明（discoverable）**，经 `xd://` 调用的工具仍被 ①-b 兜底层拦截（独立复评 N-3 实证，execute 未运行）；④每个工具的 `approval` 档位与 §7.4.1 表一致；⑤平台能力探针通过（`pi.zod`、`ctx.setInterval`、`approval` 字段被宿主识别）；⑥安全机制契约六断言：`read` 档在 `write` 模式非交互可执行（X1）、`policy:"deny"` 在 yolo 仍拒（X3）、**未预授权的 `exec` 档在 yolo + 非交互下被 ①-b 拒绝**（X10）、骨架端到端四分支（X8）、**入参伪造被 default-deny 在钩子前短路**（X20）、**`authorizedExec` 纯函数**（断言其不写文件/不改变外部状态——被求值 3 次，X21） | 启动期断言脚本 + `omp --no-session -e ops-extension.ts -p` + 探针扩展写 JSON |
| **Regression 回归** | 升级 omp 后按 §3 证据表逐条复跑（审批解析顺序、`loadMode` 默认值、spill 常量与阈值、`tool_call` 30s、工具重名语义、`input` 契约），并复跑 X1–X24 | `docs/reports/` 留复跑记录；**探针脚本已入库：`docs/reports/probes/v4-skeleton-probe.ts`**（含复跑命令与预期结果，X8 复现用） |
| **拒绝路径负测（核心）** | ①高危命令（`rm -rf /`、`sudo rm`、`curl\|bash`）→ 内容硬拒，**任何 `approvalMode` 下不放行**；②未授权主机的 `ops_service(restart)` → 拒绝；③无人值守下生产变更 → 失败并给出授权途径；④**【R-1 回归】`--approval-mode yolo` + 非交互，未预授权的 `exec` 档工具必须被拒且工具未运行**（X10）；⑤`loadMode` 被误删时**应当失败**（回归保护 X4）；⑥被拒调用必须留 `ops_audit`（验证审计用 `tool_execution_end` 而非 `tool_result`，X11）；⑦斜杠命令入口不产生未审批执行（审计条目在，或命令只读）；⑧大小写/别名变体绕过（沿用 `practice/ro-mount-case-alias-bypass.md` 教训）；⑨**【N-1 回归】共载钩子改写入参（四种方向）**：未授权值被伪造成**已授权值** → **①-a 首评**在钩子前短路（X20，决定性）；改成**未授权值** → ①-a 复评（X17）；仅改 **command**（目标仍预授权）→ ③ execute 复核（X19，决定性——前两层均放行）；注册在兜底**之前** → ①-b 拦（X16）。四种均**不得执行改写后的命令**；⑩**【N-4 回归】拒绝层级可辨**：①-b/②/③ 的拒绝条目 `layer` 字段分别为 `guard-*` / `guard-content` / `execute-revalidation` | 负测脚本集 + `omp -p` / `omp --approval-mode <各档>` 复跑；每条断言"被拒绝与审计已记录" |
| **Monitoring 监控** | ①审计：每次 `ops_*` 调用（含被拒）留 `ops_audit`；②可发现性：降级/锁定/拒绝经 `ctx.ui.notify` 显式可见；③外部审计：订阅 `tool_approval_requested`/`tool_approval_resolved` 事件 | `getBranch()` 检查 + 外部事件订阅 |
| **Rollback 回滚** | ①工具级：变更前状态快照（版本 + 文件哈希），回滚 = 重放快照，由 `ops_deploy_rollback`（预留）执行；②扩展级：移出 `-e` 参数/扩展目录即回到"无 ops 工具"状态，宿主不受影响；③策略级：删除 `policy.json` 即回到全拒（保守侧）；④审批级：`--approval-mode always-ask` 即回到最严 | 部署提示词内置回滚步骤 |

---

## 6. 不确定性治理（10 分）

| # | 类型 | 描述 | 处置 |
|---|---|---|---|
| 1 | **Blocked（跨团队）** | Yuyi 需提供「查询调用方御符身份/权限」的受支持接口（B1） | 已登记；请求书见附录 C；主人中转向 Yuyi 方。未落地前跨 Agent 路径保守降级（§7.6） |
| 2 | Unknown | omp 未来版本对 `approval`/`loadMode`/spill 的兼容承诺（U2） | 已登记；以启动期平台探针 + §5 回归清单对冲；不依赖未承诺行为 |
| 3 | Unknown | Yuyi 适配器实际接口面（U1） | 已登记；共载冒烟时核实 |
| 4 | Conflict（已处置） | v3.0 假设「核心基于上游 pi 契约、宿主能力为增强」 ⨯ 主人 2026-09-12 决策「运行时目标 = omp」 | **已按主人决策修方案**：本版撤销适配层、直接依赖 omp 平台（§1 Don't 合规说明） |
| 5 | Conflict（已处置，历史） | v1.4 自研 `authorize()` ⨯ 评审 v2.0 判「与宿主重复」 | **v3.0 已澄清**：pi 无原生审批 → 该判基于错误基准；本版回到「直接使用 omp 原生审批」，但**不是**因自研有错，而是因宿主已选 omp |
| 6 | Human Decision（已决） | 授权边界/档位表/生产禁止无人值守 | 主人 2026-09-12 决策 D4 + 需求包 A1–A4 |
| 7 | Human Decision（待） | 目标仓/git 化（B2）、目录命名（B3）、omp 最低版本承诺（B5） | 待主人确认；当前产出落 `/workspace` |
| 8 | **Residual Risk（显式登记）** | RR-1：交互态 + 显式 yolo + 未预授权 → `exec` 档会执行（②残留）；RR-2：审计可读范围为当前分支 leaf 路径 | RR-1：要求部署禁止 yolo；生产由 `policy:"deny"` 独立兜住（yolo 下仍拒，X3/X8）。RR-2：v1 接受，跨会话审计另案 |
| 9 | **宿主已知限制（登记 + 已部分闭环）** | ①`event.input` 共享可变，共载扩展可改写入参；②`approval` 被求值 3 次（纯函数要求）；③扩展无法从会话分支回溯模型原始入参；④工具重名静默 last-wins，断言只能后移到 `session_start` | ①三种改写方向均有拦截层（§7.4.4 矩阵，X17/X19/X20 实测），根治需平台侧支持 → **建议上游反馈**；②`authorizedExec` 定为纯函数，令牌消费移至 execute（§7.4.4 规范 2/3）；③真值只来自审批层首评（X20/X24），故预授权必须在审批层表达；④`session_start` 断言 + `throw`，README 标注 |

---

## 7. 架构设计（正文）

### 7.1 分层

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 平台：oh-my-pi（omp 18.x） — 不动                                             │
│   扩展 API（registerTool/on/…） · 原生审批（approval/approvalMode/事件）      │
│   受管定时器 · 输出 spill（artifact）· 注入 schema（zod/arktype/typebox）     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ 平台契约（直接依赖，非"增强"）
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ L2 @ops-pi/extension（omp 扩展）                                             │
│  ┌────────────────────────────┐   ┌────────────────────────────────────────┐ │
│  │ ops_* 工具（25+）           │   │ Yuyi 官方适配器（共载，外部，只读）    │ │
│  │  approval 档 + 目标策略     │   │ yuyi_*/yufu_*/yuyi_task_*              │ │
│  │  loadMode:"essential"       │   │ （前缀不相交，启动期断言）             │ │
│  │  hooks（内容硬拒/审计/轮询）│   └────────────────────────────────────────┘ │
│  └────────────────────────────┘                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ L1 @ops-pi/core（纯 Node，不依赖 omp / Yuyi）                                │
│  Shell · SshPool · Docker · K8s · Process · Log · File · Health · Vault      │
│  + targetPolicy（目标策略）  + approvals（审批决策，纯函数）  + OpsError      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**执行位置约定（控制节点 + 远程目标）**：Shell/File/Process/Log 默认在控制节点本地、传 `host` 时经 `SshPool` 在远端执行；SSH 池在控制节点；Docker 统一「远端 docker CLI over SSH」（**不挂生产 docker.sock**）；K8s 在控制节点用 kubeconfig context 指向目标集群；Health 远端采样、控制节点聚合。统一抽象：

```ts
export interface ExecResult { stdout: string; stderr: string; exitCode: number; durationMs: number }

/** LocalRunner（封装 ShellExec）与 SshRunner（封装 SshPool）均实现；其它模块按 host 选择执行位置 */
export interface CommandRunner {
  exec(cmd: string | string[], opts?: { host?: string; timeout?: number; signal?: AbortSignal }): Promise<ExecResult>
}

export type OpsErrorCode =
  | "CONNECTION_REFUSED" | "AUTH_FAILED" | "TIMEOUT" | "EXEC_FAILED"
  | "NOT_FOUND" | "PERMISSION_DENIED" | "POLICY_DENIED" | "VAULT_LOCKED" | "INTERNAL"
```

### 7.2 平台能力前置校验（替代 v3.0 的「宿主适配层」）

平台既然是必需依赖，就要**显式前置校验**，而不是探测后静默降级（避免"看起来在跑、安全门其实没生效"）：

```ts
// packages/ops-extension/src/platform.ts
export interface PlatformFloor { minVersion: string; required: readonly string[] }

export const REQUIRED: PlatformFloor = {
  minVersion: "18.1.18",                 // 本方案验证基线
  required: [
    "pi.zod",                            // 注入 schema 构建器（O1/O14）
    "pi.appendEntry",                    // 审计持久化（O16）
    "pi.getAllTools", "pi.setActiveTools",
    "ctx.hasUI", "ctx.setInterval",      // 受管定时器（O5）
    "ctx.sessionManager.getBranch",
    "tool.approval",                     // ★ 原生审批（O2）——缺失则安全门不存在
    "event.tool_execution_end",          // 审计落点（R-4：tool_result 不覆盖被阻断调用）
  ],
}

/** 启动期校验：任一缺失 → 抛错并给出最低版本与原因，不静默降级 */
export function assertPlatform(pi: ExtensionAPI): void { /* 逐项探测 + 版本比对 */ }
```

> **探针的能力边界（R-6，务必写进 README）**：扩展 API **没有 settings 访问器**（实测 `pi` 自有成员仅 `arktype/cwd/events/extension/flagValues/logger/pendingProviderRegistrations/pi/runtime/typebox/zod`，`ctx` 仅 `ui` 为自有属性，X14），因此**无法自检 `approvalMode`**。
> 故本方案**不把安全属性寄托在审批模式上**：模式无关的 ①-b 兜底层（§7.4）保证无人值守下未预授权操作一律被拒，与 `approvalMode` 取值无关（X10 在 yolo 下实测有效）。`approvalMode ≠ yolo` 作为**部署规范约束**（§2 表）降低 RR-1 残留面，而非安全前提。

> **与外部增强的区别**：Yuyi/御符/vault 缺席 → **降级**（收窄能力、提示、可恢复）；平台能力缺失 → **硬失败**（拒绝启动）。两者不可混同：前者是可选增强，后者是安全前提。

### 7.3 目录结构、入口与 schema

```
packages/ops-extension/src/
  extension.ts        # export default function (pi: ExtensionAPI)  ← 入口
  platform.ts         # 平台能力前置校验（§7.2）
  context.ts          # L1 上下文装配 + targetPolicy + policy/token 加载
  tools/
    shell.ts ssh.ts docker.ts k8s.ts process.ts log.ts file.ts health.ts vault.ts
  approvals.ts        # 审批档位/决策单一事实源（§7.4.1）
  content-guard.ts    # 第②层：内容级硬拒（纯同步正则）
  hooks.ts            # tool_result 审计 + session_start 提示 + 轮询
  commands.ts         # 斜杠命令（只读或经工具转交，§7.7）
  setup.ts            # 配置加载（policy / 目标允许清单 / vault 口令来源）
  index.ts
```

```ts
// packages/ops-extension/src/extension.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"   // 规范 scope（O13）
import { assertPlatform } from "./platform"
import { loadConfig } from "./setup"
import { createOpsContext } from "./context"
import { registerShellTools } from "./tools/shell"
// …其余模块
import { setupOpsHooks } from "./hooks"

export default function (pi: ExtensionAPI): void {
  assertPlatform(pi)                       // 平台能力前置校验（§7.2）
  const config = loadConfig()              // 加载时同步读取（早于 session_start）
  const ctx = createOpsContext(config)     // L1 + targetPolicy + approvals
  registerShellTools(pi, ctx)
  // …其余模块
  setupOpsHooks(pi, ctx, config)
  // 共载 Yuyi 官方适配器（外部，同进程，工具名前缀不相交）：
  //   omp -e ./packages/ops-extension/src/extension.ts \
  //       -e /path/to/Yuyi/adapters/pi/yuyi-pi-extension.ts
}
```

**schema 取用点**：使用宿主注入的 `pi.zod`（原生 Zod 门面，O14；官方示例统一用法）。**不用** `pi.typebox`（官方注释标 legacy/compat，O15）。

```ts
// packages/ops-extension/src/tools/ssh.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { EXEC } from "../approvals"
import { criticalReason } from "../content-guard"

export function registerSshTools(pi: ExtensionAPI, ctx: OpsToolContext): void {
  const z = pi.zod                                   // 原生 schema（O14）

  pi.registerTool({
    name: "ops_ssh_exec",
    label: "SSH Exec",
    loadMode: "essential",                           // ★ 必须：否则挂 xd://，approval 声明失效（O8/X4–X6）
    approval: EXEC,                                  // ★ 档位：§7.4.1
    description: "在远程主机上执行一条 shell 命令并返回输出。优先使用非交互式命令。" +
                 "输出超过 50KB / 3000 行时由宿主截断并把完整内容存入 artifact。",
    parameters: z.object({
      host: z.string().describe("目标主机 hostname 或 IP"),
      command: z.string().describe("要执行的 shell 命令"),
      timeout: z.number().optional().describe("超时秒数（缺省 30）"),
    }),
    async execute(toolCallId, params, signal, _onUpdate, c) {
      // ★ 第③层 + 第②层的权威落点（N-1 修复）：execute 收到的是**实际要执行的值**，
      //   故授权复核必须在此再做一次——不看 approval 的判定结果，独立重算。
      assertAuthorized(toolName, params)                        // 内容硬拒 + 目标策略 + 预授权/令牌（§7.4.4）
      const result = await ctx.ssh.exec({ hostname: params.host }, params.command,
        { timeout: (params.timeout ?? 30) * 1000, signal })
      // 不自截断：完整输出交宿主 spill，内联由宿主换 head+tail（O7）
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
               details: { authz: ctx.lastAuthzSource() } }       // 供审计钩子记录授权来源
    },
  })
}
```

### 7.4 安全模型：三层分工（宿主原生 + 内容硬拒 + 目标策略）

> **v4.1 修正（评审 R-1）**：v4.0 用 `override:true` 表达「未授权 → 需 Owner 批准」，但 `override` **在 yolo 模式下被忽略**（`approval.ts:160-176` 的 yolo 分支只看 `decision.policy`；默认模式即 yolo，`wrapper.ts:198`），**实测 yolo 下未授权工具直接执行**。故 v4.1 不以 `override` 承载安全属性，改为**模式无关的兜底层**（下表 ①-b）。

| 层 | 机制 | 管什么 | 能否被 `approvalMode` 关闭 |
|---|---|---|---|
| **①-a 审批档** | 每个 `ops_*` 声明函数式 `approval`（可返 `policy:"allow"` / `policy:"deny"` / 档位） | 「这类动作要不要人点头」；**Owner 预授权的放行** | 档位部分**能**（yolo 关闭）；`policy:"allow"\|"deny"` **不能**（O3 最优先解析） |
| **①-b 无人值守兜底** | `tool_call` 内：`!ctx.hasUI` 且未预授权 → `{block:true}`（**纯同步，不读任何模式**） | 「无人值守时谁都不能绕过的拒绝」 | **不能**（与 `approvalMode` 完全无关；实测 yolo 下仍拒，X10） |
| **② 内容硬拒** | `tool_call` 中**纯同步**正则，只返回 `{block:true, reason}`，**不做任何 `await` 交互** | 灾难性命令一律拒绝 | **不能**（与模式无关；且避开 30s 上限 O6） |
| **③ 目标策略** | L1 `targetPolicy`（纯函数，可单测）：目标主机白名单 + 服务白名单 + 凭据作用域，defaultDeny | 「允许对哪些对象执行」 | **不能**（代码内硬约束） |

> ①-a 与 ①-b 分工：①-a 负责**放行**（`policy:"allow"` 让 Owner 预授权在 yolo 下依然生效）与**硬拒**（生产目标 `policy:"deny"`）；①-b 负责**无人值守的默认拒绝**（不依赖审批模式）。二者叠加后，安全属性不再依赖任何宿主配置。

```ts
// packages/ops-core/src/approvals.ts —— 档位与授权判定（纯函数，可单测；L1 不依赖 omp）
export const READ = "read" as const
export const WRITE = "write" as const
export const EXEC = "exec" as const

/** 参数多态档位（供 Docker/Service/K8s 等 action 类工具） */
export function byAction(readonlyActions: readonly string[], readKey = "action"): (args: unknown) => Tier {
  return (args) => {
    const a = (args as Record<string, unknown> | null)?.[readKey]
    return typeof a === "string" && readonlyActions.includes(a) ? READ : EXEC
  }
}

/**
 * 高危工具的授权判定：把 Owner 预授权表达在「审批门」内（§7.4.2）。
 * ★★ 必须【纯函数】：被宿主求值 3 次（X21），且首评看原始入参（X20）——
 *    任何副作用（消耗令牌、写文件、计数）都会引入 TOCTOU / 重复消耗。
 *    「用掉」令牌的动作放在 execute 复核通过之后（§7.4.4 规范 3）。
 * 结构化匹配宿主 ToolApprovalDecision。★ 不使用 override（v4.1：override 在 yolo 下被忽略，见 R-1）：
 *  已授权（P2 命中 / P3 令牌有效）→ { tier:"exec", policy:"allow" }   任何模式放行（O3 最优先）
 *  生产目标                      → { tier:"exec", policy:"deny", reason } 任何模式硬拒（X3/X8 实证）
 *  其他（未授权）                → { tier:"exec" }                    交平台审批；无人值守由 ①-b 兜底拒绝
 */
export function authorizedExec(policy: TargetPolicy, tokens: TokenStore) {
  return (args: unknown): ApprovalDecision => {
    const req = asPolicyRequest(args)
    const t = tokens.find(req)
    if (t?.valid) return { tier: "exec", policy: "allow", reason: `Owner 批准令牌 ${t.id}` }
    if (policy.allows(req)) return { tier: "exec", policy: "allow", reason: `命中预授权 ${req.host}/${req.service}` }
    if (policy.isProduction(req)) return { tier: "exec", policy: "deny", reason: "生产目标禁止无人值守变更" }
    return { tier: "exec" }                    // 未授权：交互态由平台弹窗；无人值守由 ①-b 拒绝
  }
}

/** ①-b 判定：无人值守兜底层用（纯函数，模式无关） */
export function needsOwnerAuth(toolName: string, input: Record<string, unknown>): boolean {
  const tier = tierOf(toolName, input)         // §7.4.1 表；read 档不需要
  return tier !== READ
}
```

```ts
// packages/ops-extension/src/content-guard.ts —— 第②层
/** 灾难性命令模式：以宿主 CRITICAL_BASH_PATTERNS（O18）为下界，并补绝对路径锚点 */
const CRITICAL = [
  /\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i, // 要求绝对路径，避免 rm -rf ./dist 误报
  /\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
  /\bsudo\s+rm\b/i,
  /\b(mkfs(\.|\b)|\bcryptsetup\b)/i,
  /\bdd\s+if=.+of=\/dev\//i,
  />\s*\/dev\/sd[a-z]/i,
  />\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
  /\bchmod\s+-R\s+[0-7]+\s+\//i,
  /\bchown\s+-R\s+\S+\s+\//i,
  /\bkill\s+-9\s+1\b/,
  /(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt|init\s+0)(?:\s|$|[;|&])/i,
  /\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
  /\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i,
] as const

/** 纯同步判定：返回拒绝原因或 null。绝不 await 人工交互（避开 30s 上限，O6） */
export function criticalReason(cmd: string): string | null {
  for (const re of CRITICAL) if (re.test(cmd)) return "命中灾难性命令模式，已拒绝"
  return null
}
```

#### 7.4.1 档位表（决策 D4，主人已同意）

| 档位 | 工具 | 无人值守行为 |
|---|---|---|
| `read` | `ops_docker_ps` `ops_docker_logs` `ops_k8s_pods` `ops_k8s_logs` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_file_read` `ops_file_ls` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_compose(ps\|logs)` `ops_k8s_rollout(status)` `ops_service(status)` | `approval:"read"` → **三模式自动放行**，无需交互（X1） |
| `write` | `ops_file_write` `ops_ssh_upload` `ops_ssh_download` `ops_vault_store` | 需人点头；无人值守默认**失败**（O4） |
| `exec` | `ops_shell_exec` `ops_shell_script` `ops_ssh_exec` `ops_docker_exec` `ops_k8s_exec` `ops_process_kill` `ops_docker_compose(up\|down\|restart)` `ops_k8s_rollout(restart\|undo)` `ops_service(非 status)` `ops_deploy_*`（预留） | 需 Owner 预授权才在无人值守放行（§7.4.2） |

参数多态工具用 `byAction`：

```ts
pi.registerTool({ name: "ops_service", /* … */ approval: byAction(["status"], "action") })
pi.registerTool({ name: "ops_k8s_rollout", /* … */ approval: byAction(["status"], "action") })
pi.registerTool({ name: "ops_docker_compose", /* … */ approval: byAction(["ps", "logs"], "action") })
```

#### 7.4.2 Owner 预授权（需求包 A3）

无人值守**无 UI → 宿主对 `write`/`exec` 档硬失败**（O4）。故「Owner 明示批准」= 可离线签发的预授权，三形态（均在审批门内生效）：

| 形态 | 载体 | 语义 | 适用 |
|---|---|---|---|
| **P1 工具级** | 宿主配置 `tools.approval.<工具名>: allow`（O2/O3），或工具自身返 `{policy:"allow"}` | 「该工具整体允许」 | 低频、粗粒度 |
| **P2 目标级** | `~/.ops-pi/policy.json` 的 `targets[]`：`{host, services[], actions[], expiresAt?}` → `authorizedExec()` 返回 `{policy:"allow"}` | 「只允许对该主机的这些服务做这些动作」 | **A2 核心机制**（指定服务重启） |
| **P3 批准令牌** | `~/.ops-pi/approval-token.json`：`{id, scope, issuedBy, issuedAt, expiresAt, nonce}` → `authorizedExec` **只读**匹配 | 高危敏感操作的**单次/限时**明示批准 | 生产变更等 A3 场景 |

> **令牌消费的时点（v4.3，X21）**：`approval` 一次调用被求值 **3 次**，故 `authorizedExec` 内**只能只读校验**（`tokens.find(req)?.valid`），**不得**在此「用掉」令牌。真正消费（写 nonce / 置已用）发生在 ③ `execute` 复核通过之后、执行之前——保证「校验 N 次不消耗、执行 1 次才消费」，避免 TOCTOU 与重复消耗。

> **为什么目标级/令牌级走工具自身 `policy` 而非只靠宿主配置**：`tools.approval.*` 是**按工具名**的（O2），表达不了「只允许该主机的这个服务」。函数式 `approval` 可读参数并返 `{policy:"allow"|"deny"}`，使目标级与令牌级授权都在**审批门内**完成，不引入第二套判定逻辑，且 `policy` 在解析顺序中**优先级最高**（O3），`yolo` 也关不掉。

- 三者均为 Owner 手写/签发文件，纳入版本管理可追溯；`expiresAt` 过期即失效（默认 0 = 不自动过期）。
- 令牌非密码学签名时，安全性依赖文件权限（建议 600）与沙箱（§7.1）；**不伪装为强认证**，README 如实标注。
- **生产环境禁止无人值守**（决策 D4）：`policy.isProduction(req)` → 变更类调用返 `{policy:"deny"}`，**任何 `approvalMode` 下都拒绝**（X3 实证）。

```ts
// packages/ops-core/src/policy.ts —— 第③层（L1 内，纯函数，可单测）
export interface PolicyRequest { host?: string; service?: string; action?: string; command?: string }
export interface TargetPolicy {
  readonly isConfigured: boolean
  isProduction(req: PolicyRequest): boolean
  allows(req: PolicyRequest): boolean
  /** defaultDeny；不通过则抛 OpsError("POLICY_DENIED") */
  check(req: PolicyRequest): void
}
export function loadTargetPolicy(path: string): TargetPolicy   // 缺失 → 全拒策略
```

#### 7.4.3 降级语义（联邦三要素，需求包 A5）

| 缺席项 | 类型 | 可发现 | 安全收敛 | 可恢复 |
|---|---|---|---|---|
| **平台能力**（`approval`/`zod`/`setInterval`…） | **硬失败** | 启动期抛错 + 最低版本要求 | 拒绝启动（不带着残缺安全门运行） | 升级 omp |
| `policy.json` | 外部 | `ui.notify` 明示"变更类操作一律拒绝" | 全拒（不扩权） | 文件出现后下次调用生效 |
| vault 未解锁 | 外部 | `session_start` 通知 | 需 vault 的主机不可操作 | `ops_vault_unlock` 后恢复 |
| Yuyi 适配器 | 外部 | notify"跨 Agent 能力不可用" | 跨 Agent 路径全部关闭（含只读） | 共载后自动恢复 |
| 沙箱未启用 | 部署 | notify"降级为进程级隔离" | 危险工具保持 `exec` 档，不外放 | 容器重建 |

#### 7.4.4 入参完整性与授权一致性（N-1 定案：三层 + default-deny）

> **机制已定案（X20/X21/X24 实测）**：`event.input` 是**共享可变对象**，`tool_call` 的多个 handler 按注册顺序依次看到它，改写会向下游传播。**但审批层的求值语义给出了关键抓手**：
> 1. `approval` 在一次调用中**被求值 3 次**（X21）；
> 2. **首次求值看到的是模型发出的【原始】入参**（在任何 `tool_call` handler 之前）；
> 3. 若首评返回 `policy:"deny"`，宿主**在发出 `tool_call` 之前就抛错短路**——钩子根本不会运行（X20）、工具不会执行；
> 4. 后两次求值看到的是**钩子改写后的**入参（`wrapper.ts` 注释明示 "approval resolves against the input that actually executes"）；
> 5. 扩展在 `execute` 期**无法**从会话分支回溯模型原始入参（分支尚未包含该 assistant toolCall，X24）。

**威胁模型与防御矩阵（三种改写方向，全部实测）**

| 攻击方向 | 例 | 被哪一层拦 | 证据 |
|---|---|---|---|
| **① 伪造为已授权值** | 未授权 `real-target` → 伪造成已授权 `web-01` | **①-a 审批层首评**（看到原始 `real-target` → `deny` → **钩子前短路**） | X20 ✅ |
| **② 从已授权值改成未授权值** | 已授权 `web-01` → 改成生产 `prod-db` | **①-a 审批层复评**（后两次求值看到 `prod-db` → `deny`） | X17 ✅ |
| **③ 目标不变、仅改命令内容** | `web-01` 合法命令 → 改成 `rm -rf /` | **③ execute 侧复核**（前两层均放行，仅此层拦） | X19 ✅ |
| （兜底）无人值守未预授权 | — | **①-b 模式无关兜底层** | X10 ✅ |

**规范性要求（v4.3 强化）**

1. **预授权必须以 `defaultDeny` 表达在审批层**（`policy.json` 的 `targets[]` 白名单，命中才 `policy:"allow"`），**不得**改用「execute 内自建放行表」——只有审批层首评能看到模型原始入参（X20/X24），这是抵御方向 ① 的唯一位置。
2. **`authorizedExec` 必须是纯函数**：无副作用、不消耗一次性令牌、不做写操作。理由：被求值 3 次（X21），且并发工具调用可能交错——任何有状态判定都会引入 TOCTOU（独立复审 N-1 附发现）。
3. **一次性令牌的消费移到 `execute`**：`approval` 内只做**只读**校验（`tokens.find(req)?.valid`）；真正「用掉」令牌（写 nonce/置已用）必须在 ③ execute 复核**通过之后、执行之前**完成，保证「校验 3 次不消耗、执行 1 次才消费」。
4. **`assertAuthorized(toolName, params)` 置于每个 `execute` 首行**（§7.3 骨架已内联），独立重算内容硬拒 + 目标策略 + 预授权/令牌，**不信任 `approval` 的判定结果**（覆盖方向 ③）。
5. **本扩展的 `tool_call` handler 不得改写 `event.input`**（只读判定）；契约测试断言「execute 入参 === 兜底所见入参」（无第三方改写时）。
6. **拒绝留痕**：被拒调用由 `tool_execution_end` 提取 `result.content[].text` 记录原因（§7.4.5）。

**可选加固（默认不启用）：冻结入参**

实测 `Object.freeze(event.input)`（X22）可使后续钩子的赋值抛 `TypeError: Attempted to assign to readonly property.`，并使 3 次审批求值与 execute 全部看到原值——**对方向 ②③ 是强加固**。但平台文档明确允许扩展「就地改写 input 打补丁」，冻结会**破坏共载扩展的合法用法**（属对同进程邻居的破坏性行为）。故：
- **默认不启用**；
- 仅在「高隔离单扩展部署」（不共载第三方扩展）场景可作为可选加固，并在 README 说明其兼容性代价。

**残留（登记，§4 RR-4 / §6）**：若共载扩展**先于本扩展注册**且改写方向为「未授权 → 未授权但绕过 defaultDeny 的判定维度」（例如只改 `command` 而 policy 不校验 command），则仍可能逃逸 ①-a；此类情形的最终拦截依赖 ③ execute 复核的**校验维度完整性**——故 §7.4.4 规范性要求 4 强调「重算全部维度」。同时**建议向 omp 上游反馈**「`tool_call` handler 改写 input 的传播语义」作为平台契约问题（独立复评建议）。

#### 7.4.5 拒绝原因审计（N-4 定案：有解，无需前置条目）

> **实测结论（X23）**：`tool_execution_end` 的 `result.content[].text` **携带拒绝原因**——无论是我们的 `tool_call` block（`[ERR_PERMISSION] our-hook-block`）还是**宿主审批门直接拒绝**（`Tool "ops_d" is blocked by tool policy.\nReason: RR3-denied`）。
> 因此 **N-4 与 RR-3 均有解**：审计只需从 `tool_execution_end` 的结果文本中提取原因，按前缀分类即可区分拒绝层级，**不需要在 `tool_call` 内写前置条目**。

**统一审计钩子（v4.3 简化）**

```ts
// 约定拒绝原因前缀，便于分类（工具/兜底层统一遵守）
//   [ERR_PERMISSION] 授权/预授权类拒绝（①-a 首评、①-a 复评、①-b 兜底）
//   [ERR_POLICY]     内容/目标策略类拒绝（② 内容硬拒、③ execute 复核）
const REASON_CLASS = /^\[(ERR_PERMISSION|ERR_POLICY)\]/

pi.on("tool_execution_end", async (event: any) => {
  if (!event.toolName?.startsWith("ops_")) return
  const text: string | undefined = event.result?.content?.[0]?.text
  const reason = event.isError && typeof text === "string" ? text : undefined
  pi.appendEntry("ops_audit", {
    tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
    ts: new Date().toISOString(),
    authz: event.result?.details?.authz ?? (event.isError ? "blocked" : "unknown"),
    reasonClass: reason?.match(REASON_CLASS)?.[1]
      ?? (reason ? "host-policy" : undefined),   // 宿主审批门拒绝：文本无前缀，归 host-policy（含 Reason 行）
    reason,                                       // 原文保留，供追溯
  })
})
```

| 拒绝来源 | 审计可见信息 | 分类 |
|---|---|---|
| ② 内容硬拒（`tool_call`） | `[ERR_POLICY] 命中灾难性命令…` | `ERR_POLICY` |
| ①-b 无人值守兜底 | `[ERR_PERMISSION] guard-unattended / guard-production` | `ERR_PERMISSION` |
| ③ execute 复核 | `[ERR_POLICY] execute 侧复核拒绝…` | `ERR_POLICY` |
| ①-a 审批层（`policy:deny` / 档位硬失败） | 宿主文案，含 `Reason: <我们的 reason>`（如 `production`） | `host-policy` |

> **相对 v4.2 的变化**：删除「在 `tool_call` 内写前置 `appendEntry`」的做法（无必要且引入额外写操作）；**RR-3 由「残留」降级为「有解」**——宿主拒绝也能拿到原因文本。

### 7.5 输出截断（交宿主）

**不自研截断**。宿主对每个工具结果集中处理（O7）：超 `tools.artifactSpillThreshold`（默认 50KB）时**全文存 artifact**、内联换 head+tail（默认 20KB+20KB），上限 `DEFAULT_MAX_LINES=3000` / `DEFAULT_MAX_BYTES=50*1024`；覆盖全部扩展工具（含本扩展）。

- 工具**直接返回完整文本**；自截断会让 artifact 只存到截断后文本（丢数据）。
- 工具 `description` 中写明截断上限与「完整内容见 artifact」，让 LLM 知道去哪里取全文。
- L1 不参与截断（保持 `ops-core` 不依赖平台）。

### 7.6 跨 Agent 路径（身份归 Yuyi 插件；ops-pi 只做自身安全三层）

> **前提更新（主人 2026-09-12 指示）**：Yuyi 身份插件是 **omp 插件且自治**——身份与鉴权由它自己负责，**ops-pi 不接管、不重复实现、不请求其内部接口**。原「需 Yuyi 提供身份查询接口」（B1）**撤销**。

**设计结论：跨 Agent 请求不构成特殊路径。** 外部消息经 Hub → Yuyi 适配器 → 注入 ops 会话后，只是**一条普通输入**；LLM 据此编排 `ops_*` 工具时，**照常经过 §7.4 的三层**：

| 层 | 对跨 Agent 请求的作用 |
|---|---|
| ①-a 审批档 | 预授权命中（`targets[]`/令牌）→ `policy:"allow"`；未命中 → `policy:"deny"` 或交平台审批 |
| ①-b 无人值守兜底 | `!hasUI` 且未预授权 → **拒绝**（与来源无关；跨 Agent 请求在无人值守下不会获得额外放行） |
| ② 内容硬拒 | 灾难性命令一律拒绝 |
| ③ execute 复核 | 重算全部维度（含防入参篡改，§7.4.4） |

**因此**：

- **不需要**按「调用方御符身份/权限」做授权判定——ops-pi 的授权模型是**目标导向的 defaultDeny**（允许对哪些主机/服务做什么），与调用方身份无关，天然不受"谁能到达我"影响；
- 跨 Agent 的**写**路径**不会**因为"来自其他 Agent"而降级安全门；同样地，也**不会**因为身份可信而自动放行——**放行只取决于 Owner 预授权**；
- 身份/鉴权/防注入（`formatExternalMessage` 框定等）属 Yuyi 插件职责，ops-pi 仅在其系统提示中声明「外部请求不降级安全门」（§7.6 提示词片段）。

**降级（仅剩外部件缺席）**

| 情形 | 行为 |
|---|---|
| Yuyi 适配器缺席 | 无 `yuyi_*` 工具 → 跨 Agent 入口自然关闭；`ui.notify` 明示（本地运维不受影响） |
| 适配器在场 | 请求照常进入会话，**按三层评估**；未预授权的变更类操作被拒并回 `[ERR_PERMISSION]` |

**B1 的处置**：原「跨团队承诺：请 Yuyi 提供身份接口」**撤销**（前提不成立）。P5 任务已重界定为「跨 Agent 请求走同一安全三层」的**验证类**任务（对应验收：无旁路、默认拒绝、只读放行、负测留痕）。

### 7.7 斜杠命令（修正 v1.4 的绕过缺陷）

**事实**：命令 handler 直调（`command.handler(args, ctx)`），**不经** `tool_call`/`tool_result`（O19），故危险动作经命令执行会绕过审批与审计。规则：

| 命令 | 允许内容 | 安全保证 |
|---|---|---|
| `/ops-inspect <host> [checks]` | 只读聚合（等价 `read` 档） | 只读，不产生变更 |
| `/ops-health` | 只读聚合 | 只读 |
| `/ops-status <host>` | 只读聚合 | 只读 |
| 危险动作 | **不注册命令**；改为 `pi.sendUserMessage` 注入，由 LLM 经 `ops_*` 工具执行 | 走完整三层安全 + 审计 |

```ts
pi.registerCommand("ops-inspect", {
  description: "对指定主机执行标准巡检（只读）",
  handler: async (args, cmdCtx) => {
    const [host, checkCsv] = String(args ?? "").trim().split(/\s+/)
    if (!host) { cmdCtx.ui.notify("用法：/ops-inspect <host> [cpu,mem,disk,process,log]", "error"); return }
    const report = await runReadOnlyInspection(ctx, host, checkCsv?.split(","))   // 仅 read 档能力
    cmdCtx.ui.notify(`巡检完成：${report.summary.ok} 正常 / ${report.summary.warn} 警告 / ${report.summary.critical} 关键`,
      report.summary.critical > 0 ? "error" : "info")
    if (report.summary.critical > 0)
      pi.sendUserMessage(`巡检发现 ${report.summary.critical} 项关键异常，请分析：${JSON.stringify(report.items.filter(i => i.status === "critical"))}`, { deliverAs: "followUp" })
  },
})
// 只读命令还需自行落审计（命令路径不产生 tool_result）
```

**可验证断言**：仓库内不存在名为 `ops-deploy`/`ops-kill`/`ops-rollback` 的命令；命令处理器可达的 L1 方法集合 ⊆ `read` 档工具所用方法集合（契约测试遍历断言）。

### 7.8 钩子、定时器与审计

> **v4.1 修正**：①（R-1）`tool_call` 增加**模式无关的无人值守兜底层**（①-b）；②（R-2）`before_agent_start` 的 `event.systemPrompt` 在 omp 是 `string[]`，须先归一化再拼接；③（R-4）审计钩子由 `tool_result` 改为 **`tool_execution_end`**——实测被 `tool_call` 阻断的调用**不触发 `tool_result`**，用 `tool_result` 会漏掉 A4 要求的"含被拒绝的调用"。

```ts
// packages/ops-extension/src/hooks.ts
export function setupOpsHooks(pi: ExtensionAPI, ctx: OpsToolContext, config: OpsConfig): void {
  pi.on("session_start", async (_event, c) => {
    // ① vault 锁定提示（口令仅从环境变量读，§7.4.2）
    if (config.vault?.dbPath && !process.env.OPS_VAULT_PASSPHRASE)
      c.ui.notify("ops-pi vault 已锁定：使用 ops_vault_unlock 后凭据可用", "info")
    // ② 降级可发现性（联邦三要素，§7.4.3）
    if (!ctx.targetPolicy.isConfigured)
      c.ui.notify("未配置目标策略（policy.json）：变更类操作一律拒绝", "warning")
    // ③ 巡检轮询：宿主受管定时器（O5），session_shutdown 自动清理
    if (config.health?.autoPollIntervalMs)
      c.setInterval(async () => {
        const report = await ctx.health.checkAll()
        if (report.summary.critical > 0)
          pi.sendUserMessage(`[自动巡检] ${report.summary.critical} 项关键告警：${JSON.stringify(report.items.filter(i => i.status !== "ok"))}`, { deliverAs: "followUp" })
      }, config.health.autoPollIntervalMs)
  })

  pi.on("before_agent_start", async (event) => {
    const hints = buildScenarioHints(config)
    if (!hints) return
    // ★ R-2：event.systemPrompt 在 omp 是 string[]（实测），必须归一化后再拼接
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt.join("\n\n") : String(event.systemPrompt)
    return { systemPrompt: `${base}\n\n${hints}` }        // 返回 string 被平台接受（O10）
  })

  // 第①-b 层 + 第②层：均在 tool_call 内、均为同步判定、均与 approvalMode 无关
  pi.on("tool_call", async (event, c) => {
    if (!event.toolName.startsWith("ops_")) return
    const input = event.input as Record<string, unknown>
    // 契约：本 handler 只读判定，不改写 event.input（§7.4.4 规范性要求 2）

    // ② 内容硬拒：灾难性命令
    const cmd = String(input?.command ?? "")
    if (cmd) {
      const reason = criticalReason(cmd)
      if (reason) return { block: true, reason: `[ERR_POLICY] ${reason}` }
    }

    // ①-b 无人值守兜底：!hasUI 且未预授权 → 拒绝（不读 approvalMode，故 yolo 下依然生效）
    // 注：拒绝原因由 §7.4.5 的 tool_execution_end 审计统一提取，此处无需写前置条目（X23）
    if (!c.hasUI) {
      const req = asPolicyRequest(event.toolName, input)
      const layer = ctx.targetPolicy.isProduction(req) ? "guard-production"
        : needsOwnerAuth(event.toolName, input) && !ctx.preauthorized(req) ? "guard-unattended"
        : null
      if (layer) return { block: true, reason: `[ERR_PERMISSION] ${layer}` }
    }
  })

  // 审计：★ R-4 用 tool_execution_end（阻断与执行都触发；tool_result 对被阻断调用不触发）
  // ★ N-4/RR-3 有解（X23）：拒绝原因就在 result.content[].text，按前缀分类即可（§7.4.5）
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName.startsWith("ops_")) return
    const text = (event as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text
    const details = (event as { result?: { details?: { authz?: string } } }).result?.details
    const reason = event.isError && typeof text === "string" ? text : undefined
    pi.appendEntry("ops_audit", {                                  // O16：不进 LLM 上下文
      tool: event.toolName, toolCallId: event.toolCallId, isError: event.isError,
      ts: new Date().toISOString(),
      authz: details?.authz ?? (event.isError ? "blocked" : "unknown"),
      reasonClass: reason?.match(/^\[(ERR_PERMISSION|ERR_POLICY)\]/)?.[1]
        ?? (reason ? "host-policy" : undefined),
      reason,
    })
  })
}
```

- **拒绝层级如何可辨（N-4，v4.3 定案）**：无需前置条目——`tool_execution_end` 的结果文本已含拒绝原因（X23），按 `[ERR_PERMISSION]` / `[ERR_POLICY]` 前缀分类，宿主拒绝归 `host-policy`。
- **审计写入时机**：`tool_call` / `tool_execution_end` 属**加载完成后的运行期**（实测 `appendEntry` 正常），而 `getAllTools()` 等 action 方法在**加载期**不可用（X15）——两者边界不同，勿混用。

- **为什么审计不用 `tool_result`（R-4 实测）**：被 `tool_call` 阻断的调用事件序列为 `tool_call` → `tool_execution_start` → `tool_execution_end`，**无 `tool_result`**、`execute` 未运行。`tool_execution_end` 携带 `{toolName, toolCallId, result, isError}`，是覆盖"执行 + 拒绝"两类调用的正确落点。
- **与平台原生审计的分工（R-5）**：平台已在工具实现启动前写入原生 custom entry `tool_execution_start`（`src/session/exit-diagnostics.ts:5,200`，用于 resume 诊断）。ops-pi **不再重复记录启动标记**，只补运维语义字段（`authz` 授权来源、`blocked` 标记、目标对象），避免双份审计。
- **定时器**：`ctx.setInterval` 受管（O5），`session_shutdown` 自动清理；**不在扩展工厂内启动后台资源**（仅在 `session_start` 后启动）。
- **审计边界**：`appendEntry` 返回 void，条目落**当前 leaf 路径**；`getBranch()` 仅回溯当前分支（O17）。可读范围 = 当前会话分支；跨会话/跨分支的不可变审计需另落 artifact 或外部系统（v1 不做，登记 §6）。判型 `e.type === "custom" && e.customType === "ops_audit"`。
- **审批事件**（可选增强）：订阅 `tool_approval_requested`/`tool_approval_resolved`（O2）把平台审批与 ops 审计对齐，供外部审计系统消费。

---

## 8. 实施优先级与任务拆解

| Phase | 内容 | 可验收条目 |
|---|---|---|
| **P0 脚手架 + 平台校验 + 共载冒烟** | monorepo；`platform.ts` 能力前置校验；2 个只读工具（`loadMode:"essential"` + `approval:"read"`）；共载冒烟与工具名前缀断言；沙箱形态 | 需求包 A5；§5 Contract ①②③⑤ |
| **P1 MVP（只读）** | Shell + SSH + Process + File + Log 只读工具；§7.4.1 表落地；内容硬拒（第②层）；审计钩子 | 需求包 **A1**、A4 |
| **P2 指定服务重启** | `ops_service` + `targetPolicy`（P2 目标级预授权）；负测集 | 需求包 **A2** |
| **P3 高危批准 + 容器/K8s** | 批准令牌（P3）；Docker/K8s/Health；Owner 预授权文档 | 需求包 **A3** |
| **P4 编排 + 跨 Agent** | 巡检/诊断/自愈提示词；跨 Agent 只读降级路径 | §7.6 降级表 |
| **P5 B1 落地后** | 接入 Yuyi 身份接口，开放跨 Agent 写路径（需 Owner 逐项确认） | 待 B1 |

### 任务拆解（落定后填）

| 看板任务号 | 任务 | 可验收条目 | 级别 |
|---|---|---|---|
| **OPSP-P0** | 脚手架 + 平台能力前置校验 + 共载冒烟 | 5 条（见台账） | L1 |
| **OPSP-P1** | MVP：只读工具集 + 安全三层 + 审计 | 5 条（见台账） | L1 |
| **OPSP-P2** | 指定服务重启 + 目标策略 | 5 条（见台账） | L2 |
| **OPSP-P3** | 高危批准令牌 + Docker/K8s/Health | 4 条（见台账） | L2 |
| **OPSP-P4** | 编排模式 + 跨 Agent 只读降级路径 | 4 条（见台账） | L2 |
| **OPSP-P5** | 接入 Yuyi 身份接口开放跨 Agent 写路径（**依赖 B1，阻断**） | 3 条（见台账） | L3 |

> **任务面落点（已补齐机制）**：台账 `<目标项目>/docs/tasks/<taskId>.yaml`，操作入口 `scripts/task-ledger.mjs`（本次落定后新实现，符合 `principle/task-and-memory-surface.md` 五操作 + 四态状态机 + 四不变量 + `rescope`；`--selftest` 10 项 / `--validate` 通过）。目标仓 `github.com/lomehong/oh-my-ops`，分支 `main`；台账不持久化设备路径（随项目版本化）。
> 任务已立项（`create`），全部处于「待执行」；执行方按分工 `claim` 认领，完成后 `report` 自报，**`confirm` 只能由主人发起且必须带来源**（脚本级拒绝无来源确认、非法跳步、未落定归档）。

---

## 9. 决策门记录

| 命中门 | 决策 | 决策人/时间 |
|---|---|---|
| **平台决策（最新，覆盖 v3.0）** | 运行时目标 = **oh-my-pi（omp）**；理由：pi 平台能力过于简陋（无审批子系统/受管定时器/输出 spill，schema 偏 legacy） | 主人 2026-09-12 |
| Conflict（方案 vs 事实） | 撤销 v3.0 的宿主中立适配层，直接依赖 omp 平台（依据：联邦原则「宿主平台注入不受限」） | 本版 §7.2 + §1 Don't 说明 |
| Business Trade-off | schema 用 `pi.zod`（原生）而非 `pi.typebox`（legacy/compat） | 本版 §7.3（O14/O15） |
| Cross-team Commitment | 走 Yuyi 受支持身份接口（B1，**阻断**，需主人中转） | 主人 2026-09-12 |
| High-risk Change | 档位表 + 生产变更禁止无人值守 + 高危需 Owner 明示批准 | 主人 2026-09-12 |
| Unknown（需求来源） | 验收标准 A1–A4 由主人口述确认 | 主人 2026-09-12 |
| 环境（仓库/git） | 目标仓 `github.com/lomehong/oh-my-ops`（分支 `main`）；目录按适配层标准 `docs/designs\|reports\|tasks` | 主人 2026-09-12 |
| **方案落定** | v4.3 经两轮独立复审 + 主人确认，状态改「**已落定**」；进入任务拆解与实现（§8） | 主人 2026-09-12 |

---

## 附录 A：历史版本发现处置对照

| 编号 | 原发现 | v4.0 处置 |
|---|---|---|
| P0-1 | 斜杠命令绕过审批与审计 | **成立**（O19）→ §7.7 |
| P0-2 | 自研 `authorize()`（v2.0 判「与宿主重复」应全交宿主） | **采纳「用宿主审批」**，但**依据更正**：不是「自研有错」，而是「宿主已选 omp，其原生审批够用」。OMP 侧判定顺序见 O3，本方案用函数式 `approval` + `policy` 表达目标级授权 |
| P0-3 | `input` 返回契约「错误」 | **原判基于错误基准**（`{action}` 是 pi 契约，非 omp）→ 本版按 omp 契约（O9）；且核心不使用 `input` 做关键逻辑 |
| P0-4 | 御符门无法复用实例；无降级定义 | **成立**（O12）→ §7.4.3 + §7.6 + N2 |
| P0-5 | 截断：数字与自截断之争 | **按宿主事实定稿**：omp 为 3000 行/50KB 且集中 spill（O7）→ §7.5 交宿主，不自截断 |
| P1-1 | schema 走 legacy/compat | **成立**（O15）→ 改用 `pi.zod`（原生，O14） |
| P1-2 | 双运行时/宿主中立 | **已废止**：平台选定 omp，撤销适配层（§7.2） |
| P1-3 | `terminate` 非契约字段 | omp 侧确无该字段（`ToolCallEventResult` 仅 `block/reason/input`）→ 本版不使用 |
| P1-4 | `ctx.setInterval` 处理倒退 | **成立**（O5）→ 回归宿主受管定时器（§7.8） |
| P1-5 | 内容风控弱于宿主 | **部分成立**：以宿主 `CRITICAL_BASH_PATTERNS`（O18）为下界 + 绝对路径锚点（§7.4 第②层） |
| P1-6 | 审计未用宿主机制、`getBranch` 语义未声明 | **成立** → §7.8 声明可读边界 |
| P2-1 | 工具重名静默 last-wins | **成立**（O11）→ §5 Contract ② |
| P2-2 | 文档写 `pi -p` vs 实际 `omp` | 全文改 `omp` |
| P2-3 | 无依赖清单 | 本版明确：L1 仅 Node + CLIs；L2 依赖 omp 平台注入面（`pi.zod`）+ 宿主包类型；**无第三方 schema 包** |
| P2-4 | 结构不符模板 | 本版按 `templates/executable-design.md` 重排 |
| P2-5 | 目录命名漂移 | 登记 B3 待确认 |
| **新增** | `loadMode` 默认 discoverable → 工具 `approval` 声明失效 | **§7.3 必修 + §5 Contract ③ + 负测 ⑤**（X4–X6 实证） |

## 附录 B：变更记录

### v4.3（2026-09-12）——按独立复审（第二轮）定案 N-1 / N-4

第二轮独立复审（`docs/reports/independent-recheck-2-2026-09-12.md`，新探针、方法学改进）**升级 N-1、修正 N-2、加重确认 N-3、判定 N-4 有解**，并附发现「`approval` 被求值 3 次」。v4.3 据此定案：

- **N-1 定案（机制更正 + 防御矩阵）**：原判「审批看改写前、执行看改写后」不准确。实测机制为——① `approval` **被求值 3 次**（X21）；② **首评看到模型原始入参**，且 `policy:"deny"` **在任何 `tool_call` 钩子之前短路**（X20，决定性：伪造为已授权值的攻击被击破，钩子根本没运行）；③ 后两次求值看改写后入参；④ 扩展**无法**从会话分支回溯原始入参（X24）。**§7.4.4 重写**为四方向防御矩阵 + 6 条规范性要求，核心是「**预授权必须以 `defaultDeny` 表达在审批层**」与「**`authorizedExec` 必须纯函数**」。
- **令牌消费时点**：因 3 次求值，`authorizedExec` 只做只读校验；令牌消费移至 `execute` 复核通过后（§7.4.2/§7.4.4 规范 3）——闭合复审指出的 TOCTOU。
- **N-2 措辞修正**：复审确认「不可行的是**加载期**，`session_start` 后移**可行**」——与 v4.2 修订一致，本轮补入「加载期窗口由 ①-b 覆盖」表述。
- **N-4 定案（有解）**：`tool_execution_end.result.content[].text` **携带拒绝原因**（X23，含宿主审批门拒绝），按前缀分类即可 → **§7.4.5 重写**，**删除** v4.2 的「前置 `appendEntry`」做法；**RR-3 由残留降级为已解决**。
- **可选加固**：`Object.freeze(event.input)` 实测可阻断后续改写（X22），但破坏平台允许的「共载扩展打补丁」用法 → **默认不启用**，仅高隔离场景可选（§7.4.4）。
- **§3.1 新增 X20–X24**；§4 RR-4 精化为「三方向已有拦截层 + 前提条件 + 可选加固 + 建议上游反馈」；§6 第 9 项补全四条宿主已知限制与对应处置。

### v4.2（2026-09-12）——按独立复评 N-1～N-4 修订

独立复评（`docs/reports/independent-recheck-2026-09-12.md`，隔离会话 + 独立探针）**独立复现 v4.1 三项修复全部成立**，并新发现 4 项；v4.2 逐项修订：

- **N-1（P1 安全）input 共享可变 → 授权判定与执行实参可能不同值**。新增 **§7.4.4「input 一致性」**：明确威胁面（共载扩展改写入参）、三层同值校验布局（①-b 覆盖先注册的改写／①-a 覆盖后注册的改写／③ execute 复核为权威）、四条规范性要求（`assertAuthorized` 必须置于 execute 首行、handler 不得改写 input、复核拒绝留痕、README 标注）。**实测取证**：X16（先注册改写 → ①-b 拦截）、X17（后注册改写 → ①-a 对最终入参返 `policy:deny`，工具未执行）。
- **N-2（P1 设计可行性）启动期断言在加载期不可实现**。`getAllTools()` 在扩展工厂内抛 `Extension runtime not initialized`（X15）；§5 Contract ② 断言时机改为 **`session_start` 首次触发** + `throw`，并显式声明性质是**检测 + 拒绝继续**、不是阻止覆盖（覆盖在断言前已定格）。
- **N-3（P2 正向）**：补入「loadMode 漏声明 + `xd://` 路径下 ①-b 仍拦截」的纵深防御实证（§5 Contract ③）。
- **N-4（P2 审计粒度）**：新增 **§7.4.5「拒绝层级审计」**——①-b/② 在 `tool_call` 内写带 `layer` 的**前置审计条目**（实测可落库，X18）、③ 在抛错前写 `execute-revalidation`；①-a 宿主拒绝无法介入 → 登记 **RR-3**。
- **§4 新增 RR-4**（共载扩展可改写入参）与 **§6 新增第 9 项**（宿主已知限制：共享可变 input、last-wins 只能后移断言）。
- **§5 负测** 新增 ⑨（N-1 三种时序回归）与 ⑩（拒绝层级可辨）。
- **§3.1 新增 X15–X19**（独立复评取证 + v4.2 决定性验证）：X19 证明 ③ execute 复核**不可替代**——预授权主机的 `command` 被改写为 `rm -rf /` 时 ①-b/①-a 均放行，仅 ③ 拦住（探针 `v42-execute-revalidation-probe.ts` 入库）。

### v4.1（2026-09-12）——按 architect-review 驳回意见修复（评审报告 `docs/reports/ops-pi-review-v4-2026-09-12.md`）

评审结论：48/60，驳回（五问 10/10，无维度 ≤5，总分未达 50 分线）。本轮修复 4 项缺口：

- **R-1（P0 安全）默认 yolo 下 `override` 被忽略 → 未授权操作静默执行**。`authorizedExec()` **移除 `override`**；新增 **①-b 模式无关兜底层**（`tool_call` 内 `!ctx.hasUI && needsOwnerAuth && !preauthorized → {block:true}`）。实测：yolo + 非交互下未预授权被拒、已预授权放行（X9 漏洞 / X10 修复）。§4 安全段同步改写。
- **R-2（P0 正确性）`event.systemPrompt` 是 `string[]`**，§7.8 样例改为先 `join("\n\n")` 归一化再拼接（X12 实测类型为 array）。
- **R-4（P1 审计完整性）`tool_result` 不覆盖被阻断调用** → 审计钩子改用 **`tool_execution_end`**（携带 `toolName/toolCallId/result/isError`，阻断与执行都触发；X11 实测事件序列）。原设计会漏掉 A4 要求的"含被拒绝的调用"。
- **R-5/R-6（P2）**：明确与平台**原生审计条目** `tool_execution_start` 的分工、避免双份审计；§2 新增「部署配置 `approvalMode ≠ yolo`」约束行；§7.2 写明**探针读不到 `approvalMode`** 的能力边界（X14），§6 新增**残留风险 RR-1/RR-2** 显式登记。
- **§5** 契约断言与负测清单同步：新增「yolo + 非交互未授权必须被拒」回归项与「被拒调用须留审计」项；回归项扩至 X1–X14。
- **§3.1** 新增 X9–X14（本次评审实测证据）。

**修复后预估复评**：需求 10 / 系统 9 / 证据 9 / 风险 9 / 验证 10 / 不确定性 9 = **56/60**（预估，非自评通过；须 re-review + 主人确认）。

### v4.0（2026-09-12）——平台决策落定：omp 单一目标

- **运行时目标定为 omp**（主人 2026-09-12）：撤销 v3.0 的宿主中立适配层（`src/host/`），平台能力改为**直接依赖 + 启动期前置校验**（§7.2，缺失即硬失败）。
- **schema 改用 `pi.zod`**（原生 omptype 支撑的 Zod 门面，官方示例同款），弃用 `pi.typebox`（官方标 legacy/compat）。
- **安全模型**：三层分工保留；① 审批层改为**直接使用宿主原生 `approval` + 判定顺序**（O2/O3），用函数式 `approval` 返 `{policy:"allow"\|"deny"}`/`override` 表达 Owner 预授权三形态。
- **截断**：交宿主集中 spill（3000 行/50KB，全文入 artifact），不自研（O7）。
- **定时器**：回归 `ctx.setInterval` 受管版（O5）。
- **新增平台能力前置校验**（§7.2）：区分「外部增强缺席 → 降级」与「平台能力缺失 → 硬失败」。
- **合规依据显式化**：引用联邦原则「宿主平台注入不受限」，说明直接依赖 omp 的正当性。
- **证据表重构**：O1–O19（omp 18.1.18）+ X1–X8（实测）+ U1–U2（Unknown）；上游 pi 对照（P#）移入矩阵文件。

### v3.0 / v2.0 / v1.0–v1.4
见旧版变更记录与 `docs/reports/pi-vs-omp-host-capability-matrix.md`、`docs/reports/ops-pi-design-review-2026-09-12.md`（含对早期误判的勘误）。

---

## 附录 C：Yuyi 接口请求书（**已撤销**）

> **2026-09-12 主人指示撤销**：Yuyi 身份插件是 omp 插件且**自治**——身份与鉴权在其内部完成，ops-pi **不接管、不集成、不请求内部接口**。
>
> 因此原「请 Yuyi 提供查询调用方身份/权限的受支持接口」的跨团队请求**不再提出**（原 B1 阻断项撤销）。
>
> **对安全模型的影响**：ops-pi 的授权模型本就是**目标导向的 defaultDeny**（允许对哪些主机/服务执行什么），与调用方身份解耦；跨 Agent 请求经同一三层评估（§7.6），既不因"来自其他 Agent"降级，也不因身份可信而放行。这反而**简化**了设计：无需跨团队接口、无第二个 Hub 连接、无身份状态复制。
>
> **保留的相关约束**（仍生效）：禁止在扩展内 `import` 第三方内部类以复用其实例（N2，会得到第二实例）；共载时工具名前缀不相交（启动期断言）。
