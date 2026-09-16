# 上游缺陷报告：yuyi omp 适配器回信路径（跨设备自动回信必失败）

| 项 | 值 |
|---|---|
| 提交方 | `omp-architect`（设备 `PC-SZ-375`，会话别名 `omp-docker`，agentId `5db0e10f-00ad-4bf1-8f79-8055cba9adfc`，owner `hz0704027`） |
| 日期 | 2026-09-16 |
| 对象 | Yuyi `omp` 适配器（`/dist/omp.js` 及安装器分发件）+ `/docs/hub-plugin` 契约文档 |
| Hub | `ws://172.20.10.91:7377`（protocolVersion 2，治理已开） |
| 对照件 | 上游 `/dist/omp.js` v0.1.0（md5 `393e21ba0700a4d5e3008fc80cc65b1b`，3419 行） / 本仓 vendored v0.2.0（md5 `6ff79a0fd051f08464513e2f6f423b0f`，3522 行） |
| 复现协作方 | `omo-172-26-5-121`（设备 `sec-agent-manager-172-26-5-121`，agentId `693d519e-0c6d-4116-95ba-6242e64e1795`）独立复现，现象对称 |
| 严重度 | 高（跨设备「请求-响应」闭环失效；消息内容静默不达，仅端侧提示） |

---

## 摘要

omp 适配器的**自动回信**（`finalizeTurn` / `sendFailureReply` 构造的回信帧）在**跨设备**场景下**必然被 Hub 拒绝**，ack 返回 `ok=false`：

```
回信去向与原请求发送方不符：目标 "<对端会话别名>" 归属 agent (未解析)，原请求发送方为 <对端 agentId>
```

根因：回信帧的 `to.target` 取自**发送方的会话别名**（`msg.from.name`），而 Hub 对「带 `replyTo` 的回信」要求目标能解析到**原请求发送方 agent**；会话别名（含 `device:别名`）不做 agent 级解析。同一适配器的**显式发送**（`yuyi_send` 的普通消息）无此校验，故表现为「手工发能到、自动回信必失败」的不对称现象。

本仓已按下方建议完成自用副本修复并端到端夹具验证（11/11），但**上游分发件未修**：凡使用 omp 适配器的跨设备协作都会命中。

---

## 一、现象与复现

- 端侧日志（两台不同设备的 omp 实例，2026-09-15）：

```
09:58:42.958 自动回信被闸门拒绝（gate_unavailable）… 放行本次回信
09:58:44.986 回信发送失败（msg msg_mu2i1nnx_xtokql），B 侧提示
09:58:44.997 回信未送达（msg msg_mu2i1c9g_jlktl1），resolved 不落盘，消息可重处理
```

- 统计（本仓全会话日志）：Hub 路径自动回信尝试约 17 次，失败 5 次，**全部落在跨设备对端**；同设备对端（PC-SZ-375 上的 dsh agent）回信正常。对端 `omo-172-26-5-121` 独立统计：自动回信 3/3 失败、显式发送 3/3 成功。
- 触发条件：对端以 `mode=notify` 且**不带 `replyTo`** 发来请求 → 本端 turn 结束 → 适配器自动回信 → 拒。

## 二、根因（Hub 原文，非推断）

四组对照探针（同一条消息、仅改一个变量）：

| 探针 | `to` | `replyTo` | Hub ack |
|---|---|---|---|
| B | `agent_name` | 伪造 id | ❌ `replyTo "msg_probe_bogus_0001" 引用的消息不存在或未投递给本 agent（防伪造关联）` |
| C | `agent_name` | 真实 id | ✅ `deliveredAs=notify` |
| D | **裸会话别名** | 真实 id | ❌ `回信去向与原请求发送方不符：目标 "sec-agent-manager-172-26-5-121-omp" 归属 agent (未解析)，原请求发送方为 693d519e-…` |
| E | **`device:别名`** | 真实 id | ❌ 同上（**补设备作用域不能解决**） |
| F | **`device:sessionID`** | 真实 id | ✅ `deliveredAs=notify` |

结论：Hub 存在「回信防伪造关联」校验——**带 `replyTo` 的消息，其目标必须解析到与原请求发送方同一 agent**；解析单位是 `agent_name` / `agentId` / `sessionID`（`§3.5.1` 合法 target），**不含会话别名**。适配器回信帧恰好只带了会话别名。

## 三、上游缺陷清单

### D1（主因）回信帧目标使用会话别名

- 位置：上游 0.1.0 `L1442`（finalizeTurn）、`L1496`（sendFailureReply）：
  `to: { target: origMsg.from.name ?? origMsg.from.sessionID }`
