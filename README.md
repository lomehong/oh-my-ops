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

受限网络（`github.com` 的 **git 协议/repo 页不可达**、但 jsdelivr/codeload/发布资产可达时）：

```bash
# 方式一（推荐）：官方入口经 jsdelivr 取 bootstrap（内部再取 release 资产；资产走 objects.githubusercontent.com）
for u in "https://cdn.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/bootstrap.sh" \
         "https://fastly.jsdelivr.net/gh/lomehong/oh-my-ops@main/scripts/bootstrap.sh"; do curl -fsSL --retry 3 --connect-timeout 8 "$u" -o /tmp/omo-install.sh && break; done; bash /tmp/omo-install.sh

# 方式二：codeload 取源码包（无需 git），复用本机已有运行时（无 471MB 下载）
curl -fsSL -o /tmp/omo.tar.gz "https://codeload.github.com/lomehong/oh-my-ops/tar.gz/refs/heads/main"
mkdir -p /tmp/omo-src && tar xzf /tmp/omo.tar.gz -C /tmp/omo-src --strip-components=1
cp "$HOME/.omo/runtime/omp-single" /tmp/omo-src/omp-single   # 仅当本机已装过 omo（同版本 18.1.18）
HOME="$HOME" bash /tmp/omo-src/scripts/install.sh --token-file ~/.yuyi/token   # 令牌走 0600 文件，勿用 --token
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

首次使用需先配置模型：TUI 内 `/login`，或设置 API key 环境变量（如 `DEEPSEEK_API_KEY`）后用 `/model` 选择。
模型凭据存于 `~/.omo/home`（随 HOME 隔离）——**非卸载的重装/升级会保留**；`--uninstall` 会连同策略/vault/会话一并删除。

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

前提：`policy.json` 中已用 `@local` 规则预授权该服务（路径见下「策略」节；omo 自包含部署下为 `~/.omo/policy.json`）。

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

### 策略可见性（编辑 policy.json 后先跑）

```bash
omo policy lint                                              # 静态检查：错别字字段、过期/不可解析时间、死规则、全权/shell 规则提示
omo policy explain ops_service service=nginx action=restart  # 授权 dry-run：档位、策略请求、结论、逐条规则/令牌命中轨迹
omo policy explain ops_shell_exec host=web-01 command="systemctl status nginx"
```

`lint` 把运行时**静默降级**的情形显式报出（解析失败→全拒、`expiresAt` 写错→规则永久失效、`action` 写成单数→全动作通配、`production:"true"` 字符串→变成放行规则）；退出码：有错误 = 1。
`explain` 与 ①-a/①-b/③ 三层共用同一 `policyRequestFor` + `evaluateAuthorization`，看到的就是运行时会做的判定；不消费令牌、不执行工具；退出码：拒绝 = 2。会话内等价命令：`/ops-policy lint`、`/ops-policy explain …`。

### 跨 Agent 通信

共载 Yuyi 适配器后，LLM 可直接调用 `yuyi_send`、`yuyi_peers` 等工具与其他 Agent 通信。

```bash
omo -p "用 yuyi_peers 查看当前在线的 Agent 列表"
```

### 知识库同步（KB）

实例把 Runbook / 处置案例沉淀到本地 `~/.omo/knowledge/`，并通过 git 与中心知识库（Gitea/GitLab 任一 HTTPS 远端）同步；
**只推 `instance/<设备名>` 分支，主线由中心 PR 合流**——实例永不直推主线。

```bash
omo kb status      # 远端/主线/凭据（前缀+已用天数）/最后同步结果/轮换建议
omo kb sync        # 拉主线；--push 时提交并推本实例分支
omo kb enroll --server <服务地址> --code-file <0600 码>   # 向自注册服务兑换凭据（一次性码，服务侧建号+授权+自证）
omo kb disable     # 停用远端同步（删除凭据；本地知识库保留）
```

- **凭据模型**：每实例一个 bot 账号 + 随机密码。凭据落 `$OMO_DIR/kb/credential.json`（0600），git 凭据落
  `$OMO_DIR/home/.git-credentials`（0600，`store` 格式）；两者均在 **PathGuard 机密根**内（Agent 经 `ops_file_*` 读不到），
  并写入 `.git/info/exclude` **永不入库**。凭据文件存在但不可用时**大声失败**（不静默降级为本地模式）。
- **生命周期**：签发 / 轮换 / 吊销全部走 API。Owner 侧用 `scripts/ops-kb-provision.mjs`
  （`create | rotate | revoke | grant | list | code`），或常驻 `scripts/ops-kb-enroll-server.mjs`
  （一次性码授权、**TLS 默认强制**、哈希链审计、发放前自证）；实例侧只认 `omo kb enroll`。
  轮换后旧凭据**即时失效**，实例下次 `sync` 自动换用新凭据。
- **智能体侧工具**：`ops_kb_list` / `ops_kb_search` / `ops_kb_status`（read 档）、`ops_kb_save` / `ops_kb_sync`
  （write 档，需 policy 规则 `actions` 显式含 `kb-write` / `kb-sync`）。
- 设计（含 v1.27.3 实测事实与 as-built）见 [知识库同步与凭据分发设计](docs/designs/omo-kb-sync-credential-design.md)，
  落地过程见 [执行记录](docs/designs/omo-kb-sync-执行记录.md)。

## Owner 配置

### 目标策略（policy.json）

路径（优先级：`.ops-pi/config.json` 显式值 > 环境变量 > 缺省）：缺省 `<工作目录>/.ops-pi/policy.json`；
omo 自包含安装器部署下由启动器注入 `OMO_POLICY_PATH=~/.omo/policy.json`（私有域，不随启动目录漂移）。

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
- **write 档须显式授权**：`ops_file_write` 要求规则 `actions` 含 `file-write`，`ops_vault_store` 含 `vault-write`，`ops_vault_rekey` 含 `vault-rekey`，`ops_kb_save` 含 `kb-write`，`ops_kb_sync` 含 `kb-sync`（shell/services 规则不连带放行任何写档工具；未登记显式 action 的非 read 工具在 `policyRequestFor` 直接 fail-fast）。
- `production: true` 只做生产标记：本身不授予放行，无人值守变更被 `guard-production` 拒，放行只能凭批准令牌。

> **⚠ 权限等级须知**：`@local` + `actions:["shell"]` 在语义上等价于**授予 omo 进程用户的全部权限**——第②层内容硬拒是对灾难性命令的绊线，不是边界（`find -delete`、`python -c`、重定向覆盖等均不在其覆盖内）。无人值守场景请优先用 service/docker/k8s 的动作级授权或批准令牌，把 `shell` 留给交互模式。
>
> **路径守卫（不受 policy 授权影响，仅本机）**：
> - **机密根拒读拒写**：`$HOME/.omp`（模型凭据/会话）、`$HOME/.ssh`、vault 密文、`approval-token.json`、`~/.omo/home`——`ops_file_read`/`ops_file_ls`/`ops_log_tail`/`ops_log_grep` 一律拒绝（`grep -r` 范围覆盖机密根亦拒）。
> - **信任根拒写**：`policy.json`、`.ops-pi/config.json`、审计文件、整个 `~/.omo` 私有域——拿到 `file-write` 授权的 Agent 也不能改写自身授权。
> - 远程主机文件系统不套本机守卫，由该 host 的策略规则负责。

### 批准令牌（approval-token.json）

路径：同上规则；缺省 `<工作目录>/.ops-pi/approval-token.json`，omo 部署下 `OMO_TOKEN_PATH=~/.omo/approval-token.json`。

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
| `policy.json` | `~/.omo/policy.json`（自包含部署）；缺省 `<工作目录>/.ops-pi/policy.json` | 强烈建议 |
| `approval-token.json` | `~/.omo/approval-token.json`（自包含部署）；缺省同工作目录规则 | 生产变更需要 |
| 沙箱 | 容器/网络策略 | 建议 |

## 工具清单

与 `TIER_TABLE`（`packages/ops-extension/src/approvals.ts`）一致——该表同时生成系统提示词与启动期清单断言，提示词宣告与实际注册零漂移。

| 档位 | 工具 | 说明 |
|---|---|---|
| **read**（自动放行） | `ops_file_read` `ops_file_ls` `ops_process_list` `ops_log_tail` `ops_log_journalctl` `ops_log_grep` `ops_health_check` `ops_health_poll` `ops_vault_list` `ops_docker_ps` `ops_docker_logs` `ops_docker_compose(ps\|logs)` `ops_k8s_pods` `ops_k8s_logs` `ops_k8s_rollout(status)` `ops_service(status)` | 只读诊断 |
| **write**（需批准） | `ops_file_write`（policy action=`file-write`，支持远程） `ops_vault_store`（`vault-write`） `ops_vault_rekey`（`vault-rekey`，P14 口令轮换） `ops_kb_save`（`kb-write`） `ops_kb_sync`（`kb-sync`） | 文件写入/凭据管理/知识库 |
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
| `/ops-audit [n] [file]` | 回看最近 n 条 `ops_audit` 审计条目（只读；留空=20，上限 200，超限提示截断）。缺省读当前会话分支；加 `file` 读独立审计文件（跨会话） |
| `/ops-policy [lint]` | 静态检查 `policy.json` 与 `approval-token.json`（只读；与 `omo policy lint` 同源） |
| `/ops-policy explain <ops_工具> [k=v …]` | 授权 dry-run：档位、策略请求、结论、逐条规则/令牌轨迹（只读，不消费令牌） |

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
| **路径守卫** | 读机密 / 改写自身信任根 | `PathGuard`：机密根拒读拒写、信任根拒写（realpath 归一，防符号链接绕行；仅本机） | 不可关 |
| **注册表自愈** | 共载扩展覆盖 ops_*（last-wins 劫持） | session_start 检测 sourceInfo，重注册自愈，失败拒启 | 不可关 |

每次 ops_* 调用（含被拒调用）在 `tool_execution_end` **双写**审计：会话条目 `ops_audit`（供 `/ops-audit` 回看当前分支）+ 独立 append-only 文件（缺省 `<policy 同级>/audit/ops-audit.jsonl`，omo 部署下为 `~/.omo/audit/ops-audit.jsonl`；可用 `auditPath`/`OMO_AUDIT_PATH` 覆盖）。`authz` 记录授权来源（`read`/`policy`/`token`/`blocked`）。
独立文件带 sha256 哈希链（`seq`/`prev`/`hash`），`/ops-status` 会校验链完整性并报告断链行号；`--no-session` 下宿主会话为内存态、退出即丢，独立文件是无人值守运行的唯一持久审计。

## 开发

```bash
npm test                    # L1（node --test）+ L2（bun test 指定文件），与 CI 同源
npm run test:l1             # 仅 L1：packages/ops-core/test/*.test.ts —— 必须用 node:test 编写
npm run test:l2             # 仅 L2：guards / platform / audit-view（bun test）
npm run test:all            # 全量 bun test（含 Windows 上已知的平台性失败）
npm run test:ci             # = test:l1 + test:l2 + typecheck:core，即 release.yml 测试 job
npm run typecheck           # tsc strict（core + extension）
npm run ledger:selftest     # 任务台账自检
npm run hooks:install       # 启用 .githooks/pre-push：推送前本地跑 test:ci（OMO_SKIP_HOOKS=1 可跳过）

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
| [设计方案](docs/designs/ops-pi-architecture-design.md) | 可执行技术方案 v4.3（已落定）+ v4.4 实现期补录（§7.4.6 路径守卫/独立审计） |
| [宿主能力矩阵](docs/reports/pi-vs-omp-host-capability-matrix.md) | 上游 pi ⨯ omp 逐条对照 |
| [评审报告](docs/reports/ops-pi-review-v4-2026-09-12.md) | architect-review + 勘误 |
| [独立复审①](docs/reports/independent-recheck-2026-09-12.md) | 三项绕过路径 + 审计覆盖 |
| [独立复审②](docs/reports/independent-recheck-2-2026-09-12.md) | N-1 升级 / N-4 有解 |
| [知识库同步与凭据分发设计](docs/designs/omo-kb-sync-credential-design.md) | P1/P2/P3 方案 + Gitea 1.27.3 实测事实 + as-built（§5.2″/§5.6′） |
| [知识库同步执行记录](docs/designs/omo-kb-sync-执行记录.md) | 五轮落地与真机验收证据（含 8 个真机暴露缺陷的修复） |

## 许可

MIT
