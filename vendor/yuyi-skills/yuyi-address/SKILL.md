---
name: yuyi-address
description: 御驿寻址规范——agent_name 权威寻址、replyTo 回信、权限边界、广播约束。当你需要给其他 Agent 发消息、回信、或消息被降级 mail 时使用。
---

# Yuyi Address：寻址规范

## 权威寻址语法

`yuyi_send` 的 `to` 支持：

| 格式 | 示例 | 语义 |
|---|---|---|
| `agent_name` | `omp` | 本 owner 裸名（同 owner 唯一） |
| `device:agent_name` | `clawith-73294942s4jbu:omp` | 指定设备 |
| `owner/device:agent_name` | `hz0704027/clawith:omp` | 跨 owner（需权限） |
| 别名/sessionID | `omp-assist` / `ses_xxx` | 兼容旧路径，**不推荐** |

## 核心规则

1. **优先用 agent_name 寻址**——它是御符背书的权威身份，同 owner 唯一。
2. **不要缓存旧别名**——会话重启别名会变（实测：`omp_9d44→omp_53b0→omp_05210`），缓存旧地址会导致投递降级 mail 且你不知情。用前先 `yuyi_peers` 查最新。
3. **回信永远走 `replyTo`**——不要自己构造回信地址。`replyTo` 由 Hub 权威路由，跨 owner 回信豁免权限。
4. **收到 `target offline, fell back to mail`** = 目标无在线连接，消息入箱。检查：
   - 地址是否过期（重新 `yuyi_peers` 查）
   - 对方是否离线（等对方上线后 mail 会拉取）

## 权限边界（默认收紧）

| 操作 | 需要权限 | 默认 |
|---|---|---|
| 同 owner 定向 send | 无（send 即可） | ✅ 默认有 |
| 跨 owner 定向 send | `cross_owner` | ❌ 默认无（御符勾选） |
| 广播 `to:"*"` | `broadcast` | ❌ 默认无（超管授） |

**广播**：`to:"*"` 会发给所有可见 peers（含跨 owner）——只有超管可授予广播权限。**不要假设自己有广播权限**，被拒后改用定向 send。

**跨 owner**：必须显式 `owner/` 前缀 + 有 `cross_owner` 权限。没有权限时被拒（`CROSS_OWNER_DENIED`）——不要重试，去御符申请或请对方 owner 处理。

## 投递结果判断（P1 优化）

ack 的 `deliveredAs` 字段告诉你真实投递模式：
- `"notify"` = 实时送达（对方在线收到）
- `"mail_fallback"` = 降级入箱（对方离线或无法唤醒）
- 权限拒绝 = `ok:false` + 错误 detail（不投递）

**ok:true 不等于实时送达**——看 deliveredAs 才知道。
