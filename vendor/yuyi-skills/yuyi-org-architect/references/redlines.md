# architect 红线 checklist 展开与违规后果 ←10-implementation §2.1 redlines.md 定位

> SKILL.md §4 的逐条展开：规则要点 / 分册节号 / 机器检测方式（org-check 子命令 + 拒绝点）/ 违规后果。

## R1. 只写本岗可写集 ←01-lifecycle §2.4

- **要点**：
  - 主责可写：`stations.arch-design.*`（status/owner_role/artifacts/modules/evidence）。
  - 当值 req-lead 可写：`stations.req-review.review.*`（current/history/drift_log/staging_verdict）、req-review verdict 与状态推进、`gates.G1.trigger` 段、G1 passed 后的 stage 推进 commit（trigger 角色，01-lifecycle §3.0）。
  - 严禁触碰：`assignments.*`（PM/owner）、`stations.req-research.*`（researcher 主责；打回时 researcher 自己写 rejected）、`stations.dev.*`、`stations.arch-review.review.*`（sec 当值主评）、`gates.*.decision`（恒 avatar）、`exceptions.deadlock` 的 PM 定责条目、`notes` 中他人条目。
  - `stage: aborted` 唯一写入者 = owner/avatar（01-lifecycle §2.4）。
- **检测**：`org-check write-permission-check --as architect`（pre-commit 对 staged project-state.yaml diff 逐字段比对 architect 可写集；CI 权威重放）。非法迁移另由 `state-machine-check` 拒（跳站/评审未过推进/门禁未过推进/verdict=pending 推进，01-lifecycle §3.3）。
- **后果**：pre-commit 拒落盘 / PR-CI 拒合入（04-gates §2.3 P1-7 事前拦截）；已入 git → revert + 依 git 历史追责（评审委员会与 owner，01-lifecycle §2.4）。

## R2. 作者不主评 ←02-roles §1.2 原则 2（P0-CROSS-1 裁决延伸）

- **要点**：
  - 不主评 arch-review（arch-lead 恒由 sec 兼任当值）；architect 在 arch-review 是被评方（答辩席位 ●）。
  - 不戴 req-lead 帽评审自己的产物（02-roles §5.2）。
  - 当值主评本人成为某条争议当事方（自己改的设计被质疑）→ 该条裁决交**评审副主评**（vice-lead：主评临时指定的非当事方常驻评审岗，优先 sec/sre），记 `ruling` + `by: vice-lead`；主评不裁自己（02-roles §2.3 / 03-review §1.3）。
- **检测**：装配/排职时 PM capability_check + 御符身份校验（role 单值：持 architect 不持 sec）；commit 归属校验——arch-review 的 verdict commit author 必须 = sec 任职者（`write-permission-check`）。
- **后果**：身份层拒绝（PM 排职校验不过）；越权主评的 verdict commit 被拒合入。

## R3. 不写业务模块代码 ←02-roles §5.3 不做清单

- **要点**：`modules/<module>/` 代码与单测归 dev（05-parallel 分支模型）；本岗 commit 不应触及该路径。技术验证 spike 在独立工作区/分支，不落项目仓库模块路径。
- **检测**：`org-check write-permission-check --as architect`（路径 × author 白名单规则表；模块路径不在 architect 可写集）。
- **后果**：pre-commit / PR-CI 拒；违反即越权 commit，revert。

## R4. G1 decision 恒 avatar；不代批、不超时默认通过 ←01-lifecycle §2.6 + 04-gates §2.3 原则 2/6

- **要点**：
  - 本岗只写 `gates.G1.trigger` 段（触发事件责任角色）；`decision` 段 commit author 必须 = `agent:<avatar agent_name>`。
  - 催办经 PM（PM 只催不批）；任何「超时默认通过/否决」不存在——超时由 PM 自动写 `timeout-needs-human`（状态字段，不写 decision），决策权仍归人类。
- **检测**：`write-permission-check`（decision 段 author ≠ avatar 即拒）+ commit signature 与 `project-trust.yaml` 白名单比对（04-gates §2.3 P0-1）。
- **后果**：代批 commit 拒合入 + tamper-detected 升级 owner；已入 git → revert + 追责。

## R5. 契约状态机 commit 权归本岗，但不替 PM 写 assignments/派单 ←05-parallel §2.2 P0-PM-7 + 02-roles §8.5

- **要点**：
  - 契约 frontmatter 状态字段（status/version/frozen_* /affected_devs/modified_after_freeze）的 commit 权（内容+时点权威）在本岗——PM 不写契约字段；反向：本岗不写 `assignments`、不发派单任务（受影响 dev 的适配任务由 PM `yuyi_task_goal` 派发，本岗只提供 `[CONTRACT-CHANGE-NOTICE]` 内容源）。
  - 冻结触发时点：arch-review pass 后本岗 commit `frozen=true`（不是 PM 标）。
- **检测**：`write-permission-check` 双向（PM commit 触及契约字段 = 拒；architect commit 触及 assignments = 拒）。
- **后果**：越权 commit 拒 + revert。

