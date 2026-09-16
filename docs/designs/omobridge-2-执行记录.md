# OMOBRIDGE-2 执行记录 — yuyi 适配器回信路径修复

> 任务号：OMOBRIDGE-2 ｜ 分支：`feature/OMOBRIDGE-2` ｜ 改动件：`vendor/yuyi-omp-extension.js`（= 部署件 `~/.omp/agent/extensions/yuyi-omp-extension.js`，md5 同源）
> 依据：`/docs/hub-plugin` §3.3.3 / §3.5.1 / §3.5.2 / §6.1-D、`/docs/skills` → yuyi-address 规则 2/3、御驿实测（2026-09-15，与 omo-172-26-5-121 / omo-logstash-124 双向排障）

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令/夹具 | 预期观察（红 → 绿） |
|---|---|---|---|
| T1 | 语法门 | `node --check vendor/yuyi-omp-extension.js` | 无输出（exit 0） |
| T2 | 回信帧目标为 agent 级 | `node scripts/probe-yuyi-reply-frame.mjs`（桩 Hub 按真实回信校验规则裁决） | 红：`to.target=PEER-DEV-omp`（裸别名）→ 桩 Hub 拒 `回信去向与原请求发送方不符…(未解析)`；绿：`to.device=PEER-DEV` + `to.target=omp_peer1` → 桩 Hub 接受 |
| T3 | 回信帧 `from.device` 非空 | 同上 | 红：`from.device=''`；绿：`from.device='HARNESS-DEV'` |
| T4 | 回信结果可观测（成败均记） | 同上 + grep 插件日志 | 红：无成功/失败明细行；绿：`回信已投递：msg=… deliveredAs=notify` 或 `回信投递失败（重试后）：… detail=…` |
| T5 | 手工回信抑制生效（④） | 同上（第二条入站 + 别名寻址的 `yuyi_send`） | 红：日志无「手工回信检测」，turn 末仍自动回信；绿：日志出现「手工回信检测：replyTo=… 命中 inTurn(msgId)」且不再自动回信 |
| T6 | 别名手工回信自动补 `replyTo`（⑤） | 同上 | 红：出站帧无 `replyTo`；绿：`replyTo=msg_peer_2` |
| T7 | close 4008/4009 不重连（⑥） | 同上（桩 Hub 主动 close 4008） | 红：仍发起新连接；绿：连接数不再增长；对照 close 1006 → 仍会重连。**观察窗 12s > 最坏重连时延 7s**（reconnectDelay 2000ms + jitter ≤5000ms）——窗口过短会出现假绿（评审 G1），本项为窗口敏感判据 |
| T8 | 部署副本一致 | `cp vendor/… ~/.omp/agent/extensions/ && md5sum` 双侧 | md5 一致 |
| T9 | `sendFailureReply` 路径覆盖（G2） | 夹具场景 D1（宿主注入抛错 → `sendFailureReply`） | 红：未发出（旧件回信帧目标为裸别名、`from.device` 空）；绿：帧发出且 `to={device:PEER-DEV,target:omp_peer1}`、`from.device=HARNESS-DEV` |
| T10 | 首投拒 → 重试成功（G2） | 同上（桩 `rejectNextAttempts=1` 注入首投失败） | 红：无日志；绿：`acks=false,true` + 日志「回信投递失败（首次）」与「回信已投递（重试）」双段 |
| T11 | 两次均拒 → 失败双段 + B 侧提示（G2） | 同上（`rejectNextAttempts=2`） | 红：无日志；绿：`acks=false,false` + 「回信投递失败（重试后）：… detail=…」+「回信发送失败（msg …），B 侧提示」 |

端到端（真 Hub + 跨设备对端）：**跨设备 notify 入站（无 replyTo）→ 插件自动回信 → 不再出现「回信发送失败」**。需宿主重启加载新插件后方可执行 → 登记为未兑现项（见第四节）。

## 二、Do → 文件/行映射

| 改动 | 落点（改动前行号） |
|---|---|
| ① 回信目标 agent 级 | `vendor/yuyi-omp-extension.js:1554`（finalizeTurn）、`:1612`（sendFailureReply） |
| ② 回信帧 `from.device` | `:1441`、`:1495`（两处回信帧）+ `ReplyLoop` 构造注入本设备名（`:1150-1164`、`:2632`） |
| ③ 回信结果日志 | `sendReply` `:2649-2661` |
| ④ `markManualReply` | `:1291-1295`（`state.replyTo` → `state.msgId`） |
| ⑤ 别名回信识别 | `inTurn.set :1471-1480`（新增 `senderDevice/senderName`）、`getInTurnReplyTarget :1175-1180`、`yuyi_send :3010-3015` |
| ⑥ close 码 | `ws.onclose` `:428-449` |

