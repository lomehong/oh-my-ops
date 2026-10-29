# 设计落地审计报告 — omo（ops-pi）

- **日期**：2026-10-29
- **审计范围**：`docs/tasks/*.yaml`（审计时 47 项；新增 KBHOOK-1 后 48 项）、`docs/designs/*.md`（8 份设计类文档）、`packages/ops-core/src`、`packages/ops-extension/src`、`scripts/`
- **审计方式**：只读取证——台账 `list` 汇总、设计文档逐节核对、代码/脚本符号搜索与关键实现阅读；未修改业务代码与配置
- **抽样策略**：全仓台账盘点；对有“待确认 / 后续 / 二期 / 未修”标记的设计文档逐项深挖；架构总设计只审计“待确认 / 未收口 / 显式后续”章节，不重跑全部运行时契约

> 口径说明：台账 `已落定` 只代表主人确认了任务收口，**不代表 pending 全部关闭**；`待确认` 只代表实现方已自报，**不代表未实现**。本报告把“代码是否存在”与“验收是否闭环”分开判定。

---

## 0. 结论摘要

| 维度 | 数量 | 说明 |
|---|---:|---|
| 任务台账总数 | 48 | `docs/tasks/*.yaml`（审计时 47 + 新增 KBHOOK-1） |
| 已落定 | 39 | 落定率 81.3%（39/48） |
| 待确认 | 7 | 实现已自报，等待主人确认或真机验证（含 KBHOOK-1；WEBVERIFY-1 已由远端 b286cef 确认落定） |
| 待执行 | 2 | OPSP-P16、OPSP-P17，代码中未找到实现 |
| 设计类文档 | 8 | 状态已于 2026-10-29 核验回写；仍存开放项/二期项（见 §6） |
| 真·未开工功能 | 2 | 定时巡检任务化；任务下发/认领/回执工具化 |
| 设计承诺未完全生效 | 1 | KBORG-1 知识合流硬门禁（Owner 侧配置 + strict 未切换） |
| 已登记未修缺陷/增强 | 2 | 7 条 `Custom tool load failed` 噪音；ssh-keyscan 指纹未入审计 |
| 已修复（本轮） | 1 | webhook 写回 `resp.ok`（KBHOOK-1，2026-10-29） |
| 已实现待确认/待验证 | 7 + 5 | 7 项待确认任务 + 5 项已落定但 pending 未关闭的任务 |

**一句话结论**：核心安全三层、只读/写入工具链、审计双写、安装与发布链路已基本落地；真正没做完的是 **2 个已立项功能（定时巡检、任务下发/回执）**、**知识库合流硬门禁的运营启用**、**Web 管理后台二期**，以及若干已登记未修的缺陷和外部环境验证缺口。

**最需关注的 3 项**：

1. **OPSP-P16 / OPSP-P17 从未开工**——不是“没验收”，而是代码、工具、测试均不存在（`ops_inspection_*` / `ops_task_*` 全仓无实现）。
2. **KBORG-1 的“确保机制”尚未真正生效**——代码已实现 `/kb/webhook` 与 lint，但默认 `warn` 不阻断合并；Gitea 分支保护 + webhook 仍登记为 Owner 待设置。webhook 写回 `resp.ok` 已由 **KBHOOK-1** 修复（2026-10-29），剩余为运营启用。
3. **KBUI-1 二期未做**——`/ui` 目前只消费 yufu 身份头，没有“角色→页面能力映射 / 单点登出”；enroll 通道迁 yufu 仍是二期候选。

---

## 1. 判定口径

| 状态 | 含义 |
|---|---|
| **Missing** | 设计/验收要求存在，但代码中未找到实现；已列出搜索关键词 |
| **Partial** | 实现了部分子要求，或代码已实现但关键运营/验证未完成 |
| **Deferred** | 设计文档明确写成“后续/二期/候选/不阻塞”，当前不算违约 |
| **Implemented-unconfirmed** | 代码与测试已存在，但台账仍为 `待确认` 或 pending 未关闭 |
| **Document drift** | 文档状态/清单与代码或台账不一致 |

---

## 2. 未完成项

### 2.1 真·未开工（Missing）

