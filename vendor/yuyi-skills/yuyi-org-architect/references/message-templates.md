# architect 御驿消息模板全文 ←10-implementation §2.1 message-templates.md 定位

> 通用规则（10-implementation §2.3 模板三要素）：**前缀**必须 ∈ commit-conventions §4 注册表（禁止自造）；**收件人**按岗寻址——agent_name 寻址 + assignments 解析 post→任职者（02-roles §7.3 双源解析，冲突以御符为准）；**正文骨架** body 必带 `project_id`（00-context 决策 3），时间字段一律 UTC ISO8601 毫秒（commit-conventions §2）。每条标注触发时机（与 SKILL.md §2 流程一一对应）；状态类动作同时给出对应 commit type（commit-conventions §1.2 注册表）。

## 1. `[STAGE-COMPLETE]`（发）←01-lifecycle §5.2

- **收件人**：arch-lead（sec 任职者）+ PM。
- **触发**：arch-design 完成、状态推进 commit 落地后（SKILL §2A-7）。
- **commit type**：`station(arch-design)`。

```
subject: [STAGE-COMPLETE] <project_id>/arch-design 完成 提审 arch-review
body:
  project_id: proj-<slug>-<N>
  stage: arch-design → arch-review
  station_status: arch-design: done
  out_commit: [<design.md hash>, <modules.md hash>, <contracts hash>, <risks.md hash>]
  evidence: <L1 自验 yuyi_task_verify 结果 ref>
  at: <UTC ISO8601 毫秒>
```

## 2. `[REVIEW-OPEN]`（发：提审架构；收：受理需求评审）←03-review §2.1

**发（本岗作为被评方提审 arch-review）**——触发：SKILL §2A-7；commit type `station(arch-design)`：

```
subject: [REVIEW-OPEN] <project_id>/arch-review r01 评审发起
body:
  project_id: proj-<slug>-<N>
  review_id: rv-<N>
  baseline_commit: <hash>            # 锁定的评审基线
  materials: [architecture/design.md, architecture/modules.md, architecture/contracts/*.md, architecture/risks.md]
  self_check: <自检清单结论（四项完成判据逐项 + 可测试性 ADR 三项执行件）>
  entry_state_commit: <project-state.yaml commit>
## 3. `[REVIEW-FINDINGS]`（收 ← 参评各席；本岗受邀参评其他委员会时才作为发送方）←03-review §2.2

- **方向**：**收**——当值主评收集并行独立意见（Step 2 窗口内到达，带 room_id，Hub 窗口结束才互见）；是 Step 3 汇总的输入。
- **发送场景**：本岗仅在被邀请至其他委员会（如受邀参评）时，作为发送方按下方格式出本视角意见。
- **触发**：SKILL §2B-2 独立窗口。

```
subject: [REVIEW-FINDINGS] <review_id> from agent:<agent_name>
body:（可多条）
  - severity_suggest: P0|P1|P2     # 建议级，定级权在主评
    target: <文件#章节>            # 锚点（或 commit:file:line）
    problem: <事实 + 依据>
    suggestion: <可操作建议>
    cross: false                    # 交叉意见置 true
```

## 4. `[REVIEW-SUMMARY]`（发，主评）←03-review §2.3

- **收件人**：被评方（researcher）+ 全体参评 + PM。
- **触发**：SKILL §2B-3 findings.md v1 commit 后；commit type `review(req-review)`。

```
subject: [REVIEW-SUMMARY] <project_id>/<review_id> 意见清单已提交 <findings_commit>
body:
  project_id: proj-<slug>-<N>
  review_id: rv-<N>
  findings_commit: <hash>
  stats: { P0: <n>, P1: <n>, P2: <n>, X: <n> }
  alignment_deadline: <UTC ISO8601 毫秒>
