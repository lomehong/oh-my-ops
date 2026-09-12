# OpsPi 设计决策简报（供主人决策）

> 配套：`docs/reports/ops-pi-design-review-2026-09-12.md`（评审结论：驳回，16/60）
> 目的：把评审提出的 6 个决策门展开为「事实 → 选项 → 代价 → 后果 → 可逆性 → 建议」，使决策可在不理解源码的前提下完成。
> 证据基准：oh-my-pi `omp` **18.1.18** 实装源码（本机 `/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent`）。
> 说明：`base pi v0.84.1` 与 `yuyi-pi-extension.ts` **本机不存在**，相关结论标注为「不可回源」。

---

## 决策总览

| # | 决策 | 类型 | 影响面 | 我的建议 | 可否事后改 |
|---|---|---|---|---|---|
| D1 | 审批/安全门用宿主机制还是自研 | Conflict（方案 vs 已确认知识） | §4.4、§7.3、§7.4、§7.5 | **三层分工**：宿主 approval 档 + 内容级硬拒 + 工具内目标策略 | 可（加字段/删分支） |
| D2 | 是否保留 base pi 双运行时 | Business Trade-off | §1.3、§4.11、依赖清单 | **放弃**，保留一行取用接缝 | 可，但 schema API 选型返工 |
| D3 | 跨 Agent 请求的鉴权来源 | Cross-team 承诺 | §4.6、§7.2、§7.6 | **v1 只读开放、写操作要人批**，不接第三方内部类 | 可（后续加） |
| D4 | 无人值守下每个 ops 工具放行到哪一档 | High-risk Change | §4.5、§7.4、§8 Phase 3/4 | 按下方**分档表**，`approvalMode: write` | 可（改配置） |
| D5 | 需求来源与验收判据 | Unknown | §1、§7（需求覆盖维度） | 你口述 3 句，我出需求包待你确认 | 可 |
| D6 | 代码落到哪个仓 / 是否 git 化 | 环境 | 全流程纪律 | 你指定仓库位置；否则我 `git init /workspace` | 可 |

---

## D1 审批与安全门：宿主机制 vs 自研

### 这个问题到底在问什么

危险操作执行前，谁来拦住它、谁来判断「这次可以放行」。方案自研了一套 `authorize()`（交互弹窗 + 非交互白名单）；而宿主 OMP 本来就有一套完整的审批子系统。二选一，或分工。

### 事实（源码级）

1. **宿主审批是"每个工具自己声明档位"的模型**：`ToolDefinition.approval?: ToolApproval`（`extensions/types.ts:640-642`，注释：*Defaults to `"exec"` when omitted*）。档位三值：`read` / `write` / `exec`（`tools/approval.ts:29`）。省略声明 = 最严的 `exec`。
2. **判定顺序固定**（`tools/approval.ts:115-214`）：工具档位 → 用户配置 `tools.approval.<名字>: allow|deny|prompt` → **模式档位比较**。
3. **模式三值**（`approval.ts:14,37-41`）：`always-ask`（最高放行到 `read`）、`write`（放行到 `write`）、`yolo`（放行到 `exec`）。
   比较规则 `TIER_RANK[tier] <= TIER_RANK[max]` → **`read` 档工具在三种模式下都自动放行**（含最严的 always-ask）。
4. **默认模式是 `yolo`**：`const configuredMode = settings?.get("tools.approvalMode") ?? "yolo"`（`wrapper.ts:198`；`session-tools.ts:702-706` 注释复述「schema default is also yolo」）。即**不做配置时，宿主审批等于不存在**。
5. **参数级判定原生支持**：`approval` 可以是函数 `(args) => 决策`，且决策可带 `policyKey` → 用户配置的键从"工具名"变成"`policyKey`"（`approval.ts:84-89`、注释 115-131）。这允许「同一个工具，按参数走不同策略」，例如 `ops_k8s_rollout` 的 `status` 与 `restart` 用不同的用户策略键。
6. **原生弹窗走 `uiContext.select(prompt, ["Approve","Deny"])`**（`wrapper.ts:333`），不是 `ui.confirm`；并发出 `tool_approval_requested` / `tool_approval_resolved` 事件（`wrapper.ts:296-320`）——可被外部审计消费。
7. **无 UI 时需审批 = 硬失败**：`Tool "…" requires approval but no interactive UI available.`（`wrapper.ts:315-325`），并给出三条出路（改 yolo / 加 `tools.approval.<tool>: allow` / 用交互 UI）。
8. **`tool_call` handler 有 30 秒上限，超时 fail-closed 阻断工具**（`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`，`runner.ts:86`；超时返回 `{block:true, reason:"…timed out after 30000ms"}`，`runner.ts:1470-1509`）。
   → 方案 §4.4 在 hook 里 `await c.ui.confirm(...)`：**用户思考超过 30 秒，这次运维操作就被判超时并阻断**（且阻塞非交互 CLI 退出）。原生 `select` 不受此上限约束。