| ID | 检查项 | 来源 | 取证 | 状态 | 影响 / 建议 |
|---|---|---|---|---|---|
| **CHK-001** | 定时巡检任务化：`~/.omo/inspections/*.yaml` 定义、serve 调度、history 留存、`ops_inspection_run` / `ops_inspection_list`、风险对比 | `docs/tasks/OPSP-P16.yaml:3,7-9` | 台账 `state: 待执行`；全仓搜索 `ops_inspection`、`inspections/`、`巡检任务`，仅命中台账本身；`TIER_TABLE`（`packages/ops-extension/src/approvals.ts:12-69`）无对应工具 | **Missing** | 当前只有 `ops_health_poll` 轮询与 `/ops-health`，不具备“任务定义 + 调度 + 历史 + 风险对比”。建议明确“实现”或“rescope 掉”；若实现，按 accept 四条拆 T1–T3 |
| **CHK-002** | 任务下发/认领/回执工具化：`ops_task_dispatch`（write）、`ops_task_list` / `ops_task_report`，包装 yuyi 任务层 | `docs/tasks/OPSP-P17.yaml:3,7-9` | 台账 `state: 待执行`；全仓搜索 `ops_task`、`task_dispatch`、`task_list`、`task_report`，仅命中台账；无对应工具注册 | **Missing** | 跨 Agent 的“任务”仍停留在 `yuyi_send` 消息层，没有任务记录/认领/回执闭环。建议明确是否仍要做；若做，需先定义任务记录落点（本地文件/远端）与 write 档授权 action |

### 2.2 设计已定、实现缺失或部分

