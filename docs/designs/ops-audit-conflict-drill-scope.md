# 冲突路径演练范围（草案，待主人审批）

> 任务：`OPSAUDIT-4`（阶段 3 收口——评审人 dsh-architect 建议项，主人 2026-09-14 批准起草）
> 背景：`/ops-audit`（OPSAUDIT-1~3）补上了 A4「当前分支内可读」的读取面，但**被拒/兜底/令牌**三类冲突路径只在开发容器被自动化探针（05②⑤⑥）覆盖过；本演练在部署形态做**实弹**闭环，并以 `/ops-audit` 作为观测仪器回看冲突条目。
> 纪律：演练即测试——不修改产品代码；暴露缺陷走台账 `reject` 另立任务，不现场改。

## 候选路径

### D-1（必做）A4 闭环：被拒调用 → `/ops-audit` 回看
- 前置：策略仅预授权 `@local nginx status`（read 档）；交互会话（TUI）
- 步骤：① 请求 `ops_service restart`（exec 档未预授权）→ 期待 `[ERR_PERMISSION] guard-unattended` 拒绝；② 执行 `/ops-audit 5`；③ `/ops-audit 1`
- 预期观察：② 输出含该被拒条目 `authz=blocked`、`reasonClass=ERR_PERMISSION`、reason 前缀 `[ERR_PERMISSION]`；③ 只显示最新一条（即②所见那条的自审计 `ops-audit/read` 条目，B6 先读后写语义）
- 验收：A4「当前分支内可读」在部署形态闭环；字段可辨、无臆造

### D-2（实弹复核）无人值守 exec 拒绝的模式无关性
- 步骤：`omo --approval-mode yolo -p "ops_service restart…"` 与 `--approval-mode always-ask`（非交互）各跑一次未预授权 restart
- 预期：两模式一致拒（`guard-unattended`），审计条目均落盘——对账 05② 的自动化结论
- 说明：自动化已覆盖；本条为部署形态实弹复核，环境受限时可降级为「引用 05 证据 + 差异说明」

### D-3（实弹复核）批准令牌单次消费
- 步骤：签发单次令牌 → yolo 非交互携令牌 restart → 放行；同令牌重放 → 拒（`consumedAt` 写回）
- 预期：放行/消费/重放被拒三段一致——对账 05⑤
- 说明：同 D-2，可降级为引用既有证据

## 产出物
- `docs/reports/ops-audit-conflict-drill.md`：真实命令与输出全程留痕（含与 05②⑤⑥ 对账表）
- 台账 `OPSAUDIT-4` evidence 回填 + `report` 自报（自报 ≠ 完成）

## 不做项
- 不触生产目标（演练目标仅为 `@local` 本机 nginx status/restart 语义）；不新增/修改产品代码；不做跨会话聚合（D1）

## 待主人确认
| # | 项 | 问 |
|---|---|---|
| Q1 | 执行环境 | 部署形态交互会话在哪台主机/哪个会话驱动？（本容器无 TUI；D-1 必须交互态） |
| Q2 | 范围取舍 | D-1 必做无异议？D-2/D-3 实弹 or 降级引用 05 证据？ |
