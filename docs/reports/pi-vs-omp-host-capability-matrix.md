# 宿主能力矩阵：上游 pi 0.84.1 ⨯ oh-my-pi（omp）18.1.18

> 用途：omo 方案（及任何 pi 血统扩展）的**宿主契约基准**。核心代码按上游 pi 契约写；omp 专有能力视为**可选增强**并显式降级。
> 证据基准（本机实测，2026-09-12）：
> - **上游 pi** `@earendil-works/pi-coding-agent@0.84.1`（npm 实装解包，含 `dist/core/extensions/types.d.ts` 与 `docs/extensions.md`）
> - **omp** `@oh-my-pi/pi-coding-agent@18.1.18`（`/usr/local/lib/node_modules/.../src`）
> - 上游 pi 最新版为 **0.85.1**；本文以 0.84.1 为准（omo 方案声明的基线版本）。
> 标注：**一致** = 两宿主同形；**分歧** = 需适配层；**pi-only** = 仅上游有；**omp+** = 仅 omp 有的增强。

---

## 1. 结论摘要

**上游 pi 是扩展契约的事实标准；omp 是其下游宿主，通过 `legacy-pi-compat` 兼容层运行 pi 扩展，并额外提供若干增强。**

三条对 omo 设计有决定性影响的结论：

1. **上游 pi 没有审批子系统**。`ToolDefinition` 无 `approval` 成员；`docs/extensions.md` 把 "Permission gates (confirm before `rm -rf`, `sudo`, etc.)" 列为**需要扩展自己实现**的用例。→ **核心必须自研审批门**，omp 的原生 `approval` 档位只能当增强。
2. **上游 pi 要求工具自行截断输出**（硬性契约，非建议）："**Tools MUST truncate their output**"，内置上限 **50KB / 2000 行**，并规定截断后**把完整输出写临时文件、把路径告知 LLM**。→ 核心必须自截断；omp 的集中 artifact spill 是另一套机制。
3. **schema 与枚举可无适配层共存**：`import { Type } from "typebox"` 是 pi 官方写法，`StringEnum` 来自 `@earendil-works/pi-ai`；两者在 omp 下同样可加载（omp 把这两个 specifier 重映射到自己的 shim）。→ **单一写法即可覆盖两宿主**。

---

## 2. 扩展面能力矩阵

