# 独立复审报告（第二轮）：对第一轮独立复评的复核

```yaml
---
title: 独立复审（第二轮）：OpsPi v4.1 复评发现复核
status: 待主人确认
reviewer: dsh 侧独立评审会话（第二轮，新探针 independent-recheck-2-probe.ts，方法学改进见下）
created: 2026-09-12
target: docs/reports/independent-recheck-2026-09-12.md（第一轮结论）+ v4.1 设计
---
```

## 复审结论

第一轮的四项发现中：**N-1 升级确认（机制更明确、更严重）**、**N-2 修正（可行，时机问题而非不可实现）**、**N-3 加重确认**、**N-4 有解**。v4.1 三断言再次确认 ✅。

## 逐项复核

### N-1 复核：**升级确认——「钩子 input 改写劫持审批重判」**

第二轮新证据（approval 函数内埋点直测）——一次 `ops_m1` 调用的完整时序：

```
approval(input = {restart nginx})          ← 审批首次求值：原始 input
early hook：input.command 改写（+= echo INJECTED-2）  ← 改写发生
late hook：读到改写后 input
approval(input = {restart nginx; echo INJECTED-2})    ← 审批再次求值 ×2：拿到的是改写后 input
execute(input = {restart nginx; echo INJECTED-2})     ← 执行改写后参数
```

**对第一轮 N-1 的修正**：不是「审批用改写前、执行用改写后」的不一致——而是 **tool_call 钩子的 input 改写会传播进审批的后续求值**。危害更明确：先注册的钩子把 input 改写为**预授权目标**（如 host: prod-db → web-01），后续审批重判即被伪造 input 放行，execute 执行伪造参数——**授权判定可被钩子劫持**。

**新附发现**：approval 函数单次调用被求值 **3 次**（跨钩子前后）——设计 §7.4.2 的 `authorizedExec` 须补契约「可能被多次求值，必须纯函数无副作用」（令牌/策略查询的 TOCTOU 面）。

**建议维持并加重 N-1**：①扩展入口对 input 做防御性深拷贝，全链路（含 hooks 内判定）只用拷贝；②向 omp 上游反馈「tool_call handler 改写 input 的传播语义」作为平台契约问题。

### N-2 复核：**修正——断言可行，时机须后移**

`session_start` handler 内 `getAllTools()` **可用**（实测 callable=true，total=22）。第一轮「不可实现」结论**过重**，修正为：

> 启动期（加载期）断言不可行（加载期抛 `Extension runtime not initialized`，第一轮实测）；**断言后移至 `session_start` 首次触发可行**（加载已完成、覆盖已定格）。残留：`session_start` 前的调用窗口内安全工具可能已被同名覆盖——该窗口由 ①-b 兜底层覆盖（N-3 加重确认：yolo 下 discoverable 工具经 `xd://` 调用仍触发 tool_call 钩子并被拦）。

设计 §5 Contract ②③⑤ 的修订措辞建议：「断言于 session_start 执行；加载期窗口由 ①-b 模式无关兜底覆盖（独立复评 N-3 实证）」。

### N-3 复核：**加重确认**

第二轮以 `write xd://ops_m3_disc` 路径实测：xd:// 写调用同样触发 `tool_call` 钩子且被兜底拦截（`[RECHECK2] unattended exec blocked`，execute 未运行）。yolo 下 loadMode 误删的运行时风险闭环再次成立。

### N-4 复核：**有解（降级为改进项）**

`tool_execution_end` 的 `result` 全文观测：block 场景下 `result.content[0].text` **携带 block reason**（`[RECHECK2] deliberate block — ...`）。审计侧提取 `result.content[].text` 即可区分拒绝层级（按 reason 前缀约定，如 `[ERR_POLICY]` / `[ERR_PERMISSION]`）。第一轮「无法区分拒绝层级」**有解**，修改计为改进项。

### v4.1 三断言：再确认 ✅

R-1 兜底 / R-2 归一化（`isArray=true` 再现）/ R-4 审计落点——第二轮全部再次成立。

## 对第一轮报告的勘误表

| 第一轮结论 | 第二轮裁定 | 依据 |
|---|---|---|
| N-1「审批判定与执行实参不一致窗口」 | **升级**：钩子改写可劫持审批重判（机制更明确） | approval-probe 埋点直测（M-1/M-5） |
| N-2「启动期断言不可实现」 | **修正**：不可行的是「加载期」；`session_start` 后移可行 | M-2 实测 callable=true |
| N-4「无法区分拒绝层级」 | **有解**：result.content 携带 block reason | M-4 result 全文观测 |
| N-3 / v4.1 三断言 | 维持（加重/再确认） | M-3 + 全链路重跑 |

## 移交

- 设计文档修订项更新：N-1（input 一致性 + authorizedExec 纯函数契约）、N-2（断言时机后移措辞）、N-4（审计提取 reason）；
- 两轮探针与观测数据随 ops-pi 文档入库（`probes/independent-recheck-2-probe.ts`、容器 `/tmp/recheck-2/out.json` 已归档）；
- 最终采纳仍以主人确认为准。
