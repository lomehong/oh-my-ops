---
title: 知识库组织 reform——域活档案 + sync 机械归并 + 合流期 lint 门禁
status: 草稿
requirement: 会话讨论（2026-09-21）："以后的知识如何更合理地组织"，Owner 认可方向并要求**可确保的机制**（README 规范=建议，不算数）
author: omp-architect（omp-docker）
created: 2026-09-21
review:
  score: 0
  conclusion: 待评审
---

# 可执行技术方案：知识库组织 reform（KBORG-1）

## 0. 一句话与五问速答

| 五问 | 速答 |
|---|---|
| 改哪里？ | `kb-sync.ts`（归并步骤）、kb 服务（`/kb/webhook` + lint 模块 + status 回写）、新增 `domains.yml` 约定与探针 |
| 为什么改？ | 现状"一事一文"已 33 篇平铺、15 个前缀家族、同主题多设备裂成多份；README 规范=建议，对 LLM 写入方无法确保 |
| 影响谁？ | 4 台实例的合流语义（warn→strict 分期）；中心评审（从判路径变为看 lint 报告）；存量 33 篇**不动**（Owner 已定） |
| 如何验证？ | 归并纯函数单测（幂等/兜底/冲突）+ lint 规则单测 + webhook 契约探针（stub Gitea）+ test:ci 全绿 |
| 还有什么没有确认？ | 2 项：Gitea 分支保护与 webhook 的设置由 Owner 侧执行；相似度阈值（0.9/0.5）待真机调参 |

## 1. 需求覆盖（10 分）

### Do（做）

| # | 需求条目 | 方案响应 | 来源 |
|---|---|---|---|
| 1 | "并到已有文档"的判断要可实现 | 结构消解判断：**每域一个活档案** `<域>/README.md`，域内知识唯一容器；"该并到哪"退化为查表（系统→域） | Owner 质询 |
| 2 | "是不是同一个问题"的判断 | 三机制：①活档案结构（判断收敛为"哪个域"）②sync 机械归并（按 `系统:` 头追加为带日期小节）③PR 相似度 lint（>0.9 拦、0.5~0.9 列候选） | Owner 质询 |
| 3 | 确保机制（非建议） | 合流期硬门禁：Gitea 分支保护 + commit status `kb-lint`；写入期自动归位（sync 工具代做） | Owner 核心诉求 |
| 4 | 知识条目格式 | 文首元数据：`系统: <域>` / `类型: 事件\|文档\|runbook`（缺省 事件）；`来源设备`/`日期` 由 sync 自动注入 | 沿用会话约定 |
| 5 | 域白名单唯一事实源 | 仓库根 `domains.yml`（机器可读）；sync 与 lint 均以拉取到的 main 版本为准 | 本设计 |

### Don't（不做，显式排除）

| # | 排除项 | 排除原因 |
|---|---|---|
| 1 | 迁移存量 33 篇 | Owner 明确"现在的这些先不处理" |
| 2 | 删除/改写实例分支上的旧格式文件 | lint 只对 PR 新增/修改文件生效，存量豁免（warn 模式兜底） |
| 3 | 嵌入式向量/语义模型做相似度 | 私有域零依赖纪律；中文 bigram Jaccard 对"近似重复"够用，语义级判断本就归评审 |
| 4 | `archive/` 目录 | 归并=内容进活档案+条目文件移除，git 历史即存档；多一个目录多一类规则（对首版方案的简化，见 §6 偏离登记） |

### To Confirm（待确认）

| # | 待确认项 | 问谁 | 状态 |
|---|---|---|---|
| 1 | main 分支保护 + webhook 密钥（`KB_WEBHOOK_SECRET`）的设置动作 | Owner/Gitea 管理员 | 实现完成后一次性设置（我给精确步骤） |
| 2 | 相似度阈值 0.9（硬拦）/0.5（警示）真机调参 | Owner | 上线两周后按误报率调 |

## 2. 系统覆盖（10 分）

| 服务/组件 | 变更类型 | 关键依赖 | 缺席降级影响 |
|---|---|---|---|
| packages/ops-extension/src/kb-sync.ts | 改（commitAll 前插入 organize 步骤） | domains.yml（取自刚 pull 的 main 工作树） | organize 失败 ⇒ 保持旧行为直接 commitAll（**不阻塞**），报告醒目警示 |
| scripts/ops-kb-enroll-server.mjs | 改（新增 `/kb/webhook` 路由 + lint 模块挂载） | kb-lint.mjs、Gitea API（status/comments/pulls files） | webhook 缺失/密钥错 ⇒ 401/404，主流程（/enroll、/ui）零影响 |
| scripts/lib/kb-lint.mjs | 增（纯函数规则引擎） | domains.yml 校验器 | 缺失 ⇒ 服务启动正常，webhook 返回 503 |
| 仓库根 domains.yml | 增（域白名单 + 每域活档案说明） | — | — |
| Gitea（twin.hzins.com） | 配置（分支保护 + webhook），Owner 侧一次性 | webhook 密钥 | 未设置 ⇒ 门禁不生效（warn 模式兜底，不阻断任何现状） |
| 4 台实例 | 分期升级（老实例 = warn 模式对象） | ops-extension 升级随 omo 发版 | 老实例推平铺文件 ⇒ warn 期照常合流；strict 后被拦并收到移动指引 |

- 范围外参与方：Gitea 版本能力（PR files / statuses API 需 1.27 支持——真机 1.27.3 ✅ 实现前用探针实证）。
- 对照架构地图：单仓 + 服务端增强，无跨服务拓扑变化（显式声明不适用）。

## 3. 证据覆盖（10 分）

