# OpsPi — 基于 oh-my-pi 的运维智能体

基于 [oh-my-pi](https://github.com/can1357/oh-my-pi) 扩展的运维智能体。
无人值守完成只读巡检、对指定服务执行重启，高危敏感操作须 Owner 明示批准，全过程留审计。

## 快速开始

### 前置条件

- [oh-my-pi](https://github.com/can1357/oh-my-pi) ≥ 18.1.18
- Node.js ≥ 22
- Yuyi Agent Token（从御符平台获取，用于跨 Agent 通信）

### 安装

```bash
git clone https://github.com/lomehong/oh-my-ops.git
cd oh-my-ops
npm install
bash scripts/install.sh
```

安装脚本会交互式提示输入 **Yuyi Agent Token**，然后自动完成：

1. 部署 ops-pi 扩展到 omp profile `ops`（身份隔离，不读全局 AGENTS.md）
2. 部署 Yuyi 适配器（跨 Agent 通信）
3. 创建 `omo` CLI（自动带 `--profile ops --extension` + `OMO_APP_NAME=OpsPi`）
4. 初始化策略目录（缺省：变更类操作全拒）
5. 写入 Yuyi 通讯配置（`~/.yuyi/agent.json` + `~/.yuyi/env`）
6. omp 品牌补丁（可选）：让 TUI 横幅/进程名/UA 显示 OpsPi——需要写 omp 安装目录，若提示 EACCES 手动执行一次 `sudo node scripts/patch-omp-brand.mjs` 即可；不打补丁不影响功能，只是界面仍显示 omp

安装完成后 `omo` 命令即可使用，**无需任何 `-e` 挂载参数**。

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

前提：`~/.ops-pi/policy.json` 中已配置该主机 + 服务。

```bash
omo --no-session --approval-mode write \
  -p "重启 web-01 上的 nginx 服务，确认服务已恢复"
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

路径：`~/.ops-pi/policy.json`

控制「允许对哪些主机/服务执行什么操作」。**缺省全拒**。

```json
{
  "targets": [
    {
      "host": "web-01",
      "services": ["nginx"],
      "actions": ["restart", "status"]
    },
    {
      "host": "staging-01",
      "services": ["app"],
      "actions": ["restart"],
      "expiresAt": "2027-06-30T00:00:00Z"
    }
  ]
}
```

### 批准令牌（approval-token.json）

路径：`~/.ops-pi/approval-token.json`

高危敏感操作的**单次/限时**明示批准。

```json
{
  "tokens": [
    {
      "id": "T-1",
      "scope": "prod-db/postgres/restart",
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
| `policy.json` | `~/.ops-pi/policy.json` | 强烈建议 |
| `approval-token.json` | `~/.ops-pi/approval-token.json` | 生产变更需要 |
| 沙箱 | 容器/网络策略 | 建议 |

## 工具清单

| 档位 | 工具 | 说明 |
|---|---|---|
| **read**（自动放行） | `ops_docker_ps` `ops_docker_logs` `ops_k8s_pods` `ops_k8s_logs` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_file_read` `ops_file_ls` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_compose(ps\|logs)` `ops_k8s_rollout(status)` `ops_service(status)` | 只读诊断 |
| **write**（需批准） | `ops_file_write` `ops_ssh_upload` `ops_ssh_download` `ops_vault_store` | 落盘/传输/凭据 |
| **exec**（需批准） | `ops_shell_exec` `ops_shell_script` `ops_ssh_exec` `ops_docker_exec` `ops_k8s_exec` `ops_process_kill` `ops_docker_compose(up\|down\|restart)` `ops_k8s_rollout(restart\|undo)` `ops_service(start\|stop\|restart\|enable\|disable)` | 变更/执行 |

## 斜杠命令（只读）

| 命令 | 说明 |
|---|---|
| `/ops-inspect <host>` | 标准巡检 |
| `/ops-health` | 快速健康检查 |
| `/ops-status` | ops-pi 运行状态 |

## 安全模型

| 层 | 防什么 | 怎么工作 | 可否被 yolo 关闭 |
|---|---|---|---|
| **沙箱** | 容器/网络/凭据 | 容器 + 挂载/网络策略 | — |
| **宿主审批** | 「要不要人点头」 | `approval` 档位 + `approvalMode` | yolo 可关 |
| **①-b 无人值守兜底** | 无人值守默认拒绝 | `tool_call` 内 `!hasUI && !preauth → block` | 不可关 |
| **② 内容硬拒** | 灾难性命令 | 纯同步正则（`rm -rf /`、`sudo rm`、`curl\|bash` 等） | 不可关 |
| **③ 目标策略** | 打错机器/越权服务 | L1 `targetPolicy` defaultDeny | 不可关 |
| **execute 复核** | 入参篡改 | execute 首行独立重算全部维度 | 不可关 |

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