| # | 能力 | 上游 pi 0.84.1 | omp 18.1.18 | 判定 | 对设计的含义 |
|---|---|---|---|---|---|
| 1 | 入口契约 | `export default function (pi: ExtensionAPI)`（可 async） | 同（`getExtensionFactory`: module 或 `.default` 为函数即可） | **一致** | 单一写法 |
| 2 | schema 构建器 | `import { Type } from "typebox"`（`docs/extensions.md` Quick Start；**`typebox: 1.3.7` 是 pi-coding-agent 的直接依赖**，故 pi 上是**真实 TypeBox**） | 注入 `pi.typebox.Type`；裸 `typebox`/`@sinclair/typebox` specifier 被重映射到 omp 的 `legacy-typebox` shim（底层为 omptype，`Type = {...OmpType, Object, Unsafe}`） | **写法一致，实现不同** | 用 `import { Type } from "typebox"` —— pi 官方写法，omp 下自动落到 shim，**无需适配层**。⚠️ 但两边是**两套实现**：仅用 `Object/String/Number/Optional/Enum` 等基础组合子可安全双跑；`Type.Unsafe` 及 TypeBox 高级 API 语义不同（pi=真实文档；omp shim 为补丁实现，且 omptype 自身的 `Unsafe` 会丢弃 document），**核心避免使用** |
| 3 | 字符串枚举 | `StringEnum` from `@earendil-works/pi-ai`（**已核实包根导出**：`dist/index.d.ts:32` → `utils/typebox-helpers`；签名 `StringEnum<T extends readonly string[]>(values, {description?, default?})`，文档注释明确 "compatible with Google's API and other providers that don't support anyOf/const patterns"） | 经 `legacy-pi-ai-shim` 提供同名 `StringEnum`（实测可加载） | **一致** | 用 `StringEnum`，两宿主均可 |
| 4 | **原生审批** | **无**。`ToolDefinition` 无 `approval`；`approvalMode`/`tools.approval` 在 dist 与文档中零命中；permission gate 列为「自己实现」用例 | 有：`approval?: ToolApproval`（默认 `exec`）、`approvalMode: always-ask\|write\|yolo`、`tools.approval.<tool>` 覆盖、`tool_approval_requested/resolved` 事件 | **omp+** | **核心自研审批门**（pi 必需）；omp 上可选叠加原生档位作增强 |
| 5 | 定时器 | `ExtensionContext` **无** `setInterval` | `ctx.setInterval`（受管，`session_shutdown` 自动清理） | **omp+** | 核心用 Node `setInterval` + `session_shutdown` 清理；omp 可切受管版 |
| 6 | `input` 事件返回 | `{action:"continue"} \| {action:"transform", text, images?} \| {action:"handled"}` | `{handled?: boolean; text?; images?}` —— **无 `action`**，且未发现翻译层 | **分歧** | **需适配层**：两宿主返回形状不同，同一实现不能双跑 |
| 7 | `tool_call` 返回 | `{block?, reason?, terminate?}`；`terminate` 有文档语义（同批全部 terminate 才提前结束） | `{block?, reason?, input?}` —— **无 `terminate`** | **分歧** | 核心用 `block`+`reason`（两宿主同名）；`terminate` 仅 omp 外可用 |
| 8 | `event.input` 可变性 | 文档明示：**就地可变**，后续 handler 可见、**不再重新校验** | 同（`wrapper.ts` 中 `callResult?.input !== undefined` 可替换执行入参） | **一致** | 可用于参数补丁（注意「不再校验」的安全含义） |
| 9 | `before_agent_start` 系统提示 | 返回值 `{ systemPrompt?: string }`（**string**） | 声明 `string[]`，但运行时**接受 string**（`runner.ts:1751` 做了 `typeof === "string" ? [x] : x`） | **一致（omp 向下兼容）** | 核心返回 `string` 即可双跑 |
| 10 | **输出截断** | **平台硬性要求工具自截断**；导出 `truncateHead`/`truncateTail`/`truncateLine`/`formatSize`/`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`（**已核实均从包根导出**，实现在 `core/tools/truncate.d.ts`：`truncateHead(content, {maxLines?, maxBytes?}): TruncationResult`，返回 `{content, truncated, truncatedBy, totalLines, totalBytes, outputLines, outputBytes, ...}`；`DEFAULT_MAX_LINES = 2000`、`DEFAULT_MAX_BYTES = 50KB`）；文档规定截断后写临时文件并告知 LLM 路径；**无宿主侧 artifact/spill 机制** | 宿主集中 spill：超 `tools.artifactSpillThreshold`（默认 50KB）时全文存 artifact、内联换 head+tail；常量 `DEFAULT_MAX_LINES=3000`/`DEFAULT_MAX_BYTES=50*1024`；覆盖全部扩展工具；无 per-tool 放宽字段 | **分歧（机制不同）** | 核心**必须**自截断（pi 契约）；omp 上需避免「先自截断导致 artifact 只存到截断后文本」 |
| 11 | `execute` 签名 | `execute(toolCallId, params, signal, onUpdate, ctx)` | 同 | **一致** | 单一写法 |
| 12 | 工具装载模式 | `ToolDefinition` **无** `loadMode`（工具直接进顶层 schema） | `loadMode?: "essential"\|"discoverable"`；**默认 `discoverable`** → 挂 `xd://` 设备，经外层 `write` 工具派发 | **omp+（且默认危险）** | 核心不需声明；**omp 部署必须显式 `loadMode:"essential"`**，否则自身审批档位失效（见 §4） |
| 13 | `ctx.ui` | `select/confirm/input/notify/onTerminalInput/setStatus/setWidget/setFooter/setHeader/setTitle/custom/pasteToEditor/setEditorText/getEditorText/editor/addAutocompleteProvider` | 同名面（`confirm(title,message,opts)`、`notify(msg,type)` 等） | **一致（核心交集）** | 用 `confirm`/`notify`/`select` 双跑 |
| 14 | `ctx.hasUI` / `ctx.mode` | 有。`-p`→`hasUI:false`（"can't prompt"）；`--mode json`→`false`（UI 为 no-op）；rpc→`true`；tui→`true` | 有 `hasUI`；`ctx.setInterval` 存在 | **一致** | 无人值守判定用 `hasUI` |
| 15 | `tool_call` handler 超时 | 文档未规定 | **30s fail-closed**（`EXTENSION_HANDLER_TIMEOUT_MS`，超时 `{block:true}`） | **omp+（约束）** | 核心不得在 hook 内长 await 人工交互（omp 上会被判超时阻断） |
| 16 | 错误语义 | 「`tool_call` 错误 **block** 该工具（fail-safe）」；「`execute` 错误必须 throw，被捕获后以 `isError:true` 报给 LLM」 | 同（`emitToolCall` 出错 fail-closed；`execute` throw 置 `isError`） | **一致** | 单一错误处理写法 |
| 17 | 会话持久化 | `pi.appendEntry(customType, data)`（**不进 LLM 上下文**）；`registerEntryRenderer` 可渲染 | 同（`CustomEntry`，`customType` 判型） | **一致** | 审计条目用 `appendEntry` |
| 18 | 分支读取 | `ctx.sessionManager.getBranch()`（文档示例 `// Current branch`） | `getBranch(fromId?): SessionEntry[]`，**仅当前 leaf 路径** | **一致（语义需留意）** | 审计可读范围 = 当前分支 leaf 路径 |
| 19 | 命令 | `pi.registerCommand(name, {description, handler})`；handler `(args, ctx)`；生命周期文档注明**命令先于 `input` 被检查并短路** | 同签名 | **一致** | 命令路径同样**不经** `tool_call`（≠ 工具调用） |
| 20 | 工具枚举/激活 | `getAllTools(): ToolInfo[]`、`setActiveTools(names): void`、`getActiveTools(): string[]` | 同（`setActiveTools` 返回 `Promise<void>`） | **一致（返回值微差）** | 忽略返回值即可双跑 |
| 21 | 消息注入 | `sendUserMessage(content, {deliverAs?: "steer"\|"followUp"})`；`sendMessage` 另有 `"nextTurn"` | `sendUserMessage(..., {deliverAs?: "steer"\|"followUp"\|"aside"})` | **一致（omp 超集）** | 核心只用 `steer`/`followUp` |
| 22 | shell 执行 | `pi.exec(command, args[], options?)` | 同 | **一致** | 单一写法 |
| 23 | 跨扩展共享 | **无**服务注册表、无 `getExtension`、无 `invokeTool`、无跨扩展调用工具 | 无服务注册表；**唯一共享对象是 `EventBus`**；`getAllTools()` 仅元数据；`ctx.invokeTool` 为同名原生转发且跳过审批 | **一致（都无）** | 不能靠 import 复用第三方扩展实例（per-entry 加载 → 第二实例） |
| 24 | 扩展发现 | `~/.pi/agent/extensions/*.ts`、`~/.pi/agent/extensions/*/index.ts`、`.pi/extensions/*.ts`、`.pi/extensions/*/index.ts`；另可 `settings.json` 的 `extensions[]` | `<agentDir>/extensions`（默认 `~/.omp/agent/extensions`）、项目 `.omp/extensions` | **分歧（路径）** | 部署说明按宿主分别写 |
| 25 | CLI 加载 | `pi -e ./x.ts`（可重复）；`-p` 非交互；`--mode json\|rpc` | `omp -e ./x.ts`（可重复）；`-p`；`--mode text\|json\|rpc\|rpc-ui`；另有 `--approval-mode`、`--auto-approve` | **分歧（命令名/参数）** | 部署说明按宿主分别写 |
| 26 | 加载器 | jiti（TS 免编译） | Bun 原生 import + per-entry `?mtime`（支持同进程热重载） | **实现不同，契约同** | 无影响 |
| 27 | 热重载 | `/reload`（仅自动发现位置的扩展） | 支持 | **一致** | — |
| 28 | 项目信任 | `project_trust` 事件；`ctx.isProjectTrusted()`；`.pi/extensions` 仅在项目受信后加载 | `isProjectTrusted()` 恒 `true`（omp 不做信任门控） | **omp 降级** | 核心若依赖信任态，omp 上等于恒 true |
| 29 | 打包/分发 | `settings.json` 的 `packages[]`（`npm:`/`git:` 前缀）；package.json 的 `pi.extensions` 字段；运行时依赖须在 `dependencies`（生产安装 omit dev） | 插件体系（`plugins/loader`） | **分歧** | 分发方式按宿主说明 |