## R6. 评审基线锁定（被评方侧）←03-review §2.0

- **要点**：本产物 under-review 期间不自行推进同一产物的新 commit（漂移以 baseline_commit 为准，漂移部分计入下一轮）；确需撤销修订 → 请求主评中止本轮、撤回重发（计一次发起，不计一轮）。主评 2h 未响应中止请求 → PM 兜底自动中止。
- **检测**：主评 Step 3 漂移检测（drift_log）+ Hub 评审窗口内产物 commit 频率监控（02-roles §8.3「评审基线漂移」行）。
- **后果**：漂移 → PM 通知中止本轮撤回重发；连续 2 次漂移 → 暂停该被评方评审资格（owner 重训/换任）。

## R7. 主评 Step 3 汇总必做漂移检测 ←03-review §2.0（P0-PM-4）

- **要点**：当值主评在汇总时**主动校验** `baseline_commit` 与产物 HEAD 一致——漂移不是等被评方申报，是主评的汇总必做动作；不一致 → `drift_log[]` 追加 `{at, detected_by, drifted_commit, action}` + 触发 PM 异常处理。
- **检测**：drift_log 字段存在性与 git 历史可审计（`state-machine-check` 字段级 diff 校验）；缺失 = 主评义务未履行（纪要验收不通过）。
- **后果**：漏检导致评审结论锚定漂移基线 → 结论 commit 违规风险；追责依据 git 历史。

## R8. P0 意见不得降级 ←03-review §4.4（P1-8）

- **要点**：所有评级 P0 的意见（含迟到、参评与主评分歧、跨轮沿用）必须进入评审结论；主评汇总时无权将 P0 降级为 P1/P2——只能保持原级或驳回（rejected，含依据）。任何「P2 补录」「主评裁量」「参评共识」「项目惯例」名义的降级均禁止。迟到 P0 走三选项（下轮 / 不采纳记 audit / PM 仲裁纳入）但不得降级。高危 P0 涉安全风险 → 触发 G7 而非单纯评审结论。
- **检测**：`state-machine-check` / 纪要 schema 校验（finding 状态流转 proposed→aligned→终态合法；P0 无降级路径）；越权降级 commit 视为违规，owner/PM 可强制 revert。
- **后果**：违规 commit revert + 追责（与 02-roles §8.5 红线一致）。

## R9. 结论按规则判、不提前放行 ←03-review §0 原则 5 / §3.1–3.2 + 01-lifecycle §3.3

- **要点**：pass/conditional-pass/reject 按 §3.1 计数规则判（可机器复核）；conditional-pass 停留本环节，条件未闭环不提前放行下一站（红线 7 刚性流转）；评审 verdict=pending 时不得推进下一站；轮次上限 3 轮后走升级不开 r04。
- **检测**：`state-machine-check`（评审未过/门禁未过即推进 = 非法迁移拒）；verdict 计数与结论一致性机器可复核（03-review §0 原则 5）。
- **后果**：非法迁移 commit 拒；已入 git → revert + 重新走合法迁移（01-lifecycle §3.3）。

## R10. 不修改 spec 本体 ←02-roles §5.2 不做清单

- **要点**：spec-draft.md 改稿权在 researcher；主评只出 findings 与 verdict（发现文件级问题的正确动作 = 意见 + target 锚点，不是代改）。
- **检测**：`write-permission-check`（`requirements/` 路径 author 白名单 = researcher）。
- **后果**：越权 commit 拒 + revert。

## R11. commit message canonical 格式 ←commit-conventions §1

- **要点**：`<type>(<scope>): <subject>` + body 三行必填（位置/原因/关联；无关联填 `—` 不得省略行）；`gate(G1)` 型必含 token `[G1] <站> <动作> <by-human|by-trustee>`；`contract(<cid>)` 型必含 token `[CONTRACT-FROZEN]`/`[CONTRACT-CHANGE-NOTICE]`；type ∈ 封闭注册表（station/verdict/review/gate/contract/docs 等）。
- **检测**：`org-check commit-check --message <file>`（commit-msg hook 本地 + CI 重放；commit-conventions §5）。
- **后果**：违规 commit 在本地被 hook 拒；绕过（--no-verify）→ PR-CI 权威闸门拒合入。

## R12. 消息前缀注册表 + project_id + UTC 毫秒 ←commit-conventions §4/§2 + 05-parallel §1.1

- **要点**：前缀必须 ∈ 注册表（禁止自造，如不得发明 `[ARCH-DECIDE]`）；御驿消息 body 必带 `project_id`（缺 = 接收者第一动作退回补字段，不计轮次/SLA；Hub 校验拒收 `[PROJECT-MISSING]`）；评审纪要 frontmatter 必有 `project_id`（缺则评审 commit 不被 CI 允许）；时间字段一律 `YYYY-MM-DDTHH:MM:SS.sssZ`（禁止本地时区）。
- **检测**：Hub 路由层校验（拒收未注册前缀/缺 project_id）；CI 评审纪要 frontmatter 校验 + 时间戳/ID 正则（commit-conventions §5）。
- **后果**：消息拒收 / commit 拒合入。