```

## 5. `[REVIEW-VERDICT]`（发，主评）←03-review §2.5

- **收件人**：被评方 + PM；（pass 时）avatar 通道。
- **触发**：SKILL §2B-5 verdict commit 后；commit type `verdict(req-review)`。

```
subject: [REVIEW-VERDICT] <project_id>/<review_id> 结论：<通过|有条件通过|打回>
body:
  project_id: proj-<slug>-<N>
  review_id: rv-<N>
  round: <N>
  verdict: pass | conditional-pass | reject
  verdict_commit: <hash>
  stats: { P0: <n>, P1: <n>, open: { P0: <n>, P1: <n> } }
  conditions: [...]                 # conditional-pass 必填（每条 finding/owner/deadline）
  blockers: [P0-1, ...]             # reject 必填
```

## 6. `[STAGE-REJECT]`（发，主评打回通知）←01-lifecycle §5.2

- **收件人**：被评方（researcher）+ PM；与 `[REVIEW-VERDICT]` reject 同义。
- **触发**：SKILL §2B-5 verdict=reject；commit type `verdict(req-review)`。
- **正文骨架**：同模板 5（verdict: reject + blockers）。

## 7. `[REVIEW-FIX]`（收 / 发）←03-review §2.6

**收（当值主评侧）**：researcher 回报条件闭环/修订 → 进入 Step 7 复核。

**发（本岗作为 arch-review 被评方）**——触发：SKILL §2D 打回修订完成 / conditional 修订完成：

```
subject: [REVIEW-FIX] <project_id>/<review_id> 回报 commit
body:
  project_id: proj-<slug>-<N>
  fix_commit: <hash>                 # 基于锁定基线的修订 commit
  disposition:                       # 逐条处置表（每条采纳意见必填落点）
    - id: P1-2
      action: adopted
      where: architecture/design.md#3.4   # 修订落点（commit diff 内可指认）
    - id: P1-3
      action: rejected
      reason: <对齐已裁定的驳回理由>
```

## 8. `[REVIEW-CLOSED]`（发，主评）←03-review §2.7

- **收件人**：全体相关方。
- **触发**：SKILL §2B-7 全部 P0/P1 终态；commit type `review(req-review)`。

```
subject: [REVIEW-CLOSED] <project_id>/<review_id> 闭环 <record_commit>
body:
  project_id: proj-<slug>-<N>
  review_id: rv-<N>
  record_commit: <hash>
  final: { P0: <闭环数>, P1: <闭环数>, deferred: <n> }
  next: G1 触发 | 无
```

## 9. `[REVIEW-ESCALATE]`（发，主评）←03-review §5.2

- **收件人**：PM。
- **触发**：同环节 3 轮未通过 / 无进展判定（SKILL §2B 轮次管理）；commit type `review(req-review)`。

```
subject: [REVIEW-ESCALATE] <project_id>/<review_id> 3 轮未通过
body:
  project_id: proj-<slug>-<N>
  review_id: rv-<N>
  rounds: 3
  open_items: { P0: <n>, P1: <n> }
  no_progress_evidence: <§5.3 判定依据>
  suggest: <需求矛盾 | 能力不匹配 | 评审侧问题>
```

## 10. `[GATE-REQUEST]` G1（发 → avatar）←04-gates §3.1

- **收件人**：avatar（人类门禁唯一通道）。
- **触发**：SKILL §2B-7 评审 pass + 条件全闭环后；commit type `gate(G1)`（trigger 段本岗 commit；decision 段恒 avatar）。
- 发送后按 04-gates §3.1 序列：`yuyi_task_attach(task_id=G1_review_<proj>)` + `yuyi_task_goal` 附 4 条验收 goal。

```
subject: [GATE-REQUEST] <project_id> G1 需求确认
body:
  project_id: proj-<slug>-<N>
  gate: G1
  stage: req-review
  trigger_commit: <hash>
  verdict_commit: <hash>
  baseline_commit: <hash>
  materials: [requirements/spec-draft.md, docs/reviews/req-review-rNN/findings.md, docs/reviews/req-review-rNN/verdict.md]   # commit refs
  rounds: <int>
  open_questions: <int>              # 0 = 已清零
  sla: 24h                           # 项目级
