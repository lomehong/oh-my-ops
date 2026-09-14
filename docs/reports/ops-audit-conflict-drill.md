# 冲突路径演练记录（OPSAUDIT-4 · 阶段 3 收口）

> 日期：2026-09-14 · 环境：logstash-124（真实机器，root）· 版本：**v0.7.0**（自包含安装器，Release 制品）
> 执行者：主人（TUI 实操）· 对账与记录：omp-architect · 范围：D-1 必做（已批准），D-2/D-3 降级引用既有自动化证据

## 1. D-1 实弹结果（A4「当前分支内可读」闭环）

| 步 | 操作 | 结果 |
|---|---|---|
| S1 | 安装：`curl … releases/latest/download/install.sh \| bash` | ✅ 五步全绿：bun 自动装（官方通道失败→npmmirror 成功）、omp/18.1.18 单文件就位、`/usr/local/bin/omo`、策略与 AGENTS.md 初始化 |
| S2 | TUI 内让 LLM 调 `ops_service` 对 `omo-drill` 执行 `restart` | ✅ **被拒，未执行**：`[PERMISSION_DENIED] [ERR_PERMISSION] guard-unattended：变更类操作未获预授权（policy.json 白名单或 Owner 批准令牌）`（主人贴回 UI 原文） |
| S3 | `/ops-audit`（无参） | ✅ **A4 字面判据达成**（主人贴回真实输出，6 条倒序）：`[08:53:44.161Z] ops_service blocked/blocked class=- host=- [PERMISSION_DENIED] [ERR_PERMISSION] guard-unattended：变更类操作未获预授权（policy.json 白名单或 Owner 批准令牌）`；头部 `ops-audit：显示 6 条（可读范围=当前会话分支 leaf 路径）` |
| S4 | `/ops-audit 1` | ✅ 仅显示 1 条 `[08:55:42.567Z] ops-audit read/ok`——**先读后写闭环**（读取在前，本次自审计不出现在本次输出） |
| S5/S6 | `/ops-audit abc`、`/ops-audit 0` | ✅ 逐字命中：`Error: /ops-audit 参数须为正整数（1–200；收到「abc」）；留空 = 默认 20 条`、同构 `收到「0」`；且参数错误亦自落审计（`isError=true`→blocked，设计使然） |

**与预测一致**：S2 拒绝串与三层拦截链预测吻合（守卫层短路，execute 未运行；`omo-drill` 为不存在服务，双保险零影响）。S2 现场原文已由主人贴回对话存证。

## 2. 说明与偏差

- 演练目标采用 `omo-drill`（不存在服务）替代手册原定 `nginx`——主人主动提出的更稳方案：即使理论放行也无实害。空策略下拒绝语义不变。
- 前置策略即安装器缺省空策略（变更全拒），比手册的 nginx status 白名单更保守；S7 无需恢复动作。
- D-2/D-3 未实弹：按批准范围降级，引用既有自动化证据——05②（双模式无人值守拒绝）、05⑤（令牌单次消费）、05⑥（被拒审计落盘）在开发容器持续全绿（v0.7.0 CI test job 同源通过）。

## 3. 对账

| 演练观测 | 既有证据 | 一致性 |
|---|---|---|
| exec 未预授权被拒（guard-unattended） | 05② 同款拒绝 | ✓ |
| 被拒调用落 `ops_audit`（authz=blocked + reasonClass/reason） | 05⑥ + 需求包 E1/E9 | ✓ |
| `/ops-audit` 读取面（收窄/格式化/先读后写） | `audit-view.test.ts` 15 用例 + `12-ops-audit.sh` 探针 2/2 | ✓ |
| 自包含安装（bun 自动装官方→镜像回退；~/.omo 布局） | 安装契约冒烟 7/7 + 本次真实机安装 | ✓ |

## 4. 结论与未决

**A4「每一次调用（含被拒）留痕且当前分支内可读」在真实环境全链闭环。** 阶段 3 试点（/ops-audit + 自包含安装器）功能面完成。

未决（不阻断）：
1. suite-map 补录 oh-my-ops 条目（知识任务）；
2. 安装器经验回灌 `architect-knowledge/practice/`（自包含安装器模式、老 curl 兼容、embedded-addon 机制）；
3. CI 打包清单断言已加（v0.7.0 首发丢 scripts/ 教训的制度化）。

## 附：S3 原始输出（主人贴回，2026-09-14T09:19 会话）

```
ops-audit：显示 6 条（可读范围=当前会话分支 leaf 路径）
[2026-09-14T09:19:45.389Z] ops-audit read/blocked class=- host=-
[2026-09-14T08:56:12.379Z] ops-audit read/blocked class=- host=-
[2026-09-14T08:56:01.443Z] ops-audit read/ok class=- host=-
[2026-09-14T08:55:42.567Z] ops-audit read/ok class=- host=-
[2026-09-14T08:53:44.161Z] ops_service blocked/blocked class=- host=- [PERMISSION_DENIED] [ERR_PERMISSION] guard-unattended：变更类操作未获预授权（policy.json 白名单或 Owner 批准令牌）
[2026-09-14T08:50:03.538Z] ops-audit read/ok class=- host=-
```

观测说明：两条 `ops-audit … blocked` 为参数异常测试的失败留痕（`abc`/`0`，isError=true 设计使然）；`ops_service blocked` 行即 A4 闭环的决定性证据；本次无参调用自身自审计按先读后写不出现在本次输出。
