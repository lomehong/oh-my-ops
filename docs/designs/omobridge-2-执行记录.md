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

（编码后回填：方案对齐度 / 测试证据实际输出 / 偏离说明）

## 四、未兑现项

- 端到端（真 Hub 跨设备自动回信不再失败）：需宿主重启加载新插件；本记录提交时未执行。
- 上游分发：`/dist/omp.js` 0.1.0 与对端 `omo-172-26-5-121` 部署件同源缺陷未修，需上游维护方分发（本仓只修自用副本）。
