# architect 站内流程展开（含异常路径分支）←10-implementation §2.1 flows.md 定位

## §A arch-design 站产物规范（展开）←05-parallel §2.1 + 06-testing §3.2

### A1. `architecture/modules.md` 必含字段（05-parallel §2.1）

frontmatter：`schema_version: modules-v1` / `project_id` / `frozen: false`（arch-review pass 后由本岗 commit 置 true，见 §C）/ `prepared_by` / `prepared_at`（UTC ISO8601 毫秒）。

每模块：`id` / `name` / `owner_suggest`（建议任职者，非硬派）/ `paths[]` / `interfaces: {consumes[], produces[]}` / `parallel_degree: high|medium|low` / `estimated_effort: S|M|L|XL` / `risks[]`（引用 risks.md）。
另附：`dependency_graph[]`（from/to/type=produces|consumes，PM 派单排序与集成顺序依据）+ `parallel_capacity: {current, rationale}`。

**关键校验（05-parallel §2.1）**：
- 每个模块的 `interfaces.consumes/produces` 必须在 `architecture/contracts/` 有对应契约文件（无契约 = 无并行合法性）。
- `parallel_degree: high` 必须满足：①无 consumes 依赖（叶模块）或 consumes 契约已 frozen；② paths 与其它模块无重叠（撞路径 = 撞文件）。
- dependency_graph 决定派单顺序：consumes 为空先派；强依赖后派；无依赖可同步派。

### A2. 可测试性 ADR 写法（06-testing §3.2，缺则可测性评审打回）

`architecture/design.md` 必含「可测试性 ADR」段，每条：

```markdown
### 可测试性 ADR-<id> <标题>
- 决策: <架构如何保证可测性>
- 约束: <环境可起 / 依赖可注入 / 数据可隔离 / 测试可独立执行>
- 影响: <受影响模块 / 受影响接口契约>
- 落项: <具体设计：环境模板 / 依赖注入点 / 测试桩接入点 / 隔离账户策略>
- 验证: <该 ADR 如何被一个集成测试 / 一段文档验证>
```

主题示例与缺则后果（06-testing §3.2 表）：环境可起（提供 start 命令，启动 ≤5min，缺则 L2/L3 无法执行）；依赖可注入（DB/缓存/队列/三方可配置切换+启动校验可达）；种子数据可重置（seed/reset 幂等）；账号隔离（create-test-user，前缀 `test-`）；日志可观测（启动/错误/业务分离 + trace_id 贯穿）；接口契约可验证（OpenAPI/proto/schema + 校验工具）；测试钩子（test-unit/integration/e2e 三类命令）。

**三项执行件（T2-9）**：环境类 ADR（E1/E2/E3）除决策/约束/落项外必附 ①启动命令 ②环境变量清单 ③依赖可达性验证脚本（可执行、exit code 判定）——缺任一项 = 可测性评审打回；启动命令优先复用体系层 `yuyi-template-project` baseline 模板（make start-dev/start-test/start-integration/start-acceptance）。
**L1 环境基线（06-testing §3.3）**：ADR 必填 `<runtime>+<version>+<OS>`（项目级统一，CI runner 与 dev 本地对齐）。

## §B 当值 req-lead 评审七步展开 ←03-review §2 + §6

**委员会构成（03-review §1.1 / 02-roles §2.3）**：主评 = architect（当值 req-lead，✉）；必到 ● = pm / tester / sec（researcher 答辩）；按需 ○ = dev（工作量 sanity check）/ ops / sre；无列席。