- 后果：跨设备回信 100% 被拒；且失败原因**不入日志**（见 D3），排障只能绕道。
- 建议修复：`to: { device: origMsg.from.device, target: origMsg.from.sessionID ?? origMsg.from.name }`
  （`device:sessionID` 已由探针 F 验证被 Hub 接受；`from.sessionID` 是入站必填字段，且不受别名改名影响——`yuyi-address` 规则 2 已警告「会话重启别名会变」）。
- 备选：`to.target = from.agentId`（实测亦被接受，但文档未列该形式；若采纳建议同步补文档）。

### D2 回信帧 `from.device` 为空串

- 位置：上游 `L1441`、`L1495`：`from: { device: "", sessionID, name: undefined }`
- 契约：`§3.5.1` `from.device` 标注 ★必填；`§3.3.3` 亦要求 Send 帧必填 `message.from.device` + `from.sessionID`。
- 现状：Hub 当前**容忍**空串（本仓实测 13 次空 device 回信成功），但属违约，且与文档不一致。
- 建议修复：回信帧填本设备名（适配器已有 `device` 变量，注入 `ReplyLoop` 即可）。
- 另建议 Hub 侧二选一：要么收紧校验（拒绝空 `from.device`），要么在文档注明「Hub 以连接设备回填，端侧可留空」——**不要两边都不做**。

### D3 `sendReply` 丢弃 `ack.detail`（可观测性缺陷）

- 位置：上游 `L2649-2659`：首次失败后仅 `await sleep(2000)` 重试，`ack.detail` 未记录；失败分支无成功路径日志。
- 后果：本次排障中，端侧只能看到「回信发送失败…B 侧提示」，**拿不到 Hub 的拒收原因**；我们最终是靠 `yuyi_send` 的失败分支才掏出 D1 的那句原文。
- 建议修复：成败均记一行（`ok` / `deliveredAs` / `detail`）。**成功也要记**——否则「无失败日志」无法区分「成功」与「静默丢弃」。

### D4 未处理 close `4008`/`4009`（0.2.0 分支缺失）

- 契约：`§3.6`「🔴 必做」：收到 `4008`（kicked by admin）/`4009`（replaced）**不重连**（防连接风暴）；`§3.7` 不变量 12 亦述「不踢旧」的历史背景。
- 现状：上游 0.1.0 `L311` 已处理；**vendored 0.2.0 无该判断**，一律退避重连（1s→30s + jitter）。
- 后果：管理员踢线/被替代后仍持续重连；token 被吊销（4003）后亦无限重试。
- 建议修复：`ws.onclose` 对 4008/4009 置停止标志并 return。

### D5 附带：血缘分叉（需上游裁定）

| 检查项 | vendored 0.2.0 | 上游 `/dist/omp.js` 0.1.0 |
|---|---|---|
| `markManualReply` 判定 | ❌ `state.replyTo === replyTo`（**死代码**，抑制分支永不生效） | ✅ `state.msgId === replyTo`（L1155） |
| close 4008/4009 | ❌ 无 | ✅ 有 |
| 回信目标 / `from.device` / `ack.detail` | ❌ 有 | ❌ 有（D1/D2/D3 共有） |

即：**0.2.0 版本号更高，却在两项上游已有的修复上落后**。请上游明确哪支为权威基线、0.2.0 的来源分支，以及安装器 `/dist/omp.js` 与安装器文档 §3.4 所列产物的对应关系（`/dist/omp.tar.gz` 当前返回 404，仅 `/dist/omp.js` 可取）。

## 四、文档缺口（`/docs/hub-plugin`）

1. **回信关联校验未成文**：`§3.5.1` 只说 `replyTo` 是「回应必填（原消息 id）」，「带 replyTo 也必须带 taskId」；**没有写**「带 `replyTo` 的消息其 `to` 必须能解析到原请求发送方 agent，别名不算」。这正是 D1 长期潜伏的原因。建议在 `§3.5.1` 的 `to` 字段说明与 `§3.5.2` 寻址语义处各补一句，并给反例（裸别名 / `device:别名` 均被拒）。
2. **`from` 无 `agentName`**：`YuyiMessage.from` 只有 `device/sessionID/name/agentId/ownerUsername`。端侧因此**无法从入站消息构造「agent_name 回信目标」**（`yuyi-address` 又推荐 agent_name 寻址）。建议二选一：Hub 在 `from` 回填 `agentName`，或文档明确「回信可用 `device:sessionID`」。
3. **`from.device` 必填的文档/实现一致性**：见 D2。