| ID | 检查项 | 来源 | 取证 | 状态 | 影响 / 建议 |
|---|---|---|---|---|---|
| **CHK-003** | KB Web 管理后台二期：角色→页面能力映射、单点登出 | `docs/tasks/KBUI-1.yaml:36-37`；`docs/designs/omo-kb-web-ui-design.md:53,125` | `scripts/lib/kb-auth.mjs:1-20` 只从请求头取身份，缺失即 401；无角色解析、无 SSO 登出接口 | **Deferred（二期）** | 一期按“yufu 网关信任模式”可接受；但角色权限全部在 yufu 侧，服务本身无页面级能力映射。建议立二期任务或明确“永不实现” |
| **CHK-004** | 实例 enroll 通道迁 yufu / 受信名，消灭 `--allow-insecure-tls` | `docs/designs/omo-kb-web-ui-design.md:53,108`；`docs/tasks/KBUI-1.yaml:37` | 设计登记为“二期候选”；安装器仍走自签证书与 `--allow-insecure-tls` 口径 | **Deferred（候选）** | 需改 4 台实例 enroll 地址，属生产变更；建议 Owner 拍板后再动 |
| **CHK-005** | KBORG-1 合流硬门禁：Gitea main 分支保护（须 PR + 须 `kb-lint` status）+ webhook 指向 `/kb/webhook` | `docs/designs/kb-knowledge-org-设计.md:49,60,111`；`docs/tasks/KBORG-1.yaml:44` | 代码已有 `/kb/webhook`、HMAC 校验、lint 与 status 回写；但台账仍登记 Owner 侧设置未完成；默认 `LINT_MODE = "warn"`（`scripts/ops-kb-enroll-server.mjs:106`），只有 `strict` 才 `blocked`（:219）；未找到 Gitea 分支保护已配置的仓库内证据 | **Partial** | 设计核心承诺是“确保机制（非建议）”；未设置分支保护 + 未切 strict 时，合流门禁实际上不阻断。建议：① Owner 完成 Gitea 设置；② 增加 `omo kb doctor` 对“分支保护/webhook/密钥”的显式检查；③ 观察期后切 strict |
| **CHK-006** | KBORG-1 阈值调参与 warn→strict 切换 | `docs/designs/kb-knowledge-org-设计.md:47-49`；`docs/tasks/KBORG-1.yaml:45` | 相似度阈值硬编码为 `0.9/0.5`（`scripts/ops-kb-enroll-server.mjs:216`）；生产默认 `warn`；台账明确“待真机调参/ Owner 拍板” | **Partial** | 阈值未按误报率调参，strict 未启用；门禁的“硬拦”语义尚未在生产生效 |
| **CHK-007** | 老 git（<2.3）与 KB 归并模块全部交互面的兼容验证 | `docs/designs/kb-sync-organize-模块业务规则.md:18,266` | 仅 `.122`（git 1.8.3.1）验证过 sync 主链；`git ls-remote` / `show-ref` 组合未穷举；CI 用新版 git | **Partial** | el7 实例升级回归存在潜在兼容缺口；建议纳入实例升级检查单，补一轮组合矩阵 |
| **CHK-008** | webhook 写回检查 `resp.ok`（CIPORT-1 登记的真实缺陷 #7） | `docs/tasks/CIPORT-1.yaml`；`docs/designs/ciport-1-执行记录.md:226` | 修复前 `scripts/ops-kb-enroll-server.mjs:221-226` 直接 `await api.post(...)`，未检查返回；`api.post` 返回 `{ok,status,text}`（`scripts/lib/kb-gitea.mjs:51`） | **已修复（KBHOOK-1，2026-10-29）** | status 失败 → HTTP 200 + `gateApplied:false` + `lint.status-write-failed` 审计，不写成功审计/不发评论；comment 失败 → `lint.comment-write-failed` + `commentWritten:false`。`probe-kb-lint.sh` 6a/6b 负例全绿 |
| **CHK-009** | 启动时 7 条 `Custom tool load failed: "Tool must export a default function"` 噪音 | `docs/tasks/OMOINSTALL-4.yaml:41`；`docs/tasks/OMOINSTALL-5.yaml:41`；`docs/tasks/OPSP-P20.yaml:40` | 台账跨任务登记“未修”；全仓搜索未找到修复提交或代码级抑制 | **Missing（未修）** | 宿主把 `$EXT/ops-pi/tools/*.ts` 当自定义工具扫描，产生 7 条噪音；会掩盖真实加载错误。建议确认宿主扫描规则后改包布局或加显式排除 |
| **CHK-010** | 首连后 `ssh-keyscan` 指纹入审计 | `docs/tasks/OPSP-P21.yaml:37` | 台账明确“未实现（登记）”；代码搜索无 keyscan 相关实现 | **Missing（增强，已登记）** | 受管 `known_hosts` 已提供记录语义，风险较低；但首次信任的指纹不可追溯。建议作为 P3 增强 |
| **CHK-011** | 远程主机侧 `PathGuard`（机密根拒读） | `docs/designs/ops-pi-architecture-design.md:586`；`packages/ops-core/src/path-guard.ts:19` | 注释明确“仅约束本机（远程主机文件系统不同，由其 host 规则负责）”；设计写明“远程侧机密性属后续任务” | **Deferred（设计已声明范围外）** | 远程读取机密文件不由本机 PathGuard 拦截，依赖目标 host 策略；这是已登记残余风险，不算隐藏缺口。建议在 README/安全模型里保持显式说明 |
| **CHK-012** | omp-single 瘦身 variant（仅 modern ~290MB，替代全嵌 471MB） | `docs/designs/omo-install-selfcontained-design.md:107,165` | 设计登记“默认全嵌，不阻塞；瘦身作为后续优化项待主人定”；当前发布仍为全嵌 | **Optional deferred** | 只影响包体积/老 CPU 兼容取舍，不影响功能；建议 Owner 决定是否排期 |

### 2.3 已实现、验收未闭环

> 这些任务不是“代码没写”，而是“实现方已自报，台账仍待确认 / pending 未关闭”。按性质分成两组。

#### 2.3.1 台账 `待确认`（7 项）