---

## 3. 关键分歧的处置（核心 + 适配层）

只有 **3 处分歧真正影响同一份代码**，其余要么一致、要么是 omp 侧增强（可探测后启用）：

| 分歧 | 上游 pi | omp | 适配策略 |
|---|---|---|---|
| **D-A `input` 返回形状** | `{action:"transform"\|"handled"\|"continue"}` | `{handled?, text?}`（无 `action`） | 适配层返回宿主对应形状；或**核心不在 `input` 上做关键逻辑**（本方案采用后者：工具过滤已删除，场景引导改为 `before_agent_start` 提示词） |
| **D-B 输出截断职责** | 工具**必须**自截断（50KB/2000 行）+ 完整输出落临时文件 | 宿主集中 spill（3000 行/50KB，全文存 artifact） | 截断模块由宿主适配层选择：pi → 自截断 + 临时文件；omp → 直接返回完整输出交宿主 spill（避免 artifact 只存截断后文本）。**上限常量按宿主取** |
| **D-C 工具装载模式** | 无此概念，工具直接可用 | 默认 `discoverable` → 挂 `xd://`，**自身 `approval` 档位失效** | omp 适配层为每个 `ops_*` 显式声明 `loadMode:"essential"`；pi 侧该字段被忽略（无害） |

**可无适配层的部分**：入口契约、schema（`typebox`）、枚举（`StringEnum`）、`execute` 签名、错误语义、`appendEntry`、`getBranch`、`ui.confirm/notify`、`hasUI`、`getAllTools`/`setActiveTools`、`sendUserMessage`、`exec`、`before_agent_start`（string 兼容）。

