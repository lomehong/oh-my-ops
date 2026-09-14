# omo — 基于 oh-my-pi 的运维智能体

基于 [oh-my-pi](https://github.com/can1357/oh-my-pi) 扩展的运维智能体。
无人值守完成只读巡检、对指定服务执行重启，高危敏感操作须 Owner 明示批准，全过程留审计。

## 快速开始

### 前置条件

- [oh-my-pi](https://github.com/can1357/oh-my-pi) ≥ 18.1.18（含 Bun 运行时）
- Node.js ≥ 22
- Yuyi Agent Token（可选，用于跨 Agent 通信；没有也能用全部单机运维功能）

### 安装（自包含：零前置，与原生 omp 零接触）

一行命令（bootstrap 自动多通道回退；进入包内 install.sh 后 bun 自动装到 `~/.omo/bin`、omp 单文件运行时随包携带）：

```bash
for u in "https://cdn.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/bootstrap.sh" "https://fastly.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/bootstrap.sh" "https://raw.githubusercontent.com/lomehong/oh-my-ops/main/scripts/bootstrap.sh"; do curl -fsSL --retry 3 --connect-timeout 8 "$u" -o /tmp/omo-install.sh && break; done; bash /tmp/omo-install.sh
```

GitHub 访问稳定时也可用短版：

```bash
curl -fsSL https://github.com/lomehong/oh-my-ops/releases/latest/download/install.sh | bash
```

指定版本 / 传参：

```bash
OMO_VERSION=v0.7.0 bash /tmp/omo-install.sh --token <yuyi-token>
```

开发者从源码安装：

```bash
git clone https://github.com/lomehong/oh-my-ops.git && cd oh-my-ops
bash scripts/build-omp-runtime.sh   # 构建 omp-single（需 bun；上游包 sha256 pin）
bash scripts/install.sh
```

安装脚本自动完成：

1. 安装私有 bun 到 `~/.omo/bin/`（锁 1.4.x；官方脚本直连 → npmmirror 镜像回退；已装同版本则跳过）
2. 布置预编译 omp 单文件运行时到 `~/.omo/runtime/`（品牌内置；构建自 pin 的 oh-my-pi 18.1.18）
3. 部署 ops-pi 扩展 + Yuyi 适配器到 `~/.omo/extensions/`
4. 创建 `omo` CLI（启动器将 HOME 重定向到 `~/.omo/home`——状态/策略/凭据/会话全部私有，**与原生 omp 及 `~/.omp` 零接触**）
5. 初始化策略（缺省：变更类操作全拒）+ Yuyi 通讯配置（沿用已有 token/设备名）

无需预装 oh-my-pi/node/bun。安装后 `omo` 即完整形态；裸 `omp` 命令完全不受影响。
升级：重跑安装器（状态保留）；`omo update` / `omo upgrade` 拉最新 Release 安装器（安全通道——版本经 pin 锁定，**不触发上游 omp 自更新**）。
卸载：`bash scripts/install.sh --uninstall`（⚠ 删除 `~/.omo`，含策略/凭据/会话数据）。

开发者从源码安装：

```bash
git clone https://github.com/lomehong/oh-my-ops.git && cd oh-my-ops
bash scripts/build-omp-runtime.sh   # 构建 omp-single（需 bun；上游包 sha256 pin）
bash scripts/install.sh
```

## 日常使用

### 无人值守巡检（只读，自动放行）

```bash
omo --no-session --approval-mode write -p "巡检本机"
```

### 交互式会话

```bash
omo
```

### 对指定服务执行重启

前提：`.ops-pi/policy.json` 中已用 `@local` 规则预授权该服务（当前仅本机；远程 P1 经 SshPool 引入）。

```bash
omo --no-session --approval-mode write \
  -p "重启本机 nginx 服务，确认服务已恢复"
```

### 后台服务模式（健康巡检轮询）

```bash
omo serve              # 后台启动
omo serve --foreground # 前台启动
omo status             # 查看运行状态
```

### 跨 Agent 通信

共载 Yuyi 适配器后，LLM 可直接调用 `yuyi_send`、`yuyi_peers` 等工具与其他 Agent 通信。

```bash
omo -p "用 yuyi_peers 查看当前在线的 Agent 列表"
```

## Owner 配置

### 目标策略（policy.json）

路径：`<工作目录>/.ops-pi/policy.json`（默认；可在 `.ops-pi/config.json` 用 `policyPath`/`tokenPath` 重定向）。

控制「允许对哪些主机/服务执行什么操作」。**缺省全拒**；`host` 填 `@local` 表示本机，远程主机填真实 hostname（P7 起经 SshPool 远程执行，须 SSH 密钥可达且本规则显式授权；`@@` 非法 hostname 字符，无伪造冲突）。文件保存后热加载，下次判定即生效。

```json
{
  "targets": [
    {
      "host": "@local",
      "services": ["nginx"],
      "actions": ["restart", "status"]
    },
    {
      "host": "@local",
      "actions": ["shell"],
      "expiresAt": "2027-06-30T00:00:00Z"
    },
    {
      "host": "@local",
      "actions": ["file-write"]
    }
  ]
}
```

- `actions: ["shell"]` 授权本机命令执行（`ops_shell_exec`/`ops_shell_script`）；service 维度工具按 `start/stop/restart/status/…` 匹配。
- **write 档须显式授权**：`ops_file_write` 要求规则 `actions` 含 `file-write`，`ops_vault_store` 要求含 `vault-write`（P11 起 shell/services 规则不再连带放行写档工具）。
- `production: true` 只做生产标记：本身不授予放行，无人值守变更被 `guard-production` 拒，放行只能凭批准令牌。

### 批准令牌（approval-token.json）

路径：`<工作目录>/.ops-pi/approval-token.json`（默认同上可重定向）。

高危敏感操作的**单次/限时**明示批准。`scope` 逐段前缀匹配（`@local` ⊂ 本机全部；`@local/postgres` ⊂ 该服务任意动作；`@local/postgres/restart` 精确到动作）。令牌在 execute 复核通过后消费，`consumedAt` 写回文件，跨会话不可重放。

```json
{
  "tokens": [
    {
      "id": "T-1",
      "scope": "@local/postgres/restart",
      "issuedBy": "主人",
      "issuedAt": "2026-09-12T00:00:00Z",
      "expiresAt": "2026-09-13T00:00:00Z"
    }
  ]
}
```

> **⚠ 非强认证**：令牌安全性依赖文件权限（600）与沙箱隔离，不替代系统认证。

### 部署检查清单

| 配置项 | 位置 | 必要性 |
|---|---|---|
| `approvalMode` | omp 设置（**禁止 yolo**） | 必须 |
| `policy.json` | `.ops-pi/policy.json`（工作目录） | 强烈建议 |
| `approval-token.json` | `.ops-pi/approval-token.json`（工作目录） | 生产变更需要 |
| 沙箱 | 容器/网络策略 | 建议 |

## 工具清单

与 `TIER_TABLE`（`packages/ops-extension/src/approvals.ts`）一致——该表同时生成系统提示词与启动期清单断言，提示词宣告与实际注册零漂移。

| 档位 | 工具 | 说明 |
|---|---|---|
| **read**（自动放行） | `ops_file_read` `ops_file_ls` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_ps` `ops_docker_logs` `ops_docker_compose(ps\|logs)` `ops_k8s_pods` `ops_k8s_logs` `ops_k8s_rollout(status)` `ops_service(status)` | 只读诊断 |
| **write**（需批准） | `ops_file_write`（policy action=`file-write`，支持远程） `ops_vault_store`（`vault-write`） `ops_vault_rekey`（`vault-rekey`，P14 口令轮换） | 文件写入/凭据管理 |
| **exec**（需批准） | `ops_shell_exec` `ops_shell_script` `ops_docker_exec` `ops_docker_compose(除 ps\|logs)` `ops_k8s_exec` `ops_k8s_rollout(除 status)` `ops_service(start\|stop\|restart\|enable\|disable)` | 变更/执行 |

> write 档的 policy action 粒度见上表括注——P11 起须显式授权对应 action，shell/services 规则不连带放行。新工具于实现时加入 `TIER_TABLE`（提示词随之更新，不会提前宣告）。

### vault 凭据（加密存储）

- 口令仅来自环境变量 `OPS_VAULT_PASSPHRASE`（session_start 自动解锁）；落盘为 AES-256-GCM 密文（0600，tmp+rename 原子写）。
- **备份策略**：锁态下整文件拷贝 vault db 即备份（纯密文，可随普通备份流转）；恢复 = 放回原路径 + 原口令解锁。
- **口令轮换**：`ops_vault_rekey`（write 档，须 policy 授权 `vault-rekey` 或批准令牌）——新盐重派生密钥原子落盘，旧口令随即失效；轮换后记得更新 `OPS_VAULT_PASSPHRASE` 并重做备份。

## 斜杠命令（只读）

| 命令 | 说明 |
|---|---|
| `/ops-inspect [host]` | 标准巡检（留空/`@local` = 本机；远程主机经 SshPool 只读探针，非法主机名诚实化拒绝） |
| `/ops-health` | 快速健康检查 |
| `/ops-status` | ops-pi 运行状态 |
| `/ops-audit [n]` | 回看当前会话分支最近 n 条 `ops_audit` 审计条目（只读；留空=20，上限 200，超限提示截断） |

## 安全模型

授权判定走 core 的 `evaluateAuthorization` 单一事实源，审批层（①-a）/ 兜底层（①-b）/ execute 复核（③）三层共用同一顺序：**令牌 → policy 预授权 → 生产拒绝 → 其余拒绝**；工具入参经 `policyRequestFor` 统一映射（`host=@local`），三层看到的请求逐字段一致。

| 层 | 防什么 | 怎么工作 | 可否被 yolo 关闭 |
|---|---|---|---|
| **沙箱** | 容器/网络/凭据 | 容器 + 挂载/网络策略 | — |
| **①-a 宿主审批** | 「要不要人点头」 | `approval` 工厂：预授权 → `allow`；生产 → `deny`；其余按档位交平台 | yolo 可关（预授权/生产判定不受影响） |
| **①-b 无人值守兜底** | 无人值守默认拒绝 | `tool_call` 内 `!hasUI && exec档 && 无令牌/预授权 → block` | 不可关 |
| **② 内容硬拒** | 灾难性命令 | 纯同步正则（`rm -rf /`、`sudo rm`、`curl\|bash` 等） | 不可关 |
| **③ 目标策略** | 越权目标/服务 | `targetPolicy` defaultDeny（`@local` 维度，mtime 热加载） | 不可关 |
| **execute 复核** | 入参篡改 | execute 首行独立重算（X19），通过后才消费令牌（单次批准） | 不可关 |
| **注册表自愈** | 共载扩展覆盖 ops_*（last-wins 劫持） | session_start 检测 sourceInfo，重注册自愈，失败拒启 | 不可关 |

每次 ops_* 调用（含被拒调用）在 `tool_execution_end` 落 `ops_audit` 审计条目，`authz` 记录授权来源（`read`/`policy`/`token`/`blocked`）。

## 开发

```bash
npm test                    # L1 测试（node:test）
bun test packages/ops-extension/test/guards.test.ts \
                        packages/ops-extension/test/platform.test.ts  # L2 测试
npm run typecheck           # tsc strict
npm run ledger:selftest     # 任务台账自检

# 运行时验收（omp 真机）
bash packages/ops-extension/test/runtime/01-read-tier-probe.sh
bash packages/ops-extension/test/runtime/02-extension-load.sh
bash packages/ops-extension/test/runtime/03-collision-assert.sh
bash packages/ops-extension/test/runtime/04-security-acceptance.sh
bash packages/ops-extension/test/runtime/06-docker-k8s-acceptance.sh
```

## 文档

| 文档 | 内容 |
|---|---|
| [需求包](docs/requirements/ops-pi-requirement-package.md) | 可验收目标 A0–A6、范围、不做项 |
| [设计方案](docs/designs/ops-pi-architecture-design.md) | 可执行技术方案 v4.3（已落定） |
| [宿主能力矩阵](docs/reports/pi-vs-omp-host-capability-matrix.md) | 上游 pi ⨯ omp 逐条对照 |
| [评审报告](docs/reports/ops-pi-review-v4-2026-09-12.md) | architect-review + 勘误 |
| [独立复审①](docs/reports/independent-recheck-2026-09-12.md) | 三项绕过路径 + 审计覆盖 |
| [独立复审②](docs/reports/independent-recheck-2-2026-09-12.md) | N-1 升级 / N-4 有解 |

## 许可

MIT