9. 宿主已有**命令内容级**高危模式集 `CRITICAL_BASH_PATTERNS`（`tools/bash.ts:178-225`），含 `sudo rm`、`--no-preserve-root`、`chmod -R … /`、`> /etc/shadow`、`curl|bash`、`bash <(curl …)`、`nc -e`、`kill -9 1` 等。
10. **已确认知识冲突**：`adapters/oh-my-pi.md`（status: 已确认）规定 omp 侧合规/高风险门 =「**强制 `ask` 主人确认 + 依赖宿主 approval-mode 权限门；不得静默放行**（降级收敛保守侧）」；方案 §7.4 却写「该字段为 OMP 专有……ops-pi **不依赖它**」。

### 三个选项

**选项 A：完全交给宿主**
每个 `ops_*` 工具声明 `approval` 档位；删除自研 `authorize()`、`DANGEROUS_TOOLS`、`EXEC_TOOLS`、§4.7 的 `policy.allow` 白名单。
- 得到：无 30s 陷阱；档位语义由宿主统一；`tool_approval_*` 事件可审计；与适配层已确认规则一致。
- 代价：宿主配置是**按工具**的，表达不了「只允许对 hostA/hostB 执行」这类**按目标**的策略（见选项 C）。

**选项 B：完全自研（方案的现状）**
- 得到：策略可表达主机维度和命令模式维度。
- 代价：30s 超时会让「等用户确认」变成「阻断」；与宿主子系统并存两套语义，使用者要理解两套；与已确认适配层规则冲突；且**仍然覆盖不到斜杠命令路径**（见 P0-1，两条路都不覆盖）。

**选项 C：三层分工（推荐）**
| 层 | 机制 | 管什么 | 能否被模式关闭 |
|---|---|---|---|
| L-a 审批档 | 原生 `approval`（函数式，按参数返档） | 「这类动作要不要人点头」 | 能被 `yolo` 关闭 |
| L-b 内容硬拒 | `tool_call` 里**纯同步正则**，只 `{block:true}`，**不做任何交互等待** | 灾难性命令一律拒绝 | **不能**，与模式无关 |
| L-c 目标策略 | 放进 L1/L2 工具实现内部（`ops_*` 已带 `host` 参数）：目标主机白名单、凭据作用域 | 「允许对哪些对象执行」 | **不能**，代码内硬约束 |

- 得到：交互确认交给宿主（无超时问题）、灾难命令有模式无关的硬闸、按主机/按环境的策略有正确落点（工具内部，而不是审批层）。
- 代价：L-c 要求「策略检查」写进每个工具的实现，属于设计要补的一节；分三处比"一处 authorize()"概念上更分散（但职责清晰）。

### 建议

选 **C**。理由：A 表达不了目标维度（而运维的第一风险恰恰是"打错机器"），B 有 30s 能力缺陷且与已确认知识冲突，C 是两者各自优势的正交组合。

### 需要你定的一句话

> 选 A / B / C？（默认 C，无异议我按 C 重写 §4.4/§7.3/§7.4）

---

## D2 base pi 双运行时是否保留

### 事实

1. **本机不存在 base pi**：全盘无 `@earendil-works/*` 包；无 `yuyi-pi-extension.ts`。方案 §2.1「对照本机 base pi v0.84.1 源码逐项验证」**不可复核**（本机为 `omp 18.1.18`，文档写 18.1.10）。
2. **部署目标本来就是 OMP**：方案 §1.3 自述共载的官方适配器硬依赖 OMP 特性，base pi 共载不可用。
3. **"双运行时"的代价已经在流血**：
   - 引入一个**未声明的第三方依赖** `typebox`（实测 tsc strict 报 `TS2307: Cannot find module 'typebox'`，方案依赖清单里没有它）；
   - v1.4 为"跨运行时安全"把 `typebox` 改成类型导入 + 惰性 `require`，而实测在 OMP 下 `import { Type } from "typebox"` 与 `import { StringEnum } from "@earendil-works/pi-ai"` **都能正常加载并注册工具**——**要防的风险不存在**；
   - 惰性兜底用裸 `require("typebox")`：ESM 下依赖 OMP 注入的 CJS `require` 全局（实测存在，但非规范 API）。