## 三、对照自检

### 3.1 方案对齐度（Do → 落地点，改动后行号）

| 改动 | 落地点 | 与计划一致 |
|---|---|---|
| ① 回信目标 agent 级 | `vendor/yuyi-omp-extension.js:1562`（finalizeTurn）、`:1620`（sendFailureReply） | ✅ |
| ② 回信帧 `from.device` | `:1561`、`:1619`（回信帧）+ `:1169`（ReplyLoop 注入）、`:2638`（构造处传 device） | ✅ |
| ③ 回信结果日志 | `sendReply` `:2675` / `:2680` / `:2684` / `:2689` | ✅（另修 trace 重试分支插值笔误） |
| ④ `markManualReply` | `:1299`（`state.msgId === replyTo`） | ✅（与上游 0.1.0 L1155 对齐） |
| ⑤ 别名回信识别 | `:1486`（inTurn 留存 senderDevice/senderName）、`:1185`（透出）、`:3032`（比对） | ✅ |
| ⑦ 回信目标归一（⑤ 的必要配套） | `:3021`（声明）、`:3041`（归一）、`:3053`（应用） | ⚠️ **超出原 6 条清单**，见 3.3 |
| ⑥ close 4008/4009 | `:449` | ✅ |

### 3.2 测试证据（实际输出）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 红基线（改动前，评审后扩展夹具） | `node scripts/probe-yuyi-reply-frame.mjs --bundle /tmp/orig-yuyi-omp.js`（连跑 2 次） | **两次均 3 通过 / 11 失败**；桩 Hub 裁决复现生产原文「回信去向与原请求发送方不符：目标 "PEER-DEV-omp" 归属 agent (未解析)，原请求发送方为 peer-agent-id」；**T7b 在 12s 观察窗下两次都红**（评审前的 5s 窗曾出现 1 次假绿） |
| c2 提交后 | 同上（默认 bundle） | 7 通过 / 4 失败（T2/T3/T4 转绿；T5/T5b/T6/T7 未覆盖） |
| c3 提交后 | 同上 | 10 通过 / 1 失败（T5/T5b/T6 转绿；T7 未覆盖） |
| c4 提交后 | `node --check` + 夹具 | `node --check` PASS；11 通过 / 0 失败 |
| 评审整改后（G1/G2） | `node scripts/probe-yuyi-reply-frame.mjs` | `node --check` PASS；**14 通过 / 0 失败（exit 0）**——新增 T9/T10/T11 覆盖 `sendFailureReply` 与重试语义；T7 观察窗 12s |
| 部署一致 | `md5sum vendor/… ~/.omp/agent/extensions/…` | 双侧 `0675880b3bae25ba083f44866c22b0c5` |

> 夹具耗时约 31s（含两段 12s 观察窗）；红基线约 85s/2 次。`T7` 属**窗口敏感判据**，判据值与理由已写进夹具注释与 T7 行。

### 3.3 偏离说明（必须显式）

- **⑦ 超出原 6 条清单，属 ⑤ 的必要配套**：红基线实证——仅做 ⑤ 时，别名寻址的手工回信会被标记为「回信」，
  于是被 Hub 回信校验拒（`归属 agent (未解析)`），**投递反而失败**（改动前该消息作为普通消息本可投递）。
  故按 in-turn 发送方的 agent 级地址（`device:sessionID`）归一，语义不变（同一 agent），符合 docs
  「回信走 replyTo 权威路由」。已在此登记，请主人在实现评审时确认。
- **新增使用侧规则（非代码改动）**：跨设备回信的目标必须是 agent 级（`agent_name` / `device:sessionID` / `agentId`）；
  裸别名与 `device:别名` 仅适用于非回信的新消息。
- **⑦ 状态**：评审已独立反证其必要性（去归一保留 ⑤ → T6 红、投递反而失败）；**主人 2026-09-16 已确认放行**（同日台账 OMOBRIDGE-2 `confirm` 落定）。

### 3.4 不做项（Don't，评审 G6 要求显式）