| 任务 | 实现证据 | 未兑现项 | 判定 |
|---|---|---|---|
| **OMO-KB-SYNC** | `kb-cli.ts`、`kb-enroll.ts`、`kb-sync.ts`、`scripts/ops-kb-provision.mjs`、`scripts/ops-kb-enroll-server.mjs` 均在；P1/P2/P3 报告已入台账 | pending 已补记并清理 P2/P3；剩余真实项：el7 真机跑 `omo kb status` 验证 git 1.8.3.1 退化说明 | Implemented-unconfirmed；建议主人 confirm |
| **OMO-REDACT** | `packages/ops-core/src/redact.ts`、`packages/ops-extension/src/redact.ts`；19 例测试 | 无 pending；仅缺主人 confirm | Implemented-unconfirmed |
| **OMOVENDOR-1** | `scripts/probe-yuyi-reply-frame.mjs`、`scripts/probe-vendor-integrity.sh`、`vendor/yuyi-omp-extension.PROVENANCE.md` 均在；发布门三处已接 | ① 发布门仅在下一个 `v*` tag 真跑；② 上游 D1/D2/D3 未修，撤线需“上游件 md5 一致 + 本仓探针绿”双证 | Implemented-unconfirmed；上游依赖为主 |
| **OPSP-P15** | KnowledgeStore、`ops_kb_list/search/save/sync`、gitSync 均在；台账 evidence 完整 | 无 pending；仅缺主人 confirm | Implemented-unconfirmed |
| **OPSP-P19** | `policy-lint.ts`、`policy-explain.ts`、`policy-cli.ts`、`/ops-policy` 均在；单测 228 pass | 真机（Linux + omo 启动器）验证 `omo policy lint/explain` 与 `omo status` 策略路径 | Implemented-unconfirmed |
| **OPSP-P23** | `fmtExecResult` 头 5/尾 3 已实现；`read-tier-structure.test.ts` 14 pass | 真机复验 compose v1 daemon 不可达场景；发布 pending 已清理 | Implemented-unconfirmed |
| **KBHOOK-1** | webhook status/comment 写回 `resp.ok` 修复；`probe-kb-lint.sh` 6a/6b 全绿；全量 `test:ci` exit 0 | 真实 Gitea 5xx 注入未做（stub 覆盖写回拒绝路径）；待主人 confirm | Implemented-unconfirmed |

#### 2.3.2 台账 `已落定` 但 pending 未关闭（5 项）

| 任务 | 未兑现项 | 判定 |
|---|---|---|
| **OPSP-P18** | Linux 真机 `--no-session` 审计落盘、bwrap 沙箱下 audit 目录可写性 | 代码已落定；运行时验收未闭环（`docs/designs/ops-pi-architecture-design.md:822` 也明确“未收口”） |
| **PUSHFLK-1** | `oh-my-ops-v0.16.1.tar.gz`（127MB）远端 sha256 复核“进行中”（`docs/tasks/PUSHFLK-1.yaml:43`） | 任务已落定；大包核验/补记待完成 |
| **CIPORT-1** | Linux 语义未真机复跑、`test:web-verify` 本机 SKIP、`test:l2` 60s 预算未在慢盘验证；webhook #7 已由 KBHOOK-1 修复 | 任务已落定；验证类遗留，缺陷 #7 已闭环 |
| **KBORG-1** | Gitea 分支保护/webhook 未设置、strict 未切换、`.122` 误归并分支待重推、实例侧需升级 omo 才生效 | 任务已落定；代码完成，运营启用未完成（见 CHK-005/006） |
| **WEBVERIFY-1** | 实例侧 CDP 端点未启用；知识回灌两条待入 practice | 任务已于 2026-09-24 由主人确认落定（远端 b286cef）；部署前置未完成 |

#### 2.3.3 外部环境验证缺口（非代码缺陷）

| 任务 | 未兑现项 |
|---|---|
| OPSP-P7 / P12 / P13 | 真实远程主机联调验收（需第二台可达主机） |
| OPSP-P9 | 真实容器 / bwrap 隔离负测（当前容器无 bwrap） |
| OPSP-P0 / P4 | 真实 Yuyi 适配器共载冒烟（U1；本机只有 stub） |
| OPSP-P21 | el7（OpenSSH 7.4）首连行为与受管 known_hosts 落盘路径 |
| OPSP-P22 | 对端升级后 v2/v1 皆缺→建议分支的真机复验 |
| OPSP-P20 | 对端重跑 18 项 read 档矩阵 |
| CIPORT-1 | Linux 严格分支与安装/ enroll 语义复跑 |

### 2.4 台账 / 文档状态漂移