4. **两个运行时的 TypeBox 不是同一个东西**：OMP 侧 `pi.typebox` 是宿主自己的 shim（`{...OmpType, Object, Unsafe}`，`legacy-typebox.ts:175`），且扩展内的裸 `typebox` specifier 会被**重映射到同一个 shim**（`legacy-pi-compat.ts:929/2863-2877`）；base pi 上则是真正的 TypeBox 库。"一份代码两个运行时"实际是**同一套 API 的两种不同实现**，语义分叉点无法用类型系统发现。
5. **OMP 自己的方向与此相反**：`pi.typebox` 在四处 API 注释里都被标为 **legacy/compat**；`pi-ai` 写「Canonical authoring uses **ArkType**」；官方全部示例用 `pi.zod`；一方工具用 omptype。方案把 legacy 分支当基座。
6. **L1 本来就与 pi 无关**：`@ops-pi/core` 不依赖 pi，可移植性由 L1 保证；"双运行时"实际只影响 L2 的 schema 写法。

### 三个选项

**A（推荐）：放弃 base pi，只认 OMP**
用 `pi.typebox.Type`（或 `pi.zod`）直接写；删掉 `schemaType()` 回退分支与 `typebox` 依赖；L2 保留一个模块级取用点（`const Type = pi.typebox.Type`），未来若真要接 base pi 只改这一处。
- 得到：删掉一个未声明依赖 + 一段虚构风险防护 + 若干分叉说明；与 OMP 官方示例写法一致。
- 代价：如果将来确实要跑 base pi，L2 的 schema 需要改（但改动集中在一处）。

**B：保留双运行时**
必须先取得 base pi v0.84.1 源码并逐条复核，补 `typebox` 依赖声明，明确"共同子集"到底是哪个 API（`Type.Object`？`Type.Unsafe` 语义不同）。
- 得到：理论上的双宿主可选性。
- 代价：证据链目前是断的；维护两套 schema 语义；OMP 侧落在 legacy 分支。

**C：只保留接缝，不承诺**
与 A 实质相同，差别只在文档措辞（写明"base pi 未验证、不支持"而不是不提）。

### 建议

**A + C 合并**：按 OMP-only 写，把 base pi 从"已核实支持"改为"未验证/不支持"，保留一行取用接缝。我会在 §4.11 用「已实测」替换「已核实」并附实测方法。

### 需要你定的一句话

> 只跑 OMP 吗？（默认是；若你还想留 base pi，请说明为什么——这可能改写 §1.3 的部署前提）

---

## D3 跨 Agent 请求的鉴权来源

### 事实

1. **扩展之间唯一的共享对象是 `EventBus`**（`main.ts` 单实例 → `loadExtensions(paths, cwd, eventBus)`）。没有服务注册表、没有 `pi.getExtensions()`、没有跨扩展调用工具的方法（`getAllTools()` 只回元数据）。
2. **直接 `import` 兄弟扩展文件会得到第二个模块实例**：每个扩展条目按 `?mtime=<tag>` 独立加载（为支持同进程重载）。`withHostGuard` 只围栏 `process.exit`/stdin，不做模块隔离。
   → 方案 §4.1/§7.2 让 ops-pi 自己的 `context.ts` 封装 `YufuProxy.ensureAuthenticated()`：那是**第二个 `YufuProxy` 实例**，与官方适配器各持一份。官方适配器的"多进程主从锁"防的是**跨进程** 4009 风暴，**不防同进程双连接**。
3. **方案 §9 自己写的是「间接复用」**（`@qianji/core` 一行），与 §4.1/§7.2 的"自己封装"矛盾。
4. **业务后果**：外部 Agent 经 Hub 发来的运维请求，若要校验"发送方有没有这个权限"，ops-pi 必须拿到**调用方的御符身份与权限集**。拿不到时，只有两种可能：拒绝跨 Agent 的写操作，或放宽（任何能到达我的 Agent 都能触发写操作）——后者是权限提升漏洞。
5. **方案从未定义适配器/御符缺席时的行为**。联邦原则的显式降级三要素 + 事故教训 3「治理增强缺席时降级必须收敛保守侧」要求：缺席 = 拒绝 + 可见提示，而不是放行或静默。