**Step 1 受理**：收 `[REVIEW-OPEN]`（review_id=rv-<N>，baseline_commit，materials，self_check，entry_state_commit）→ ≤1h 回执（expectReply 的回信）受理 + 宣布并行窗口与截止时刻；材料缺失/commit 不可复现 → 当场退回（不计轮次）。
**Step 2 独立评审**：主评也是实质评审者——出本视角完整意见（完备性：缺场景/缺边界条件；可实现性与技术成本；与现状系统/其他项目需求冲突）。意见单条格式 `[REVIEW-FINDINGS]`：severity_suggest(P0|P1|P2 建议)/target(文件#章节)/problem(事实+依据)/suggestion(可操作)/cross(交叉置 true)。窗口内互不通气（room_id=review_id，Hub 窗口结束才广播）。
**Step 3 汇总分级**：①合并去重（同问题多票合并保留 reviewer 记录；低质量意见退回或丢弃须留痕 status=proposed + resolution=dropped）；②定级（P0=不修必然不可用/不可逆风险/红线违背；P1=显著缺陷主体成立；P2=建议不阻断）；③交叉意见（前缀 X）裁归属方（谁改）+ 关联方（谁确认）；④**漂移检测（必做）**：校验 baseline_commit 与产物 HEAD，不一致 → `review.current.drift_log[]` 追加 `{at, detected_by, drifted_commit, action}` + 触发 PM「评审基线漂移」异常处理；⑤commit findings.md v1 → `[REVIEW-SUMMARY]`。
**Step 4 逐条对齐**：被评方逐条回应（同意修订/不同意+理由/申请降级）→ 主评裁决（驳回回应须给依据）；争议 → PM 仲裁一次（ruling 字段）；PM 当事方 → 升级人类（≥3 条打包 `[REVIEW-ESCALATE-HUMAN-BATCH]`）；参评定级申诉 → 主评重裁一次 → 仍不服 PM 仲裁终局。对齐完成各条 proposed→aligned，主评 commit。
**Step 5 结论判定**（03-review §3.1，规则化）：pass=无 P0 且未闭环 P1=0；conditional-pass=无 P0 且未闭环 P1 1–4 且全部已对齐「同意修订」、修订局部；reject=①有未闭环 P0 或②未闭环 P1≥5 或③结构性重做。流程：先写 `review.current.staging_verdict`（state commit）→ 确认后 commit verdict.md → `[REVIEW-VERDICT]`。含未解决 dissent 的 verdict 必须 owner 显式批准才能通过（03-review §4.5）。
**Step 6 条件闭环**：conditional-pass 停留本环节（status: in-progress），conditions 入 verdict（每条 finding/owner/verify/deadline）；超 deadline → 转 reject（计一轮）。
**Step 7 复核闭环**：复核分工 P0=主评+提出者 / P1=主评 / P2=主评抽查；范围按增量原则（上轮未闭环落点+diff 触及+交叉复查+抽样；上轮 P0≥3 或结构性打回或波及>50% → 全量）；全部 P0/P1 终态 → findings 状态 commit + `[REVIEW-CLOSED]` + `yuyi_task_verify` 回写；pass → commit `gates.G1.trigger` + `status: awaiting-human` → `[GATE-REQUEST]` G1。

**SLA 基线（03-review §6.1，不得短于；可加长需项目策略显式声明）**——需求评审：标准 窗口 24h/汇总 4h/对齐 24h/修订回报 48h/复核 12h（总 ≤5 工作日）；紧急（owner 标记 urgent + avatar 确认，或事故回流/P0 缺陷触发）4h/2h/8h/16h/4h（总 ≤1.5 工作日）。主评宣布的窗口 ≥ 角色基线窗口最大值（sec≥4h、sre≥4h、pm≥2h、tester≥2h、dev≥4h、ops≥4h；03-review §6.2）。撤销修订：主评 2h 未响应中止请求 → PM 兜底自动中止（不计一轮）。

**轮次与升级（03-review §5）**：同一环节最多 3 轮（r01–r03）；第 3 轮仍打回 → `[REVIEW-ESCALATE]` PM 定性（需求矛盾→G5/能力不匹配→换任开 r04/评审侧问题→调席位）。无进展判定（任一）：新一轮未闭环 P0/P1 数未降；同一意见（carried_from 链）连续两轮未闭环无成立驳回；被评方连续两轮缺席对齐。

## §C 契约冻结状态机（开发期裁决）←05-parallel §2.2/§2.4

```
draft（本岗起草）→ under-review（arch-review 任一轮内）→ frozen（pass 后本岗 commit frozen=true）
  → 修改提议 → thawing（本岗 commit；登记 affected_devs）→ frozen(v+1)（小改直接裁决 / 大改新评审轮 pass 后）
```

- 契约 frontmatter：`contract_id` / `version` / `status: draft|under-review|frozen|thawing` / `frozen_at` / `frozen_by` / `frozen_commit`（接口基线 hash）/ `affected_devs[]`（thawing 时必填）/ `modified_after_freeze[]`（append-only，解冻必填理由+改动人+影响面）。
- 冻结触发表：arch-review pass / conditional-pass（带 conditions）→ 本岗 commit frozen=true + 发 `[CONTRACT-FROZEN]`（PM 通知全部已派单 dev）；dev 提改 → `[CONTRACT-DRIFT-REQUEST]` → 本岗 ≤1h 裁决 adopt/reject/modify → commit thaw → ①小改直接 frozen v2（更新 modified_after_freeze + affected_devs=[]）②大改发起评审轮 → pass 后 frozen v+1。
- 变更窗口 4h–48h（内为「软冻结」，可继续基于原契约开发但集成前必须迁移）；窗口结束新契约 frozen，全部 dev 须在新契约重跑单测才可合入 integration。同一契约冻结后 24h 内解冻 ≤1 次（超出 PM 召集本岗+受影响 dev 复议）。并行版本兜底（v1+v2 并存 ≤2 周）由本岗决定 + PM 同意。
- 依赖类型决定通知面（05-parallel §2.4）：类型依赖→全部 consumers；接口依赖→双方 dev ack；数据依赖（DB schema/共享存储，高风险）→ 本岗必参评；运行时依赖→releaser 同步部署策略。
- **P0-PM-7 权责**：契约状态 commit 权（内容+时点）归本岗；PM 派单与通知但不写契约字段、不写 stations。

## §D 异常路径分支（本岗义务）←01-lifecycle §3.2/§4.1/§4.3

| 异常 | 场景 | 本岗义务 |
|---|---|---|
| 评审打回（本岗被评方） | arch-review verdict=reject（blockers） | stage 回 arch-design + 本站 `status: rejected` + `rejected_by{source: review, rejector_role: arch-lead}`（P0-PM-6）；按 blockers 修订 → 新 commit → 重新 `[REVIEW-OPEN]`（round+1 锚定新 hash） |
| 基线锁定 | 本产物 under-review | 不自行推进同一产物新 commit（漂移以锁定 hash 为准，漂移部分计入下一轮）；确需撤销 → 请主评中止本轮撤回重发（计一次发起不计一轮） |
| G1 rejected（当值主评侧） | avatar decision=reject | 等价评审 reject：通知 researcher 修订重提（`[STAGE-REJECT]` + 新一轮 `[REVIEW-OPEN]`）；stage 推进不发生 |
| G5 变更跳回 | 变更影响 arch-design | 本岗 = 被影响站 author：commit stage 跳回 + `status: changed` 标记（历史）+ `in-progress`（重新启动）；产物变更需重做时主动重审；三权分立——PM 只写 change_plan.md 提案、avatar 写 G5 decision，本岗不越权代写 |
| 跨站死锁被定责 | dev 等契约裁决 / 本岗等需求澄清互等超 SLA | PM 写 `exceptions.deadlock`（定责+强制动作）后，本岗主动 commit 执行动作（临时接口决议 / 澄清补充）；执行 commit author = 本岗，PM 不写 stations |
| 项目中止 | `[PROJECT-ABORT]` | 停止在途动作；本岗当值主评的在途评审轮写 `[REVIEW-ABORTED]`；pending 门禁由 owner/avatar 标 skipped（本岗不触碰） |
| L2 拒收（下游） | 下游对本岗产物拒收（如 tester 拒收） | 本岗自己 commit `status: rejected` + `rejected_by{source: <下游 role>}`（保持该站字段由该站主责写）；同站连续 2 轮 → 自动升级 PM |

## §E 状态推进 commit 汇总（canonical 格式 ←commit-conventions §1）

| 动作 | commit message |
|---|---|
| arch-design 启动 | `station(arch-design): pending→in-progress G1 passed 启动架构设计` |
| 提审 | `station(arch-design): arch-design→arch-review 提审` |
| 评审记录 | `review(req-review): findings r02 v1` / `verdict(req-review): r02→pass P0=0` |
| G1 触发 | `gate(G1): [G1] req-review trigger → awaiting-human verdict:pass` |
| G1 通过后推进（trigger 角色） | `station(req-review): req-review→arch-design G1 passed`（可与新站 in-progress 同 commit） |
| 契约冻结/解冻 | `contract(<cid>): [CONTRACT-FROZEN] v<N> <hash>` / `contract(<cid>): revise v<N>→v<N+1> thaw` |
| 被打回 | `station(arch-design): arch-review→rejected blockers=[P0-1]` |

body 三行必填（位置/原因/关联——ISSUE-<seq> | inc-* | rv-<N> | G<n> | task_id | —）。