**⚠️ 补充：写法一致 ≠ 实现一致**。`import { Type } from "typebox"` 在 pi 上解析到**真实 TypeBox 1.3.7**（pi-coding-agent 的直接依赖），在 omp 上被重映射到 omptype shim。基础组合子（`Object`/`String`/`Number`/`Boolean`/`Optional`/`Enum`/`Array`）语义相同；但 `Type.Unsafe` 及 TypeBox 高级 API 语义不同（pi=真实 document；omp shim 为补丁实现）。**约束：核心只用基础组合子**，高级 TypeBox 能力经宿主适配层按需引入。

---

## 4. 反向风险（omp 特有的、会削弱安全语义的行为）

| 风险 | 证据 | 后果 | 处置 |
|---|---|---|---|
| 默认 `loadMode: "discoverable"` | `src/tools/essential-tools.ts:23-47`：非内建白名单名字一律 `discoverable`；实测 `always-ask` 下 discoverable 的只读扩展工具**不可达**，且 `policy:"allow"` 的设备策略**未被咨询** | 工具自身审批声明不是控制门；最严模式下连只读工具都不可用 | 显式 `loadMode:"essential"`（实测后 `always-ask` 下正常执行） |
| `tool_call` handler 30s fail-closed | `runner.ts:86` `EXTENSION_HANDLER_TIMEOUT_MS = 30_000`；超时 `{block:true}` | hook 内 `await ui.confirm` 超 30s 即被误判为超时并阻断 | hook 内只做**同步**判定；人工交互交 `approval` 档位或工具内 `ui.confirm` |
| 审批默认模式 `yolo` | `wrapper.ts:198` `?? "yolo"` | 不显式配置时宿主审批不生效 | 部署要求显式设 `approvalMode` |
| 工具重名静默 last-wins | `runner.ts` `getRegisteredTool` 逆序遍历；`sdk.ts:3874` 注释 | 与共载扩展重名无报错，静默覆盖 | 启动期断言工具名前缀不相交 |

---

## 5. 实测记录（可复跑）

| 探针 | 宿主与模式 | 结果 |
|---|---|---|
| 静态 `import { Type } from "typebox"` 注册工具 | omp 18.1.18（无 `node_modules`） | 正常加载注册 |
| `import { StringEnum } from "@earendil-works/pi-ai"` 注册工具 | 同上 | 正常加载注册 |
| `approval:"read"` 工具调用 | omp `--approval-mode write` 非交互 | 无交互直接执行 |
| `override:true` 工具调用 | omp `--approval-mode write` 非交互 | 硬失败：`requires approval but no interactive UI available` |
| `policy:"deny"` 工具调用 | omp `--approval-mode yolo` | 仍拒绝：`is blocked by tool policy` |
| discoverable 只读扩展工具 | omp `--approval-mode always-ask` 非交互 | **不可达**（外层 `write` 门先拦） |
| `loadMode:"essential"` + `approval:"read"` | omp `--approval-mode always-ask` 非交互 | **正常执行** |

---

## 6. 版本与漂移提示

- 上游 pi 迭代快（0.80.3 → 0.85.1）；omp 迭代亦快（本机 18.1.18，方案旧版曾记 18.1.10）。**本矩阵须随任一宿主升级复核**，复核入口 = §5 探针脚本。
- omp 持续维护 legacy-pi 兼容（CHANGELOG 多处修复 `@earendil-works/pi-ai` 导入、`pi-coding-agent` 根导出缺失等），说明 omp 侧**有意图**保持 pi 扩展可运行；但 D-A/D-B/D-C 三处分歧目前**未**见自动翻译层，不可假定兼容。
- 蒸馏建议：本文件为「宿主事实」类素材，宜入 `architect-knowledge/reference/`（`status: 待审核`），须先经主人确认。