| ID | 检查项 | 来源 | 取证 | 状态 | 建议 |
|---|---|---|---|---|---|
| **CHK-013** | 设计文档状态未回写 | 4 份文档 | ① `docs/designs/kb-knowledge-org-设计.md:3,9`：`status: 草稿` / `conclusion: 待评审`，但 KBORG-1 已落定；② `docs/designs/omo-kb-web-ui-design.md:3,9`：`status: 草稿` / 待主人确认，但 KBUI-1 已落定；③ `docs/designs/omo-kb-sync-credential-design.md:4`：`待主人拍板（未进入编码）`，但 P1/P2/P3 已实现（同文件 `:149`、`:243` 为 as-built）；④ `docs/designs/omo-install-selfcontained-design.md:6,12`：`status: 已执行` 但 `conclusion: 待评审` | **已回写（2026-10-29）** | 已按 §6 更新 status/conclusion；保留开放项说明 |
| **CHK-014** | README 工具清单与 `TIER_TABLE` 不一致 | `README.md:285` vs `packages/ops-extension/src/approvals.ts:12-69` | README 声称“与 TIER_TABLE 一致”，但 read 行（`README.md:289`）未列 `ops_kb_list` / `ops_kb_search` / `ops_kb_status` / `ops_web_verify`；这四项在 `approvals.ts:37-43` 已登记，README 后文 `:201,203` 才补列 | **已回写（2026-10-29）** | read 行已补四项；工具清单仍为手工表，后续可改引用生成结果 |
| **CHK-015** | 架构设计 §8 的任务状态说明已过时 | `docs/designs/ops-pi-architecture-design.md:771` | 文档写“任务已立项，全部处于「待执行」”，但当前 48 项中 39 项已落定、7 项待确认、2 项待执行 | **已回写（2026-10-29）** | 已改为“状态以 `docs/tasks/*.yaml` 为准”（§8） |
| **CHK-016** | 台账 `pending` 未随 report 收敛 | 3 个例子 | ① `OMO-KB-SYNC.yaml` 的 `report.pending` 曾列 P2/P3，但同文件后续 report 已实现 P2/P3 且脚本存在；② `OPSP-P8.yaml` 的 `report.pending` 曾写“远程写入 / vault re-key 未实现”，但 P13/P14 已落定；③ `OPSP-P23.yaml` 的 `report.pending` 曾写“发布 v0.9.6”，但 v0.16.1 已发布 | **已补记（2026-10-29）** | 三处 pending 已按台账 `note` 事件补记并清理：OMO-KB-SYNC 移除已落地 P2/P3；OPSP-P8 pending → `[]`；OPSP-P23 移除过时 v0.9.6 发布项。`state`/`confirmedBy` 未改（confirm 归主人） |

### 2.5 显式排除 / 条件项（不算未完成）

| 项 | 来源 | 说明 |
|---|---|---|
| `/ops-audit` 过滤参数（tool/layer/host） | `docs/requirements/ops-audit-requirement-package.md:75`；`docs/designs/2026-09-14-阶段3试点-OPSAUDIT-1-评审记录.md:38` | v1 明确不做，不列为缺口 |
| `Object.freeze(event.input)` 可选加固 | `docs/designs/ops-pi-architecture-design.md:832` | 默认不启用，避免破坏共载扩展合法改写；属安全可选加固 |
| 跨 Agent 写路径“特殊放行” | `docs/designs/ops-pi-architecture-design.md:7.6` | 设计结论是“不构成特殊路径”，已由 OPSP-P5 验证类任务落定；不存在“未开放的跨 Agent 写路径”缺口 |
| `omo kb lint` 本地兜底命令 | KBORG-1 设计风险项 | 设计说 Gitea API 不可用时降级为本地 lint；当前 Gitea 1.27.3 API 已实证可用，前置条件不成立，暂不实现 |
| 不自研跨 Agent 通信 / 不自研输出截断 / 不造宿主适配层 | 架构设计 §1 Don't | 显式排除，不是未完成 |

---

## 3. 建议处理顺序