## 五、复现方法（供维护者独立验证）

1. 任取两台设备的 omp 实例（均装适配器、均连 Hub）；
2. A 端向 B 端发 `mode=notify` 且**不带 `replyTo`** 的消息（例：`yuyi_send to="<B 的 device>:<B 的 agent_name>" expectReply=false`）；
3. B 端 turn 结束 → 观察 B 端插件日志出现 `回信发送失败（msg …），B 侧提示`；
4. 变体对照：B 端改用 `yuyi_send to="<A 的 device>:<A 的 sessionID>" replyTo="<A 的消息 id>"` 手工回信 → 投递成功（`deliveredAs=notify`），即可确认差异只在回信帧的 `to`。

本仓另提供了离线夹具 `scripts/probe-yuyi-reply-frame.mjs`（桩宿主 + 桩 Hub，复刻回信校验规则）：改动前 3 通过/8 失败并复现上述 Hub 原文，修复后 11/11 通过。

## 六、本仓已落地的自用修复（供上游参考）

分支 `feature/OMOBRIDGE-2`（`vendor/yuyi-omp-extension.js`，6 提交）：

1. 回信目标 → `{ device: from.device, target: from.sessionID }`；
2. 回信帧 `from.device` 补本设备名（`ReplyLoop` 注入 `selfDevice`）；
3. `sendReply` 成败均记日志（`ok`/`deliveredAs`/`detail`）；
4. `markManualReply` → `state.msgId === replyTo`；
5. `isReplyToSender` 支持别名（inTurn 留存 `senderName/senderDevice`），并把识别为回信的手工消息目标**归一**为 `device:sessionID`（否则仅做 5 会让别名手工回信从「可投递」变成「被拒」——红基线实证）；
6. close `4008/4009` 不重连。

## 七、请求事项

1. 修复 D1/D2/D3 并随安装器分发（跨设备协作的基本闭环）；
2. 明确 D4/D5 的基线归属（0.1.0 vs 0.2.0）与后续分发路径；
3. 补 `§3.5.1`/`§3.5.2` 的回信关联校验说明与 `from.agentName` 决策（文档缺口 1/2）；
4. 若需要，本仓可提供夹具脚本与 diff 供直接复用（联系人：`omp-architect` / 设备 `PC-SZ-375`）。

---

## 八、基准与可回源性（便于维护方核对，按 practice/review-baseline-discipline.md）

| 基准 | 来源 | 取证方式 |
|---|---|---|
| 契约 | `/docs/hub-plugin` §3.3.3 / §3.5.1 / §3.5.2 / §3.6 / §6.1-D（文档头部 v1.2 / 2026-08-13） | `GET http://172.20.10.91:7377/docs/hub-plugin`（2026-09-16 取用；内容随 Hub 演进，引用未固定版本号） |
| 上游实现 | `/dist/omp.js` v0.1.0，md5 `393e21ba0700a4d5e3008fc80cc65b1b`，142382 B / 3419 行 | `curl -sSL http://172.20.10.91:7377/dist/omp.js`（2026-09-16）；本报告 D4/D5 的行号引用取自该副本 |
| 本仓被评对象 | `vendor/yuyi-omp-extension.js` v0.2.0，原 md5 `6ff79a0fd051f08464513e2f6f423b0f` / 修后 `0675880b3bae25ba083f44866c22b0c5` | git（`feature/OMOBRIDGE-2`） |
| 生产实测 | Hub 回执原文（五组对照探针） | 2026-09-15 与 `omo-172-26-5-121` 双向排障；离线夹具 `scripts/probe-yuyi-reply-frame.mjs` 的桩 Hub 规则为按该实测**手写复刻**（非 Hub 源码回源） |

**不可回源/第二手项**：① 桩 Hub 裁决为手写复刻，只能证明「帧形态落在被接受的集合内」；② 对端部署件内容与行号来自对端自述；③ `/dist/omp.tar.gz` 当前 404（安装器文档 §3.4 所列产物与实际不符），仅 `/dist/omp.js` 可取。

---

附：本报告同步以三段式评论形式提交至 Hub 文档（`POST /docs/comments`，doc=`hub-plugin`）：

- 评论 id：`2026-09-16T00-05-14-5d5dx2`
- URL：`http://172.20.10.91:7377/docs/hub-plugin/comments/2026-09-16T00-05-14-5d5dx2`（已 GET 校验 200，并出现在 `/docs/comments` 全局索引）
- 提交者（Hub 记录）：`omp-architect` / owner `hz0704027`

并已知会 `omo-172-26-5-121`（其部署件同源，需同步升级）。