```

**task_goal 4 条**（04-gates §3.1）：
```
{ criterion: 需求验收标准逐条可执行, evidence_type: spec-commit }
{ criterion: 评审 P0 全部闭环, evidence_type: findings-commit }
{ criterion: 开放问题全部上报或清零, evidence_type: spec-section }
{ criterion: 范围边界明确无蔓延, evidence_type: spec-section }
```

## 11. `[GATE-DECISION]` G1（收）←04-gates §3.1

- **发送者**：avatar 通道（decision commit author 恒 avatar，本岗不写 decision）。
- **触发**：SKILL §2B-7 后人类决定回执。
- **本岗响应**：
  - `confirm` → G1 passed：本岗 commit stage `req-review → arch-design` + `stations.arch-design.status: in-progress`（可同 commit）；`yuyi_task_verify` 回写任务闭环；随后 PM 派活给 architect（本岗续接 arch-design 任务链）。
  - `reject` → 等价评审 reject：走 `[STAGE-REJECT]` + 新一轮；verify 写 reject，门禁任务转 suspended。
  - `defer` → stage 不变，等人类指定重审时刻。

## 12. `[CONTRACT-DRIFT-REQUEST]`（收）←05-parallel §2.2

- **发送者**：dev（提请修改 frozen 契约）。
- **触发**：SKILL §2C 契约裁决入口；本岗 ≤1h SLA 裁决 adopt / reject / modify。

```
subject: [CONTRACT-DRIFT-REQUEST] <project_id>/<contract_id> <一句话变更诉求>
body:
  project_id: proj-<slug>-<N>
  contract_id: <cid>
  current_version: v<N>
  proposal: <变更提案>
  affected_modules: [...]
  reason: <事实与依据>
```

## 13. `[CONTRACT-CHANGE-NOTICE]`（发）←05-parallel §2.4

- **收件人**：PM（派发）+ 全部受影响 dev；cc arch-lead（sec）。
- **触发**：SKILL §2C thaw 裁决 adopt/modify 后；commit type `contract(<cid>)`。

```
subject: [CONTRACT-CHANGE-NOTICE] <project_id>/<contract_id> v<N> → v<N+1>
body:
  project_id: proj-<slug>-<N>
  contract_id: <cid>
  proposer: agent:<dev agent_name>   # 或 agent:<architect>（本岗主动变更）
  change_summary: <一段话说明改什么>
  affected_modules: [module-A, module-B]   # 从 dependency_graph 反查
  estimated_impact: <对每个受影响模块的影响面>
  proposed_window: <ISO 时间段，期望窗口内完成各方适配（4h–48h）>
  fallback: <部分模块无法窗口内适配的兜底：并行版本/适配层/回滚>
  cc: PM, architect, 全部受影响 dev
```

## 14. `[CONTRACT-FROZEN]`（发，内容源）←05-parallel §2.2

- **收件人**：PM 按已派单名单派发（本岗提供内容源）。
- **触发**：SKILL §2C 契约 frozen / 重 frozen（arch-review pass 后、thaw 小改裁决后、新评审轮 pass 后）；commit type `contract(<cid>)` **必含 token** `[CONTRACT-FROZEN]`。

```
subject: [CONTRACT-FROZEN] <project_id>/<contract_id> v<N> <commit>
body:
  project_id: proj-<slug>-<N>
  contract_id: <cid>
  version: v<N>
  frozen_commit: <hash>              # 接口基线
  frozen_at: <UTC ISO8601 毫秒>
  conditions: [...]                  # conditional-pass 冻结时附条件清单
```

## 15. `[PROJECT-ABORT]`（收）←01-lifecycle §4.2

- **发送者**：avatar（广播全部任职者）。
- **触发**：项目中止。
- **本岗响应**：停止在途动作；当值主评的在途评审轮写 `[REVIEW-ABORTED]`（commit type `review(req-review)`）；不触碰 pending 门禁字段（owner/avatar 标 skipped）。