| 优先级 | 事项 | 理由 |
|---|---|---|
| **P1** | 对 **OPSP-P16 / OPSP-P17** 做“实现 / rescope”决策 | 这是唯二真正“代码为零”的功能设计；继续搁置会让台账长期失真 |
| **P1** | **KBORG-1 门禁启用**（CHK-008 `resp.ok` 已由 KBHOOK-1 修复） | 设计承诺“确保机制”仍依赖 Gitea 分支保护 + strict 切换；status 回写失败路径已不再假绿 |
| **P1** | **KBUI-1 二期**是否排期：角色→页面能力、SSO 登出、enroll 迁 yufu | 属明确二期；若短期不做，建议在设计文档标记“accepted deferred”，避免被误读为遗漏 |
| **P2** | **CHK-009 7 条启动噪音**、**CHK-010 ssh-keyscan 指纹入审计** | 前者影响可观测性（掩盖真实加载错误），后者是首连信任的可追溯性增强 |
| **P2** | **CHK-016 台账 pending 收敛**（CHK-013/014/015 已回写，CHK-016 已补记） | 已完成；`state`/`confirmedBy` 未改（confirm 归主人） |
| **P3** | 外部环境验证缺口（Linux / el7 / 远程主机 / bwrap / Yuyi 适配器 / 大包 sha256） | 依赖 Owner 环境与授权，代码侧无法闭环；建议合并为“实例升级验收清单”统一执行 |
| **P3** | **CHK-012 C1 瘦身 variant** | 只影响包体积与老 CPU 兼容，不影响功能；Owner 决定即可 |

---

## 4. 附录：非 `已落定` 任务清单（9 项）

| 任务 | 状态 | 核心缺口 |
|---|---|---|
| OPSP-P16 | 待执行 | 定时巡检任务化（代码零实现） |
| OPSP-P17 | 待执行 | 任务下发/认领/回执（代码零实现） |
| OMO-KB-SYNC | 待确认 | 实现已完成；el7 真机复验 + 主人确认；pending 已补记 |
| OMO-REDACT | 待确认 | 实现已完成；主人确认 |
| OMOVENDOR-1 | 待确认 | 实现已完成；上游 D1–D3 / 下一个 tag 发布门 |
| OPSP-P15 | 待确认 | 实现已完成；主人确认 |
| OPSP-P19 | 待确认 | 实现已完成；Linux 真机验收 |
| OPSP-P23 | 待确认 | 实现已完成；真机复验；发布 pending 已清理 |
| KBHOOK-1 | 待确认 | webhook resp.ok 已修复并验证；待主人 confirm |

---

## 5. 审计限制

- 已运行全量 `npm run test:ci`（2026-10-29，exit 0；15 步，`test:web-verify` 因本机无 Chrome 显式 SKIP）；未连接外部实例，运行时验收结论仍以台账 pending 与执行记录为准。
- 对“是否已配置 Gitea 分支保护/webhook”只能依据台账与仓库内证据判断，未直接查询 Gitea 服务端。
- 对 7 条 `Custom tool load failed` 噪音，未复现宿主扫描行为；结论来自 OMOINSTALL-4/5、OPSP-P20 的跨任务登记。
- `docs/diagrams/` 为未跟踪的架构图产物，不属于设计文档缺口，未纳入本次统计。

---

## 6. 设计文档状态核验矩阵（2026-10-29 回写）

> 本轮按“文档状态 → 任务状态 → 代码证据”逐份核验并回写；**未修改 `docs/tasks/*.yaml` 的 `state` / `confirmedBy`**；3 处过期 `pending` 已按 `note` 事件补记并清理（见 §6.2）。
>
> 本轮补跑证据（2026-10-29）：`npm run test:l1` → 140 pass / 0 fail / 13 skipped；`npm run test:l2` → 135 pass / 0 fail / 437 expect；`node scripts/task-ledger.mjs --validate` → 48/48 通过；全量 `npm run test:ci` → exit 0（15 步，`test:web-verify` 显式 SKIP）。