### 三个选项

**A（推荐，v1 范围收敛）：v1 不开放跨 Agent 写路径**
跨 Agent 只允许触发**只读/诊断**（日志、状态、健康、拓扑）；任何变更类 `ops_*` 一律要求**本地人工批准**，与"发送方是谁"无关。
- 得到：绕开身份依赖；安全语义简单可验证；不碰第三方内部类；不产生第二个 Hub 连接。
- 代价：**"A2A 自动自愈"这一 L3 卖点在 v1 不存在**（需你确认这是可接受的裁剪）。
- 未来：等 Yuyi 提供受支持的跨扩展接口，再开放写路径。

**B：请 Yuyi 官方适配器提供受支持的接口**
由对方暴露"查权限"的正式 API（或与 ops-pi 约定 EventBus 请求/应答协议）。
- 得到：完整的 A2A 权限校验，方案原意保留。
- 代价：**跨团队承诺**——要等对方改代码、定版本；在对方交付前无法验证；协议一旦口头约定就是长期耦合。

**C：ops-pi 自建御符实例**
- 得到：表面上是"复用鉴权"。
- 代价：同进程第二个 Hub 连接与身份，可能触发 4009 类风暴、身份混乱；依赖第三方内部类（非公开 API），对方一次重构即碎。**不推荐**。

### 建议

**A**（v1 只读开放）+ 把 B 记为「待与 Yuyi 团队确认」的 Unknown 条目。这样当前没有任何决策悬空，同时不伪造跨团队承诺。

### 需要你定的一句话

> v1 是否接受「跨 Agent 只读、写操作必须本地人批」？（默认接受）

---

## D4 无人值守下每个 ops 工具放行到哪一档

### 事实（决定这一档的实际效果）

1. 默认模式 `yolo` → 什么都不拦（`wrapper.ts:198`）。**必须显式配置** `tools.approvalMode` 才有拦截面。
2. `read` 档在**三种模式下都自动放行**（`approval.ts:207-209` 的 `modeApprovesTier`），所以「只读诊断」不需要人工、也不会在非交互下卡死。
3. `write` / `exec` 档在 `always-ask` / `write` 模式下需要审批；**非交互（`-p`、cron、webhook）无 UI → 硬失败**（`wrapper.ts:315-325`）。即无人值守期间的写操作，要么被 `tools.approval.<tool>: allow` 显式允许，要么就是失败。
4. 因此「无人值守授权边界」的**可决策形态**就是：**给 25 个 `ops_*` 工具各指定一个档位**，并决定哪些工具允许在无人值守时被显式 allow。

### 建议分档表（按方案 §4.5 的工具清单）

| 档位 | 工具 | 含义 |
|---|---|---|
| `read` | `ops_docker_ps` `ops_docker_logs` `ops_k8s_pods` `ops_k8s_logs` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_file_read` `ops_file_ls` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_compose(ps/logs)` `ops_k8s_rollout(status)` `ops_service(status)` | 只读诊断，**任何模式都不弹窗**，无人值守可用 |
| `write` | `ops_file_write` `ops_ssh_upload` `ops_ssh_download` `ops_vault_store` | 落盘/传输，需人点头；无人值守默认失败 |
| `exec` | `ops_shell_exec` `ops_shell_script` `ops_ssh_exec` `ops_docker_exec` `ops_k8s_exec` `ops_process_kill` `ops_docker_compose(up/down/restart)` `ops_k8s_rollout(restart/undo)` `ops_service(非 status)` | 任意命令执行/变更，**最严**，无人值守一律需显式 allow 才放行 |

要点：
- **`ops_service` / `ops_k8s_rollout` / `ops_docker_compose` 必须用函数式 approval**，按 `action` 返不同档——否则 `status` 会跟着 `restart` 一起被卡，或 `restart` 跟着 `status` 一起放行。
- **`ops_ssh_exec` / `ops_shell_exec` 是"万能工具"**：档位再高也只是"每次弹窗"，真正的约束来自 D1 的 L-b（内容硬拒）与 L-c（目标白名单）。这是分档表之外你必须接受的语义。
- **部署到生产**这一动作，档位表表达不了（它和 staging 是同一个工具）。要区分必须用 `policyKey`（函数式 approval 返回不同策略键），或走 L-c 工具内策略。**需要你定：生产变更是否禁止无人值守？**