| 关键结论 | 证据类型 | 出处 |
|---|---|---|
| sync 插入点：commitAll 之前 | Code | kb-sync.ts:166（`commitAll("kb: sync …")`） |
| push 永远只到 instance/<device>，main 由 PR 合流 | Code | kb-sync.ts:13-14、166-175 |
| 实例已在用 PR 合流（机制被 Owner 侧采用） | 真机 | .123 回执：main 最近提交含 PR #5/#6/#7 merge |
| 现状 33 项平铺、15 前缀家族 | 真机 | .123 回执（contents API 权威清单） |
| 服务可回写 commit status / PR 评论 | API | Gitea 1.27 `POST /repos/{o}/{r}/statuses/{sha}`、`POST /repos/{o}/{r}/issues/{n}/comments`（实现前探针实证，登记为待验证） |
| 零依赖纪律 | Business | lib/kb-audit.mjs 头注释（Cannot find module 事故） |

## 4. 风险覆盖（10 分）

| 风险类 | 有无涉及 | 分析与对策 |
|---|---|---|
| Compatibility 兼容 | 有 | 旧格式条目（无 `系统:` 头）兜底 runbooks + 报告警示，**不阻塞**；lint `warn` 模式先行，观察期后 Owner 决定切 `strict` |
| Exception 异常 | 有 | organize 任何异常 ⇒ 捕获后降级为旧行为（原样 commitAll）并在报告醒目标注；webhook 处理异常 ⇒ 恒返回 200 免 Gitea 重试风暴，错误进审计 |
| Cache 缓存 | 不适用 | 无缓存层；lint 结果即时计算 |
| MQ 消息 | 不适用 | webhook 即消息，幂等（同 SHA 重复投递结果一致，纯函数） |
| State 状态机 | 有 | 归并幂等性是正确性核心：条目文件归并后**移除**（内容在活档案+git 历史）⇒ 下次 sync 不再归并；活档案按「日期+设备」小节去重 |
| Security 安全 | 有 | webhook HMAC-SHA256 共享密钥校验（常数时间比较）；lint 不回显任何凭据；status/comment 用既有 admin 凭据（服务已持有） |

## 5. 验证覆盖（10 分）

| 验证手段 | 内容 | 可执行入口 |
|---|---|---|
| Unit 单测 | organize 纯函数：头解析/域解析/兜底/幂等（二次运行零变更）/同名冲突回退；lint 规则：白名单/文件名/元数据一致性/相似度阈值边界 | `packages/ops-extension/test/kb-org.test.ts`（bun test） |
| Contract 契约 | 真 HTTP：PR 事件 → HMAC 校验 → diff 拉取 → status 写回（stub Gitea 记录调用）；warn/strict 两模式行为 | 新增 `scripts/probe-kb-lint.sh` 入 test:ci |
| Regression 回归 | 既有 test:ci 全绿（含 kb-ui 渲染验收 8/8） | `npm run test:ci` |
| Monitoring 监控 | lint 结果入审计（event=lint.<verdict>，含 PR/SHA/违规摘要）；`omo-kb logs` 可查 | 既有 logs 通道 |
| Rollback 回滚 | lint 模式回 `warn`/关闭 webhook 即回到现状；sync organize 独立函数，可整体禁用（env 开关） | config/环境变量 |

## 6. 不确定性治理（10 分）

| # | 类型 | 描述 | 处置 |
|---|---|---|---|
| 1 | 待验证 | Gitea 1.27.3 的 PR files / statuses / comments API 可用性 | 实现前先探针实证（列入 T2 验收）；不可用 ⇒ 降级为"评审者本地跑 lint 命令"（`omo kb lint`），门禁语义不变 |
| 2 | 待调参 | 相似度阈值（0.9 拦 / 0.5 警） | 上线 warn 期收集数据后 Owner 调整 |
| 3 | Human Decision | warn→strict 切换时机 | Owner 在观察期后拍板（建议 2 周） |

## 7. 任务拆解（落定后填）

| 看板任务号 | 任务 | 可验收条目 | 级别预期 |
|---|---|---|---|
| KBORG-1（本任务） | T1 organize 纯函数 + sync 集成 | 单测：幂等/兜底/冲突回退 全绿 | — |
| KBORG-1 | T2 kb-lint 规则引擎 + webhook + status 回写 | 契约探针全绿；Gitea API 可用性实证 | — |
| KBORG-1 | T3 domains.yml + README 规范段 + 探针接线 | test:ci 全绿；清单/断言齐 | — |
| KBORG-1 | T4 发布 v0.14.0 + warn 期运行 + strict 切换检查单 | Owner 侧设置完成、观察期数据可查 | — |

## 8. 决策门记录

| 命中门 | 决策 | 决策人/时间 |
|---|---|---|
| High-risk Change（改 4 实例合流语义） | 方向获 Owner 认可（2026-09-21「同意这个方案」）；分期 warn→strict 控切换风险；strict 时机 Owner 拍板 | Owner 2026-09-21 |
| Business Trade-off（存量处置） | 存量 33 篇不迁移 | Owner 2026-09-21 |

## 设计偏离登记（相对会话口头方案）

| 偏离 | 理由 |
|---|---|
| 取消 `<域>/archive/`（口头方案有） | 归并=内容进活档案+条目文件移除 ⇒ git 历史即存档；archive 会引入第二类规则与碎片 |
| 未知域兜底 runbooks 而非报错阻断 | 保证"合规成本≈0"承诺：写作者忘填/填错也不被卡；lint 会在 PR 上亮出来 |
| lint 增加模式开关（warn 先行） | 4 台存量实例未升级 sync 前会被 strict 误伤 ⇒ 分期切换 |