| 文档 | 原状态 | 核验后状态 | 实现/确认证据 | 仍开放 |
|---|---|---|---|---|
| `docs/designs/ops-pi-architecture-design.md` | 已落定 | **已执行** | OPSP-P0–P5 已落定；P18 已落定；核心安全三层/工具链/审计/命令均在代码中 | B4 Unknown；omp 最低版本待定；远程 PathGuard 后续；`Object.freeze` 可选；P18 Linux 审计/bwrap 待验 |
| `docs/designs/omo-install-selfcontained-design.md` | 已执行；review 待评审 | **已执行；评审 60** | OMOINSTALL-1/2/3/4/5 均已落定；构建/安装/升级/发布链路在代码与 CI 中 | C1 瘦身 variant（471MB vs ~290MB）待主人 |
| `docs/designs/ops-audit-command-design.md` | 已执行 | **已执行**（无需改状态） | OPSAUDIT-3 已落定；OPSAUDIT-4 冲突演练已落定 | U2 人工冒烟 / suite-map 补录（知识任务，不阻断） |
| `docs/designs/ops-audit-conflict-drill-scope.md` | 草案，待审批 | **已执行** | OPSAUDIT-4 主人确认 2026-09-14；D-1 实弹通过，D-2/D-3 按批准降级 | 无 |
| `docs/designs/kb-knowledge-org-设计.md` | 草稿；review 待评审 | **已执行；评审 60** | KBORG-1 主人确认 2026-09-22；v0.14.2；kb-org/kb-sync/kb-lint/webhook 均在代码中 | Gitea 分支保护/webhook 未设置；warn→strict 未切换；阈值未调参；`.122` 分支待重推 |
| `docs/designs/kb-sync-organize-模块业务规则.md` | 无状态字段 | **已实现** | KBORG-1 已落定；代码追溯表与源码一致 | 老 git（<2.3）全交互面未穷举；`fs.readdir` 顺序未断言 |
| `docs/designs/omo-kb-sync-credential-design.md` | 待主人拍板（未进入编码） | **已实现 P1/P2/P3；台账待确认** | P1 同步/凭据、P2 供给 CLI、P3 enroll 服务均在代码与台账 report 中 | OMO-KB-SYNC 待主人 confirm；el7 真机退化说明复验；pending 中 P2/P3 已过期 |
| `docs/designs/omo-kb-web-ui-design.md` | 草稿；review 待确认 | **已执行（一期）；评审通过** | KBUI-1 主人确认 2026-09-21；v0.13.0；`ops-kb-enroll-server.mjs`/`ui/index.html`/`kb-auth.mjs`/`kb-ui-config.mjs` | 二期：角色→页面能力映射、单点登出、enroll 迁 yufu |
| `docs/designs/omo-kb-web-ui-需求包.md` | 无状态字段 | **已执行（一期）** | 同 KBUI-1 | 二期同上 |
| `docs/requirements/ops-audit-requirement-package.md` | 待确认 | **已确认** | OPSAUDIT-1 主人确认 2026-09-14；后续 OPSAUDIT-2/3/4 已落定 | 无 |
| `docs/requirements/omo-install-selfcontained-requirement-package.md` | 准入通过 | **已确认** | OMOINSTALL-1 主人确认 2026-09-14；后续 2/3/4/5 已落定 | C1 体积取舍待主人 |
| `docs/requirements/ops-pi-requirement-package.md` | 已确认 | **已确认**（无需改） | 主人 2026-09-12 确认 A0–A6 | 无 |
| `docs/designs/2026-09-14-阶段3试点-OPSAUDIT-1-评审记录.md` | 评审通过，待确认 | **已确认** | OPSAUDIT-1 主人确认 2026-09-14 | 无 |
| `docs/tasks/{OMO-KB-SYNC,OPSP-P8,OPSP-P23}.yaml` | 过期 pending | **已补记** | `op: note` 事件 + pending 清理；`--validate` 48/48、`--selftest` 12/0 | `state`/`confirmedBy` 未改（confirm 归主人） |
| `docs/tasks/KBHOOK-1.yaml` | 新增修复任务 | **待确认** | webhook `resp.ok` 修复；6a/6b 负例先红后绿；`test:enroll-install` / `test:kb-ui` 回归全绿 | 待主人 confirm；全量 `test:ci` 已绿（web-verify SKIP） |
| `README.md` 工具清单 read 行 | 与 `TIER_TABLE` 不一致 | **已对齐** | 补入 `ops_kb_list` / `ops_kb_search` / `ops_kb_status` / `ops_web_verify`；与 `approvals.ts:37-43` 一致 | 手工表仍有后续漂移风险，建议改为引用生成结果 |
| `docs/designs/ops-pi-architecture-design.md` §8 任务状态说明 | 静态“全部待执行” | **已改为以台账为准** | 48 项：39 已落定 / 7 待确认 / 2 待执行（2026-10-29） | 台账数字会继续变化，已注明日期 |

### 6.1 回写清单（仅文档）

