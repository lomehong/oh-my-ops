# 溯源清单：yuyi-omp-extension.js（vendor 适配器）

> 本件是 `vendor/yuyi-omp-extension.js` 的**变更前置条件**：任何对该文件的改动（含上游整文件同步）
> 都必须同步更新本件与 `yuyi-omp-extension.sha256`，并跑绿 `npm run test:vendor`。
> 体检脚本 `scripts/probe-vendor-integrity.sh`（`npm run test:vendor-integrity`，已入 test:ci）会核对三者一致。

## 一、来源与当前指纹

| 项 | 值 |
|---|---|
| 上游来源 | `/dist/omp.js` v0.1.0 — `http://172.20.10.91:7377/dist/omp.js`（2026-09-16 取用，**未入库**） |
| 上游基准 md5 | `393e21ba0700a4d5e3008fc80cc65b1b`（142382 B / 3419 行） |
| 本仓基线 | vendored v0.2.0，md5 `6ff79a0fd051f08464513e2f6f423b0f`（3522 行，`chore(vendor): 同步…`） |
| 当前文件 md5 | `5f4df5896c596509c3e2e880afc12cda`（3544 行） |
| 当前文件 sha256 | `ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751` |

上游 0.1.0 与本仓基线 0.2.0 是**血缘分叉**（0.1.0 修了两项 0.2.0 退化的行为，见 D4/D5）；
选 0.2.0 为基线并在其上打 D1-D5 补丁，判定依据见 `docs/reports/yuyi-omp-adapter-reply-path-defects-2026-09-16.md` §三 D5。

## 二、本仓补丁清单（相对 vendored v0.2.0；行号为当前文件）

| 编号 | 缺陷（上游同源） | 补丁 | 位置 |
|---|---|---|---|
| D1 | 回信帧 `to.target` 用会话别名 ⇒ Hub「回信防伪造关联」校验拒收（跨设备自动回信必失败） | `to: { device: from.device, target: from.sessionID ?? from.name }`（agent 级寻址） | L1562（finalizeTurn）/ L1620（sendFailureReply） |
| D2 | 回信帧 `from.device` 为空串（契约 §3.5.1 标必填） | `ReplyLoop` 注入 `selfDevice`，帧内填本设备名 | L1169 / L1561 / L1619 / L2635-2638 |
| D3 | `sendReply` 丢弃 `ack.detail` ⇒ 失败原因不可观测 | 成败均记一行（`ok` / `deliveredAs` / `detail`） | L2675 / L2684 一带 |
| D4 | close `4008`/`4009`（kicked/replaced）仍重连 ⇒ 连接风暴 | `onclose` 见到 4008/4009 按协议不重连 | L449-451 |
| D5 | `markManualReply` 判定为 `state.replyTo === replyTo`（**死代码**，抑制分支永不生效） | 改 `state.msgId === replyTo` | L1297-1299 |
| D5 配套 | 手工回信识别只认 sessionID ⇒ 别名/agentId 寻址的手工回信逃过抑制，且照旧发别名目标 | `isReplyToSender` 支持别名/agentId/sessionID，识别为回信后**目标归一**为 `device:sessionID` | L3030-3034 一带 |
| 附带 | 宿主加载器把 literal UTF-8 中文按非 UTF-8 解码 ⇒ 插件日志乱码 | 新增日志一律 `\uXXXX` 转义（T12 守卫：bundle 必须纯 ASCII） | L2675 / L2684 等 |

## 三、同步规程（上游更新时照此执行）

1. **diff 审查**：取上游新构建，与本文件 diff——逐条确认 D1-D5 补丁是否仍在（上游可能已修，则改为对齐上游形态）；
2. **探针绿**：`npm run test:vendor` 必须 15/15（exit 0）；
3. **更新清单**：重算 md5/sha256 写入本件「当前文件」行，并把 sha256 写入 `yuyi-omp-extension.sha256`；
4. **体检**：`npm run test:vendor-integrity` 全绿（含 D1 回滚负例必须变红）；
5. **提交**：提交信息带 `OMOVENDOR-1` 前缀，便于追溯。

**红即回退**：第 2 步红说明同步把回信修复吃掉了（OMOBRIDGE-2 的静默回退场景），不得合并；
不得在未跑绿探针的情况下更新清单（清单更新＝声明「已审过且行为正确」）。

## 四、上游未修残留登记（截至 2026-09-26）

- D1/D2/D3 在**上游 0.1.0 与 0.2.0 上均未修**：凡使用上游分发件的跨设备协作都会命中（D1 为主因，回信 100% 被拒）。
- 已提交上游/Hub 的登记与请求：
  - 缺陷报告：`docs/reports/yuyi-omp-adapter-reply-path-defects-2026-09-16.md`（含复现方法、五组对照探针原文、文档缺口）；
  - Hub 文档评论（`POST /docs/comments`，doc=`hub-plugin`）：id `2026-09-16T00-05-14-5d5dx2`，
    URL `http://172.20.10.91:7377/docs/hub-plugin/comments/2026-09-16T00-05-14-5d5dx2`（已 GET 校验 200）；
  - 对端 `omo-172-26-5-121` 已知会（其部署件同源）。
- **收口方式**：若上游完成修复并分发，则「上游件 md5 一致性 + 本仓探针绿」双证后撤下补丁与红线（参考 OPSP-P10 先例）；
  届时本件改写为「上游 X 版本 + 零补丁」形态。

## 五、不可回源/第二手项（按 practice/review-baseline-discipline.md）

- `scripts/probe-yuyi-reply-frame.mjs` 的桩 Hub 裁决规则是**按生产实测手写复刻**（非 Hub 源码回源）——只能证明「帧形态落在被接受的集合内」；
- 对端部署件内容与行号来自对端自述（第二手），本仓未直接读取；
- `/dist/omp.tar.gz` 当前 404（安装器文档 §3.4 所列产物与实际不符），仅 `/dist/omp.js` 可取。
