# 独立复评报告：omo v4.1 设计文档（第④项，主人 2026-09-12 拍板）

```yaml
---
title: 独立复评：omo v4.1 三项绕过路径与拒绝路径审计覆盖
status: 待主人确认          # 独立复评结论不自评作数
reviewer: dsh 侧独立评审会话（与 omp 评审会话完全隔离，未复用其探针代码）
created: 2026-09-12
target: docs/designs/ops-pi-architecture-design.md（v4.1）+ docs/reports/probes/v41-fix-verification-probe.ts
environment: oh-my-pi 容器，omp 18.1.18，--approval-mode yolo + 非交互（最不安全组合）
independent_probe: docs/reports/probes/independent-recheck-probe.ts（本复评独立实现，未复用 omp 会话探针）
---
```

## 复评结论

**v4.1 的三项核心修复断言（R-1 兜底层 / R-2 归一化 / R-4 审计落点）独立复现全部成立** ✅。
同时，独立取证发现 **4 项 omp 评审会话未覆盖的新发现**（N-1～N-4，见下），其中 N-1/N-2 建议设计文档修订后再进入实现阶段。

## 一、v4.1 核心断言的独立复现（与 omp 会话不同取证路径）

| 断言 | 独立取证方式 | 结果 |
|---|---|---|
| R-1：①-b 兜底层与 approvalMode 无关（X10 复现） | yolo + 非交互，`ops_t4_unauth`（未授权 exec）经独立探针 | ✅ 被拒（`[ERR_PERMISSION]`），execute 未运行；tool_call 钩子可读 `hasUI=false` |
| R-2：`event.systemPrompt` 为 `string[]`（X12 复现） | 独立探针 before_agent_start 内探测 | ✅ `isArray=true, len=2`；归一化写法与设计 §7.8 一致 |
| R-4：被阻断调用走 `tool_execution_end` 而非 `tool_result`（X11 复现+扩展） | 四分支（read 放行/预授权放行/①-b 拒/policy:deny 硬拒）逐分支核对审计条目 | ✅ 四分支**全部落审计**：执行类 `isError=false, authz=executed`；拒绝类 `isError=true, authz=blocked`；`tool_result` 缺席复现成立 |

## 二、三项绕过路径的独立取证

### 绕过路径①：input 改写 —— **发现 N-1（P1，安全）**

**取证**：early 注册的 `tool_call` handler 改写 `event.input.command`（追加 `; echo INJECTED`）后：
1. 后注册的兜底 handler 读到**改写后** input；
2. **execute 收到改写后 input**（工具实际执行了注入命令）；
3. 工具自身的 `approval` 函数（authorizedExec）对改写前后的判定差异未被观测隔离——**审批判定与执行实参存在不一致窗口**。

**含义**：设计 §7.4 三层安全隐含假设「审批判定的 input == execute 收到的 input」，但 omp 的 `tool_call` 多 handler 共享可变 `input` 引用，先注册的 handler 改写会传播。威胁面 = 共载的其他扩展（恶意/缺陷钩子）——防御不应依赖共载方善意。

**建议**：设计文档 §7.4/§5 补「input 一致性」条款：(a) 契约声明 handler 不得改写 `event.input`（并在 Contract 测试中断言）；(b) 兜底判定与 execute 使用**同一份防御性拷贝**（扩展入口处深拷贝 input 后全链路只用拷贝）。归属：omp 平台契约层面（理想解）与 ops-extension 防御性拷贝（可行解）二选一或并用。

### 绕过路径②：loadMode 误删 —— **N-3（P2，安全确认，正向）**

**取证**：yolo + 非交互下，`ops_t2_discoverable`（漏 `loadMode`）对 LLM **不可见**（复现 X4）；诱导经 `read xd://` 发现并调用时，**tool_call 钩子仍触发**，①-b 兜底层成功拦截（execute 未运行）。

**含义**：loadMode 误删的设计风险（approval 声明失效）在**运行时由 ①-b 兜底闭环**——即使断言遗漏，兜底层不依赖 loadMode。建议设计 §5 Contract ③ 补此实证（yolo + xd:// 组合），作为「纵深防御有效性」证据。

### 绕过路径③：共载扩展同名覆盖 —— **N-2（P1，设计可行性否定）**

**取证**：同扩展内二次注册同名工具 → last-wins 复现（O11 成立，execute 跑 second）。**更重要的发现**：设计的「启动期断言前缀不相交」（§5 Contract ②）**在 omp 18.1.18 上不可实现**——`getAllTools()` 在扩展加载期抛错 `Extension runtime not initialized`（实测），断言只能后移。