### 需要你定的一句话

> ① 分档表有要改的吗？② 生产环境的变更类操作（部署/重启/回滚）允许无人值守吗？（默认：不允许，`approvalMode: write` + 生产变更一律要人批）

---

## D5 需求来源与验收判据

### 事实

方案 §1.1/§1.2 有背景与目标，但**没有需求包**：没有 Do / Don't / To Confirm 三列、没有可验收判据、没有来源条目号。评审的"需求覆盖"维度因此只能给 2/10，且 §7.4 的"谁在什么情况下可以放手"本质上就是需求问题，不是设计问题。

### 选项

**A（推荐）**：你口述 3～5 句（要做什么、明确不做什么、什么算做成），我按 `architect-prd-digest` 产出结构化需求包（可验收目标 / 范围 / 不做项 / 假设 / 阻断项 / 待确认），你确认后再改设计。
**B**：指向已有的需求文档或聊天记录，我读取后转需求包。
**C**：把方案 §1.1/§1.2 当作既定需求，但**显式登记为"假设的需求，未经确认"**——需求覆盖维度按"部分"计分，方案可以继续但不等于通过。

### 建议

**A**。成本最低（你几句话），收益最大（它同时会回答 D4 的"放手到什么程度"，因为那本来就是业务取舍）。

### 需要你定的一句话

> 一句话说清：OpsPi 的**验收标准**是什么？（例如"能在无人值守下完成只读巡检并对指定服务执行重启，全过程留审计"）

---

## D6 代码落到哪个仓 / 是否 git 化

### 事实

- `/workspace` **不是 git 仓库**（无 remote、无 `.gitmodules`），只有 `docs/`；`AGENTS.md` 描述的架构师总仓那套目录不在这里。
- 架构师大脑仓实际在 **`/opt/architect`**（`architect-knowledge/`、`templates/`、`skills/`、`adapters/`、`review-queue.yaml` 齐全，只读挂载）。
- omp 适配层（`adapters/oh-my-pi.md`）要求：任务痕迹落 `<目标项目>/docs/tasks/<taskId>.yaml`，由 `scripts/task-ledger.mjs` 维护；提交前「改动仓测试全绿 + 工作区干净」。**这些前提当前都不存在**。
- 本评审报告已按适配层「工作产出落目标项目 `docs/`」落在 `/workspace/docs/reports/`。

### 选项

**A（推荐）**：你指定 OpsPi 代码的目标仓（本地路径或远端地址）。我在那里建 `docs/designs/`、`docs/reports/`、`docs/tasks/`，并落 `scripts/task-ledger.mjs`。
**B**：暂不 git 化，只产出文档（方案 + 报告 + 需求包）。**代价**：违反"一切知识进结构""提交前工作区干净"两条纪律，无法用台账承载任务痕迹。
**C**：`git init /workspace` 作为 OpsPi 起点（若这个项目本来就该在这里）。

### 建议

**A**；若你暂时没有目标仓，退而求其次用 **C**（至少让改动可追溯）。**B 会让我无法执行评审里"改动仓测试全绿 + 工作区干净"的提交前纪律。**

### 需要你定的一句话

> OpsPi 代码放哪？（路径 / 远端仓 / 或"还没定，先 git init /workspace"）

---

## 如果全部采纳默认，会发生什么

不改你的任何决策也能推进的最小路径：

1. **D1→C**：宿主 approval 档 + 内容硬拒 + 工具内目标策略；删 `authorize()` 与 `policy.allow`。
2. **D2→A**：OMP-only；删 `typebox` 依赖与双运行时分支；§4.11 改为"已实测"口径。
3. **D3→A**：v1 跨 Agent 只读，写操作要人批；B 记为待确认 Unknown。
4. **D4→建议表**：25 个工具分档，`approvalMode: write`，生产变更禁止无人值守。
5. **D5→A**：等你 3～5 句验收标准，我出需求包。
6. **D6→A/C**：等你给仓库位置。

同时按 P0-1…P0-5、P1-1…P1-6 修订方案正文，并补齐 `templates/executable-design.md` 的结构（§0 五问速答、Do/Don't/To Confirm、证据表、风险六类、验证五手段、不确定性治理表、决策门记录）。

**修订版产出后仍需你确认才落定**（自报 ≠ 完成）。
