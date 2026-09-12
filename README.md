# OpsPi — 基于 oh-my-pi 的运维智能体

基于 [oh-my-pi](https://github.com/can1357/oh-my-pi)（pi 血统 harness）扩展的运维智能体。
无人值守完成只读巡检、对指定服务执行重启，高危敏感操作须 Owner 明示批准，全过程留审计。

## 快速开始

### 前置条件

- [oh-my-pi](https://github.com/can1357/oh-my-pi) ≥ 18.1.18（`omp` CLI）
- 本项目安装后自动创建 `omo` CLI 包装器（详见下方安装步骤）
- Node.js ≥ 22 / Bun ≥ 1.4
- 可选：`docker` CLI、`kubectl` CLI（Docker/K8s 工具）

### 安装

```bash
git clone https://github.com/lomehong/oh-my-ops.git
cd oh-my-ops
npm install
bash scripts/install.sh        # 部署扩展 + 创建 omo CLI + 初始化策略
```

安装后 ops-pi 扩展自动集成到 omp（无需 `-e` 手动挂载）。

### 使用

```bash
# 非交互式巡检
omo --no-session --approval-mode write -p "巡检 web-01"

# 交互式会话（ops-pi 自动加载）
omo

# 后台服务模式（健康巡检轮询）
omo serve

# 共载 Yuyi 适配器（跨 Agent 通信）
omo -e ~/.omp/agent/extensions/yuyi-omp-extension.js
```

### 配置目标策略（Owner 编辑）

```bash
mkdir -p .ops-pi
cp docs/examples/policy.json.example .ops-pi/policy.json
# 编辑 .ops-pi/policy.json：添加允许的目标主机和服务
```

## 架构

```
omp 平台（审批 / 定时器 / spill / schema）
 └── L2 @ops-pi/extension（omp 扩展）
      ├── tools/  ops_* 工具（24 个）
      ├── guards  ①-b 兜底 + ② 内容硬拒
      ├── hooks   审计（tool_execution_end）
      └── L1 @ops-pi/core（纯 Node，不依赖 omp）
           ├── Shell / SshPool / Docker / K8s
           ├── Process / Log / File / Health / Vault
           └── targetPolicy（目标策略）+ OpsError
```

| 层 | 依赖 | 测试 |
|---|---|---|
| L1 `@ops-pi/core` | 纯 Node.js | `node --test`（可脱离 omp） |
| L2 `@ops-pi/extension` | omp 扩展 API + L1 | `bun test` + 运行时验收脚本 |

## 安全模型（三层分工）

| 层 | 机制 | 管什么 | 模式依赖 |
|---|---|---|---|
| ①-a 审批档 | 宿主 `approval`（函数式，按参数返档） | 要不要人点头 | `yolo` 可关闭 |
| ①-b 无人值守兜底 | `tool_call` 内 `!ctx.hasUI && !preauthorized → block` | 无人值守默认拒绝 | **不能关闭** |
| ② 内容硬拒 | `tool_call` 内纯同步正则 | 灾难性命令一律拒绝 | **不能关闭** |
| ③ 目标策略 | L1 `targetPolicy`（defaultDeny） | 允许对哪些主机/服务执行 | **不能关闭** |

**审批档位**（`--approval-mode` 控制）：

| 档位 | 工具 | 无人值守 |
|---|---|---|
| `read` | 巡检 / 列表 / 日志 / 健康检查 / vault_list | 自动放行 |
| `write` | file_write / ssh_upload / ssh_download / vault_store | 需 Owner 预授权 |
| `exec` | shell_exec / ssh_exec / process_kill / service(restart) / docker_exec / k8s_exec | 需 Owner 预授权 |

> ⚠️ **部署必须显式设 `--approval-mode write`（或 `always-ask`）**——omp 默认 `yolo` 会让 ①-a 失效。
> ①-b/②/③ 层不受此影响（模式无关），但 ①-a 的宿主审批功能依赖正确配置。

## Owner 预授权

无人值守时 `write`/`exec` 档默认失败。Owner 通过编辑以下文件表达批准：

| 文件 | 语义 | 示例 |
|---|---|---|
| `.ops-pi/policy.json` | 目标级：允许对 `web-01` 的 `nginx` 执行 `restart` | `{"targets":[{"host":"web-01","services":["nginx"],"actions":["restart"]}]}` |
| `.ops-pi/approval-token.json` | 单次/限时：高危敏感操作的**一次性**明示批准 | `{"tokens":[{"id":"T-1","scope":"web-01/nginx/restart","expiresAt":"…"}]}` |

**规则**：
- `policy.json` 缺失 → 变更类操作全拒（保守侧）
- `production: true` 的目标禁止无人值守变更（任何模式）
- 令牌 `expiresAt` 过期即失效

## 工具清单

| 档位 | 工具 |
|---|---|
| `read` | `ops_docker_ps` `ops_docker_logs` `ops_k8s_pods` `ops_k8s_logs` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_file_read` `ops_file_ls` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_compose(ps\|logs)` `ops_k8s_rollout(status)` `ops_service(status)` |
| `write` | `ops_file_write` `ops_ssh_upload` `ops_ssh_download` `ops_vault_store` |
| `exec` | `ops_shell_exec` `ops_shell_script` `ops_ssh_exec` `ops_docker_exec` `ops_k8s_exec` `ops_process_kill` `ops_docker_compose(up\|down\|restart)` `ops_k8s_rollout(restart\|undo)` `ops_service(start\|stop\|restart\|enable\|disable)` |

## 斜杠命令（只读）

| 命令 | 说明 |
|---|---|
| `/ops-inspect <host>` | 标准巡检（CPU/内存/磁盘/进程/日志） |
| `/ops-health` | 快速健康检查 |
| `/ops-status` | ops-pi 状态（策略/vault/沙箱） |

> 危险场景（deploy/kill/rollback）不注册命令——改由 LLM 经 `ops_*` 工具执行，受完整安全三层覆盖。

## 开发

```bash
npm test                    # 全量测试（L1 node:test + L2 bun:test）
npm run typecheck           # tsc strict 类型检查
npm run ledger:selftest     # 任务台账自检
npm run ledger:validate     # 台账结构校验

# 运行时验收（omp 真机）
bash packages/ops-extension/test/runtime/01-read-tier-probe.sh
bash packages/ops-extension/test/runtime/02-extension-load.sh
bash packages/ops-extension/test/runtime/03-collision-assert.sh
bash packages/ops-extension/test/runtime/04-security-acceptance.sh
bash packages/ops-extension/test/runtime/06-docker-k8s-acceptance.sh
```

## 目录结构

```
packages/ops-core/            L1（纯 Node.js，不依赖 omp）
  src/
    errors.ts                 OpsError 统一错误
    exec.ts                   ShellExec（execFile + 参数数组）
    files.ts                  FileOps（read）
    process.ts                ProcessManager（ps 解析）
    log.ts                    LogCollector（tail/journalctl/grep）
    content-guard.ts          ② 灾难性命令硬拒（纯同步正则）
    policy.ts                 ③ 目标策略（defaultDeny）
    tokens.ts                 P3 批准令牌（只读校验）
    approvals.ts              档位判定 + 纯函数授权
    index.ts
  test/                       node:test 套件

packages/ops-extension/       L2（omp 扩展）
  src/
    extension.ts              入口
    platform.ts               §7.2 平台能力前置校验
    context.ts                OpsContext（L1 装配 + authzView）
    approvals.ts              registerOpsTool + TIER_TABLE
    guards.ts                 ①-b 兜底 + ② 内容硬拒 + ③ 权威复核
    content-guard.ts          ② re-export
    hooks.ts                  session_start / tool_call / tool_execution_end
    commands.ts               斜杠命令（只读）+ 场景提示词
    setup.ts                  配置加载
    tools/
      shell.ts                ops_shell_exec / ops_shell_script
      process.ts              ops_process_list / ops_process_kill
      read-only.ts            ops_file_read / ops_file_ls / ops_health_* / ops_vault_list
      log.ts                  ops_log_tail / ops_log_journalctl / ops_log_grep
      service.ts              ops_service
      docker-k8s.ts           ops_docker_* / ops_k8s_*
  test/
    guards.test.ts            安全四分支单元测试
    platform.test.ts          平台探针测试
    runtime/                  omp 真机验收脚本
      01-read-tier-probe.sh
      02-extension-load.sh
      03-collision-assert.sh
      04-security-acceptance.sh
      06-docker-k8s-acceptance.sh
      stubs-yuyi.ts           Yuyi 适配器模拟

docs/
  designs/                    可执行技术方案（v4.3 已落定）
  requirements/               结构化需求包
  reports/                    评审/复评/复审/决策简报 + 宿主能力矩阵 + 探针
  examples/                   policy.json 模板
  tasks/                      任务台账（OPSP-P0…P5）

types/vendor-platform.d.ts    依赖面自持声明（omp 扩展契约最小子集）
scripts/task-ledger.mjs       任务面机制（五操作 + 四态状态机 + 四不变量）
```

## 安全边界

| 层 | 防什么 | 怎么工作 |
|---|---|---|
| **沙箱**（§7.1） | 容器/进程/网络/凭据访问 | 容器 + 挂载/网络策略；生产 docker.sock 不挂载 |
| **宿主审批**（O2/O3） | 「要不要人点头」 | `approval` 档位 + `approvalMode` + `tool_approval_*` 事件 |
| **①-b 无人值守兜底** | 无人值守默认拒绝 | `tool_call` 内 `!hasUI && !preauthorized → block` |
| **② 内容硬拒** | 灾难性命令 | `tool_call` 内纯同步正则（`rm -rf /`、`sudo rm`、`curl\|bash` 等） |
| **③ 目标策略** | 打错机器 / 越权服务 | L1 `targetPolicy` defaultDeny |
| **③ execute 复核** | 入参篡改（共载扩展） | execute 首行独立重算全部校验维度 |

## 文档

| 文档 | 内容 |
|---|---|
| [需求包](docs/requirements/ops-pi-requirement-package.md) | 可验收目标 A0–A6、范围、不做项、假设、阻断项 |
| [设计方案](docs/designs/ops-pi-architecture-design.md) | 可执行技术方案 v4.3（六维度 + 五问，已落定） |
| [宿主能力矩阵](docs/reports/pi-vs-omp-host-capability-matrix.md) | 上游 pi 0.84.1 ⨯ omp 18.1.18 逐条对照 |
| [评审报告](docs/reports/ops-pi-review-v4-2026-09-12.md) | architect-review 结论 + 勘误 |
| [独立复评①](docs/reports/independent-recheck-2026-09-12.md) | 三项绕过路径 + 拒绝路径审计覆盖 |
| [独立复审②](docs/reports/independent-recheck-2-2026-09-12.md) | N-1 升级 / N-2 修正 / N-3 加重 / N-4 有解 |

## 许可

MIT
