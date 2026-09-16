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
| T7 | close 4008/4009 不重连（⑥） | 同上（桩 Hub 主动 close 4008） | 红：仍发起新连接；绿：连接数不再增长；对照 close 1006 → 仍会重连 |
| T8 | 部署副本一致 | `cp vendor/… ~/.omp/agent/extensions/ && md5sum` 双侧 | md5 一致 |

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
| 红基线（改动前） | `node scripts/probe-yuyi-reply-frame.mjs --bundle /tmp/orig-yuyi-omp.js` | **3 通过 / 8 失败**；桩 Hub 裁决复现生产原文「回信去向与原请求发送方不符：目标 "PEER-DEV-omp" 归属 agent (未解析)，原请求发送方为 peer-agent-id」 |
| c2 提交后 | 同上（默认 bundle） | 7 通过 / 4 失败（T2/T3/T4 转绿；T5/T5b/T6/T7 未覆盖） |
| c3 提交后 | 同上 | 10 通过 / 1 失败（T5/T5b/T6 转绿；T7 未覆盖） |
| c4 提交后 | `node --check` + 夹具 | `node --check` PASS；**11 通过 / 0 失败**（exit 0） |
| 部署一致 | `md5sum vendor/… ~/.omp/agent/extensions/…` | 双侧 `0675880b3bae25ba083f44866c22b0c5` |

### 3.3 偏离说明（必须显式）

- **⑦ 超出原 6 条清单，属 ⑤ 的必要配套**：红基线实证——仅做 ⑤ 时，别名寻址的手工回信会被标记为「回信」，
  于是被 Hub 回信校验拒（`归属 agent (未解析)`），**投递反而失败**（改动前该消息作为普通消息本可投递）。
  故按 in-turn 发送方的 agent 级地址（`device:sessionID`）归一，语义不变（同一 agent），符合 docs
  「回信走 replyTo 权威路由」。已在此登记，请主人在实现评审时确认。
- **新增使用侧规则（非代码改动）**：跨设备回信的目标必须是 agent 级（`agent_name` / `device:sessionID` / `agentId`）；
  裸别名与 `device:别名` 仅适用于非回信的新消息。

## 四、未兑现项

- **端到端（真 Hub + 跨设备对端自动回信不再失败）**：插件在宿主进程内加载，改动需宿主**重启会话**后生效；
  本记录提交时运行中的会话仍是旧插件（内存态），故该项未兑现。重启后判据：跨设备 notify 入站（无 replyTo）
  → 插件自动回信 → 日志出现「回信已投递：… deliveredAs=notify」且不再出现「回信发送失败…B 侧提示」。
- **上游分发**：`/dist/omp.js` 0.1.0 与对端 `omo-172-26-5-121` 部署件同源缺陷（回信目标裸别名、`from.device` 空、
  `ack.detail` 丢弃）未修，本仓只修自用副本。**我方已提交上游**（2026-09-16）：
  - 正式报告 `docs/reports/yuyi-omp-adapter-reply-path-defects-2026-09-16.md`（D1–D5 + 文档缺口 + 复现方法）；
  - Hub 文档评论 `2026-09-16T00-05-14-5d5dx2`（doc=`hub-plugin`，三段式，已 GET 校验 200）；
  - 已知会 `omo-172-26-5-121`（其部署件同源，需同步升级）。
  待上游修复并随安装器分发。
- **待确认发现（未改，登记备查）**：插件初始化会 `connect()` 两次（工厂末尾 + `session_start`），产生一条
  僵尸 Hub 连接（本夹具实测 `connections=2`；生产日志亦有两条「连接 Hub」）。疑与「同 agent 多连接合并投递」
  语义相关，未在本次范围内改动。