| 不做 | 理由 |
|---|---|
| 不修改上游 `/dist/omp.js` 或其仓库 | 非本仓管辖；仅提交缺陷报告与评论，等上游分发 |
| 不替换/降级本仓 vendored 0.2.0 为上游 0.1.0 | 0.2.0 另有新增能力（工具集一致但代码面更宽），替换面大于本任务；血缘分叉交由上游裁定 |
| 不修「插件初始化 connect() 两次产生僵尸连接」 | 属独立缺陷，需先确认与「同 agent 多连接合并投递」的交互；本次仅登记备查 |
| 不改 `HubClient` 的重连退避参数（1s→30s + jitter ≤5s） | 与 ⑥ 无关；改参数会牵动「防连接风暴」语义，须单独方案 |
| 不在本任务内处理对端（`omo-172-26-5-121` 等）的部署件升级 | 对端本地变更需其 Owner 预授权；我方只提交报告并知会 |
| 不为通过评审而调整任何判据阈值（除 G1 明示的观察窗） | 判据只允许按「窗口敏感」显式登记后调整；不得以改判据代替改实现 |

## 四、未兑现项

- **端到端（真 Hub + 跨设备对端自动回信不再失败）**：插件在宿主进程内加载，改动需宿主**重启会话**后生效；
  本记录提交时运行中的会话仍是旧插件（内存态），故该项未兑现。重启后判据：跨设备 notify 入站（无 replyTo）
  → 插件自动回信 → 日志出现「回信已投递：… deliveredAs=notify」且不再出现「回信发送失败…B 侧提示」。
  - **未知项（评审 G3）**：对端若仍为未升级的上游件，其回信帧 `from.device` 为空串，我方回给它的目标会变成
    `to={device:"", target:<sessionID>}`——**该形态在真机能否被 Hub 解析未知**（桩按 device 相等规则必然接受，
    无区分度）。真机 E2E 须把这条单列观察：若 `device:""` 被拒，则 `to.device` 为空时应回退为不带 device
    （仅 `target=sessionID`，§3.5.1 合法形式），届时按知识漂移流程回改实现。
- **上游分发**：`/dist/omp.js` 0.1.0 与对端 `omo-172-26-5-121` 部署件同源缺陷（回信目标裸别名、`from.device` 空、
  `ack.detail` 丢弃）未修，本仓只修自用副本。**我方已提交上游**（2026-09-16）：
  - 正式报告 `docs/reports/yuyi-omp-adapter-reply-path-defects-2026-09-16.md`（D1–D5 + 文档缺口 + 复现方法）；
  - Hub 文档评论 `2026-09-16T00-05-14-5d5dx2`（doc=`hub-plugin`，三段式，已 GET 校验 200）；
  - 已知会 `omo-172-26-5-121`（其部署件同源，需同步升级）。
  待上游修复并随安装器分发。
- **知识回写（评审建议，已执行 2026-09-16）**：`architect-knowledge/practice/yuyi-reply-addressing-contract.md` 已入库
  （status `待审核`），三台账同步（`practice/index.md` / `review-queue.yaml` / `source-manifest.yaml`），
  knowledge-lint **PASS（0 error，42 条目：已确认 41 / 待审核 1）**。
  - **偏差登记**：大脑仓在容器内**无 git 仓库**（`/opt/architect` 仅 `dsh-architect`、`omp-architect` 两个子仓有 `.git`），
    故该条目未能按 knowledge-distill 第 8 步提交版本控制——需在有 git 的宿主侧补提交。
- **待确认发现（未改，登记备查）**：插件初始化会 `connect()` 两次（工厂末尾 + `session_start`），产生一条
  僵尸 Hub 连接（本夹具实测 `connections=2`；生产日志亦有两条「连接 Hub」）。疑与「同 agent 多连接合并投递」
  语义相关，未在本次范围内改动。

## 五、影响面与回滚（评审 G4）

### 5.1 影响面