**含义**：断言后移到 `session_start` 时，跨扩展覆盖（后加载者覆盖先加载者）可能**先于断言发生**——断言发现时覆盖已存在（检测而非阻止）。且覆盖窗口内若有调用到达，安全工具已被替换。

**建议**：设计 §5 修订断言时机为「`session_start` 首次触发时」（此时加载已完成、覆盖已定格，断言可全量核查 `getAllTools()` 并 `throw` 拒绝继续）；同时在 README 标注「覆盖窗口 = 宿主已知限制（O11 静默 last-wins）」。此项需设计文档修订后再实现。

## 三、新发现 N-4（P2，审计粒度）

拒绝类审计条目仅 `isError=true, authz=blocked`——**无法区分拒绝层级**（①-b 兜底拒 / policy:deny 硬拒 / execute 自身抛错，三者 isError 同真）。建议：block 返回的 `reason` 若能进入 `tool_execution_end` 的 `result`，审计侧透传记录；否则扩展在 ①-b 拒绝**之前**自行 `appendEntry` 一条 `ops_audit(pending-block)` 前置条目。

## 四、证据覆盖抽查（复评义务）

随机抽验 3 条 O 系结论：O8（loadMode 默认 discoverable，源码 `essential-tools.ts`）✅；O11（同名 last-wins，实测复现）✅；O16（`--eval` 不存在，`omp --help` 核对）✅。抽查未发现引用失真。

## 五、遗留与移交

- N-1/N-2 需设计文档修订（§5/§7.4/§7.8），修订后建议本探针随回归集复跑；
- `tools-snapshot` 观测点需挪至 `session_start` 后（加载期不可调用的实测证据已记）；
- 本报告与独立探针（`independent-recheck-probe.ts`）随 ops-pi 文档入库；观测原始数据见容器 `/tmp/independent-recheck/out.json`（建议随报告归档）。

---

# N-1～N-4 修订闭环（v4.2，2026-09-12 同日）

按本复评报告的建议完成设计修订，并逐项复验。修订写入 `docs/designs/ops-pi-architecture-design.md` **v4.2**。

| 复评发现 | 修订 | 复验证据 |
|---|---|---|
| **N-1（P1）input 改写一致性** | 新增 **§7.4.4「input 一致性」**：三层同值校验布局 + 四条规范性要求（`assertAuthorized` 置 execute 首行 / handler 不得改写 input / 复核拒绝留痕 / README 标注共载改写属宿主语义） | X16（先注册改写 → ①-b 拦）、X17（后注册改写 host/service → ①-a 对最终入参返 `policy:deny`，工具未执行）、**X19（决定性）**：后注册改写**仅 command** 时 ①-b/①-a **均放行**，仅 ③ execute 复核拦住 `rm -rf /` → ③ 不可省略（探针 `v42-execute-revalidation-probe.ts`） |
| **N-2（P1）断言时机不可实现** | §5 Contract ② 断言时机改为 **`session_start` 首次触发** + `throw`；显式声明性质是**检测 + 拒绝继续**，非阻止覆盖；README 标注宿主限制 | X15：加载期 `getAllTools()` 抛 `Extension runtime not initialized`；`session_start` 可正常枚举（`count=20`） |
| **N-3（P2，正向）** | §5 Contract ③ 补「loadMode 漏声明 + `xd://` 路径下 ①-b 仍拦截」的纵深防御实证 | 复评原文实证（execute 未运行） |
| **N-4（P2）审计粒度** | 新增 **§7.4.5「拒绝层级审计」**：①-b/② 在 `tool_call` 内写带 `layer` 的**前置条目**；③ 在抛错前写 `execute-revalidation`；①-a 无法介入 → 登记 **RR-3** | X18（分支中 `ops_audit` 条目数 1，`layer` 保留）；X19（`layer="execute-revalidation"` 落库） |

**其他同步修订**：§4 新增 **RR-4**（共载扩展可改写入参）；§6 新增第 9 项（宿主已知限制：共享可变 input、last-wins 只能后移断言）；§5 负测新增 ⑨（三种时序回归）与 ⑩（层级可辨）；需求包新增 **A6「授权判定与执行实参同值」**（A4 补 `layer` 要求）。

**遗留移交**：N-1/N-2 的修订已完成并自验；按本报告的移交意见，**建议由独立会话就 N-1 三种时序与 N-2 断言时机复跑一次**（探针均已入库 `docs/reports/probes/`）。落定仍以主人确认为准。