- `docs/designs/ops-pi-architecture-design.md`：status 改 `已执行`；§8 静态任务状态改为以台账为准；§1 To Confirm / §6 不确定性 / §9 决策门同步 B1 已撤销、B2/B3 已解决；§8 P5 行改为“跨 Agent 同一安全三层”；A4 审计落点改为 `tool_execution_end`；§7.4.1 档位表按 `TIER_TABLE` 修正（移除未实现 `ops_ssh_*`/`ops_process_kill`，补 kb/web_verify）；目录树与 `ops_ssh_exec` 示例补 as-built 说明。
- `docs/designs/omo-install-selfcontained-design.md`：review score 0/待评审 → 60/已执行；status 注明确认日期。
- `docs/designs/ops-audit-command-design.md`：status 注记补 OPSAUDIT-4 已落定。
- `docs/designs/ops-audit-conflict-drill-scope.md`：标题与状态改为已执行，补 Q1/Q2 收口说明。
- `docs/designs/kb-knowledge-org-设计.md`：status 草稿 → 已执行；review 0/待评审 → 60/已执行；补实现状态与门禁运营待办。
- `docs/designs/kb-sync-organize-模块业务规则.md`：补“已实现 + §8 未验证项”状态行。
- `docs/designs/omo-kb-sync-credential-design.md`：顶部“待主人拍板/未进入编码” → “已实现 P1/P2/P3，台账待确认”；§5.6 接口补 as-built 修正（实际只有 `/enroll`，rotate/revoke 走一次性码）；E2 CLI 修正为单一 `ops-kb-provision.mjs`。
- `docs/designs/omo-kb-web-ui-design.md`：status 草稿 → 已执行（一期）；review 结论改为已确认；补二期未开工。
- `docs/designs/omo-kb-web-ui-需求包.md`：补一期已执行/二期未开工状态。
- `docs/designs/omo-kb-sync-执行记录.md`：补“P2/P3 已落地”的后续状态注记（保留历史快照语义）。
- `docs/requirements/ops-audit-requirement-package.md`：待确认 → 已确认。
- `docs/requirements/omo-install-selfcontained-requirement-package.md`：准入通过 → 已确认；T1–T5 历史表述同步。
- `docs/designs/2026-09-14-阶段3试点-OPSAUDIT-1-评审记录.md`：待确认 → 已确认。
- `README.md`：read 档工具行补四项，与 `TIER_TABLE` 对齐。

### 6.2 台账补记（2026-10-29）

- `docs/tasks/OMO-KB-SYNC.yaml`：新增 `op: note` 事件；pending 移除已落地的 P2/P3，仅保留 el7 真机复验。state 仍为 `待确认`。
- `docs/tasks/OPSP-P8.yaml`：新增 `op: note` 事件；pending 置空（远程写入已由 OPSP-P13、vault re-key 已由 OPSP-P14 落定）。state 仍为 `已落定`。
- `docs/tasks/OPSP-P23.yaml`：新增 `op: note` 事件；pending 移除过时的“发布 v0.9.6”，仅保留对端真机复验。state 仍为 `待确认`。
- 校验：`node scripts/task-ledger.mjs --validate` → 48/48 通过；`--selftest` → 12/0 通过。`state` / `confirmedBy` 未改（confirm 归主人）。

### 6.3 代码修复：KBHOOK-1（2026-10-29）

- 修复：`scripts/ops-kb-enroll-server.mjs` 的 `/kb/webhook` 现在检查 status 与 comment 两处 `api.post` 的 `resp.ok`。
- status 失败：HTTP 200 + `gateApplied:false` + `lint.status-write-failed` 审计；不写 `lint.blocked/passed` 成功审计、不发评论。
- comment 失败：`lint.comment-write-failed` 审计 + `commentWritten:false`；status 成功时合流门禁仍生效。
- 探针：`scripts/probe-kb-lint.sh` 新增 6a/6b 负例；先红 7 项 → 修复后 0 项失败。`probe-install-enroll-service.sh` 的 `proc.sh` 漏 source 已由 `origin/main bdcee2d` 先行修复（本轮去重）。
- 回归：`test:kb-lint` / `test:enroll-install` / `test:kb-ui` 全绿；`test:l1` 140 pass、`test:l2` 135 pass；全量 `test:ci` exit 0（15 步，`test:web-verify` 显式 SKIP）。