| 面 | 说明 | 风险与缓解 |
|---|---|---|
| 回信投递 | 跨设备自动回信由「必被拒」变为可投递；同设备回信行为不变（目标由别名改为 `device:sessionID`，Hub 侧解析到同一 agent） | 低。回信仍带 `replyTo`+`taskId`，Hub 的防伪造关联校验语义未变 |
| 手工回信 | 别名寻址的手工回信被识别为「回信」（自动补 `replyTo`）且目标归一到 `device:sessionID` | 中→低。**归一改变了出站帧的目标写法**：若用户本意是给「另一个设备上的同名别名」发新消息，将被归一到 in-turn 发送方（同一 agent）。触发条件严格（仅当 `to` 与 in-turn 发送方的 sessionID/agentId/别名三者之一匹配），且文档方向一致（回信走 replyTo 权威路由） |
| 连接行为 | close `4008/4009` 后不再自动重连 | 中。**4008 真机触发源=Hub 管理员踢线**（§3.6）；`4009` 上游已标注「已废、Hub 不再主动发」，保留分支用于兼容旧 Hub——但评审提示其真机触发源还可能是**同 token 多会话 / 初始化双连接**（本插件确实存在该形态，见 §四末条），此点**未验证**（[未知]，需真机观测 Hub 是否在双连接下下发 4009）。置 `closed=true` 后**实例内无自动恢复路径**（进程内无外部接口），需宿主重启或人工重新 `connect()` → 管理员误踢的代价由「反复重连」变成「人工重启」，与契约要求一致但需运维知情 |
| 上游同步 | `vendor/yuyi-omp-extension.js` 是**上游构建拷贝**（仓库历史中 `chore(vendor): 同步…` 为整文件替换） | **高（最需注意）**：本次补丁未上游化前，任何一次上游同步都会**静默回退**本修复。缓解：① 已提交上游报告与 Hub 评论（见 §四）；② 本记录与夹具是回退的检测器（同步后跑夹具应仍 14/14，红即回退）；③ 提交信息带 `OMOBRIDGE-2` 前缀便于追溯 |

### 5.2 回滚

```bash
# ① 代码回滚（本仓）
git checkout main -- vendor/yuyi-omp-extension.js     # 或 git revert <c2..c4>
# ② 部署件回滚（运行宿主）
cp /tmp/deployed-backup-yuyi-omp.js ~/.omp/agent/extensions/yuyi-omp-extension.js   # 旧件 md5 6ff79a0fd051f08464513e2f6f423b0f
# ③ 回滚后自证
node scripts/probe-yuyi-reply-frame.mjs --bundle ~/.omp/agent/extensions/yuyi-omp-extension.js   # 应回到 3 通过 / 11 失败
```
- 回滚不影响 Hub 侧状态（无服务端变更）；已发出的消息无补偿需求（回信幂等由 Hub `replyTo` 关联保证）。
- 备份件路径 `/tmp/deployed-backup-yuyi-omp.js` 为临时位置，长期保留请另存（如 `docs/reports/` 附件或制品库）。

## 六、基准与可回源性（评审 G5，按 `practice/review-baseline-discipline.md`）

| 基准 | 来源 | 可回源性 | 取证方式与时间 |
|---|---|---|---|
| A 契约 | `/docs/hub-plugin`（§3.3.3 / §3.5.1 / §3.5.2 / §3.6 / §6.1-D） | ✅ 可回源（HTTP，随 Hub 走） | `read http://172.20.10.91:7377/docs/hub-plugin`（2026-09-16） |
| B 上游实现 | `/dist/omp.js` v0.1.0（md5 `393e21ba0700a4d5e3008fc80cc65b1b`，142382 B，3419 行） | ⚠️ 需网络；**未入库** | `curl -sSL http://172.20.10.91:7377/dist/omp.js`（2026-09-16）；D4/D5 的行号引用（L311 / L1155 / L1441-1442 / L1495-1496 / L2649-2659）取自该副本 |
| C 本仓被评对象 | `vendor/yuyi-omp-extension.js` v0.2.0（md5 `6ff79a0f…` 原 / `0675880b…` 修后） | ✅ 入库（git） | `git show main:vendor/…` / 工作树 |
| D 生产实测 | Hub 回执原文（探针 B/C/D/E/F） | ⚠️ 会话记录内，未入库为结构化证据 | 2026-09-15 与 `omo-172-26-5-121` 双向排障；桩 Hub 的裁决规则按其**手写复刻** |

**不可回源 / 第二手项（显式登记）**：
1. **桩 Hub 的裁决规则**是手写复刻（非 Hub 源码回源）——它只能证明「帧形态是否落在被接受的集合内」，不能证明 Hub 实现细节；
2. **对端 `omo-172-26-5-121` 的部署件内容与行号**来自对端自述（第二手），本仓未直接读取其文件；
3. `/docs/hub-plugin` 的**内容会随 Hub 演进**，本次引用未固定版本号（文档头部标注 v1.2 / 2026-08-13）——后续若文档更新，以新版本重核。
