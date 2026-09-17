# omo 知识库同步与凭据分发设计（ops-kb）

> 来源需求：主人 2026-09-17 会话——内部 git 仓 `https://twin.hzins.com/git/hzins-ops/ops-kb` 已创建，用于 omo 实例间同步共享知识库；需**自动化**为每个 omo 实例分配可用账号/令牌，用于拉取与同步。
> 状态：**待主人拍板**（本文件为设计产出，未进入编码）
> 对齐主干：本文件落于他会话提交 `209a00f`（vendor/yuyi-skills + 部署）、`313ec07`/`8f20f03`（launcher/install 修复）之后；Reuse 项已按最新主干复核（`install.sh` 仍未处理 git 凭据 ✅ 假设成立）

## 一、需求覆盖

**Do**
1. 每个 omo 实例获得**独立**凭据（可单独吊销），用于读写 `hzins-ops/ops-kb`。
2. **自动化发放**：Owner 只做「授权一次」，不需要逐台进 Git 后台建 token。
3. 实例侧**非交互**拉取与同步；离线优先、失败不阻断本地可用性。
4. 安全边界：凭据不入知识库、不入日志、**Agent 不可读**（PathGuard 机密根）。
5. 可审计与生命周期：注册表记录「哪台实例持有哪些凭据」、最后使用时间；支持吊销与轮换。
6. 兼容老平台：对端控制节点为 el7（**git 1.8.3.1**）、网络按主机放行、无 Docker 插件机制。

**Don't**
- **不经御驿（yuyi）通道传递任何 git 凭据**（沿用「sign_secret 禁经御驿」纪律）。
- 不允许实例直接推 `main`（保留知识库的「待审核」评审门）。
- 不改动 dsh-architect / 大脑仓（本设计只落 omo 侧与 Git 服务器侧）。

**To Confirm**：服务器产品与版本；账号模型；写入模型；Git 管理凭据归属与部署位置；TTL/轮换策略。

## 二、系统覆盖

| 面 | 落点 | 现状 |
|---|---|---|
| 实例侧 KB 读写/检索 | `packages/ops-extension/src/knowledge.ts`（KnowledgeStore）+ `tools/knowledge.ts`（`ops_kb_list/search/save/sync`） | **已存在**（Reuse） |
| 实例侧 git 同步 | `tools/knowledge.ts::gitSync()` | **已存在但三处不兼容老 git**（Extend，见 §三） |
| 实例侧凭据存储 | 新 `$OMO_DIR/kb/credential.json`（0600）+ PathGuard secret 增补 | 需新建（Extend 现有 600 文件模式） |
| 实例侧调度 | `omo serve` 常驻 + `omo kb sync` | 需扩展 |
| 服务器侧发放/注册表/轮换 | 新组件（建议随 `ops-kb` 仓内 `ops/` 目录或独立小服务） | **仓库内不存在**（Build） |
| 审计 | `ops-audit.jsonl`（现有哈希链审计）+ GitLab deploy token last-used | Extend |

**依赖**：实例侧 `git`、HTTPS（443）、可选 SSH（22）；服务器侧 GitLab API + 管理凭据。
**缺席降级**：无凭据 / 发放服务不可达 → 保持本地知识库（现有离线优先语义），只读巡检不受影响。

## 三、证据覆盖（四层装载）

- **业务层**：共享知识库目标 = 跨实例复用 Runbook/处置案例；现状 KB 为**本地目录**（默认 `$OMO_DIR/knowledge`，由 `dirname(policyPath)/knowledge` 推出）。
- **架构层**：omo = omp 宿主外壳；`config.knowledge{dir, repo, branch}` 配置项**已存在**（`setup.ts` 校验、`context.ts` 注入 `kbRepo/kbBranch`）。
- **系统层（以代码为准）**：
  - `gitSync()` 现有行为：`git -C <dir> init -b <branch>` → `remote add` → `fetch` → `pull --rebase --autostash` → `add/commit`（身份兜底 `omo-agent@local`）→ `push -u origin <branch>`；全程 best-effort。
  - **兼容性事实**（对端 git 1.8.3.1）：`git -C` 需 ≥1.8.5、`init -b` 需 ≥2.28、`--autostash` 需 ≥2.6 → **三处皆不支持** [待真机验证]；本机为 git 2.39.5（不暴露该问题）。
  - `scripts/install.sh` **未做任何 git 凭据铺设**（仅处理 yuyi token/env 桥接与 policy）。
  - PathGuard 机密根现状：`tokenPath` / `vault.dbPath` / `~/.omp` / `~/.ssh`（含真实 home）/ 私有 `home` → **KB 凭据文件需增补**。
- **基建层**：omo 私有域 `$OMO_DIR`（可整体删除）、HOME 重定向、profile/cron 由安装器管理；`policy.json` 默认 `{"targets":[]}`（变更类操作需 Owner 预授权）。

## 四、Gap Analysis（先复用）

| 能力 | 判定 | 依据 |
|---|---|---|
| KB 本地读写/检索 | **Reuse** | KnowledgeStore + `ops_kb_list/search/save` 已具备 |
| git 同步骨架 | **Extend** | 已有 init/remote/pull/commit/push；需补：**版本探测兼容**、分支纪律、凭据注入、非交互化 |
| 凭据存储与保护 | **Extend** | 复用 600 文件 + PathGuard 机密根模式（同 `~/.yuyi/env`、`approval-token.json` 做法） |
| 自动发放/注册表/轮换 | **Build** | 仓库内无任何发放、注册表、enrollment 能力 |
| 调度 | **Extend** | `omo serve` 常驻 + 安装器 cron 机制已具备 |
| 审计 | **Extend** | 现有哈希链审计可记 `kb_sync`；GitLab 侧记录 token 使用 |
| **制品部署模式** | **Reuse** | 主干新增 `vendor/yuyi-skills/` + `install.sh` 部署到 `$HOME_DIR/.omp/agent/skills/`（**门控＝凭据非空**，避免装出「有技能没通道」的半成品）→ KB 凭据/工具若需随包分发，沿用同一「vendor → install.sh → 门控落盘」模式 |

## 五、方案主体（推荐 A）

### 5.1 账号/凭据模型（三选一）

| 方案 | 说明 | 优点 | 代价 |
|---|---|---|---|
| **A. 每实例 Deploy Token（推荐）** | GitLab 项目级 deploy token，`read_repository`（贡献者再授 `write_repository`）；可设过期 | 无需用户账号/许可证；**可单独吊销**；作用面最小 | 不能自动建 MR（由中心合流）；GitLab 侧「用户」列显示为 deploy token |
| B. 每实例 Project Access Token | 需 GitLab ≥13.9；可带 `api`（能自动建 MR） | 自动化程度高 | 权限面更大（等同项目机器人）；审计归属模糊 |
| C. 每实例用户账号 | 真账号 + PAT | 审计最清晰 | 运维重（账号生命周期/许可证），除非合规要求「人可归属」 |

**推荐 A**；若确需实例自动开 MR，仅对少数「协调者实例」用 B。

### 5.2 发放（自动化）——两条路径

- **E1 自注册（推荐）**：Owner 在注册表登记实例（设备名 + agentId）并生成**一次性 code**（TTL 30min）→ 实例执行
  `omo kb enroll --server <url> --code <code>` → 服务用 GitLab API 创建 deploy token（绑定实例标识、写入注册表）→ **TLS 直连回给该实例**（不经御驿/聊天/日志）→ 实例落盘 0600 + `git ls-remote` 自检。
- **E2 Owner 批量脚本（半自动）**：服务器上跑 `ops-kb-provision --registry registry.yaml` 批量建 token，再逐台交付（安装参数 / 一次性 code 兑换）。适合实例数少的早期。

> 两条路径共同纪律：注册表**只存 token id/前缀/scope/expiry**，不存明文；明文只在「服务 → 目标实例」一次性出现。

### 5.3 实例侧落地

| 项 | 设计 |
|---|---|
| 凭据文件 | `$OMO_DIR/kb/credential.json`（0600）或 `~/.git-credentials`（0600）；SSH 备选 `~/.ssh/id_omo_kb`（0600） |
| 非交互 | `GIT_TERMINAL_PROMPT=0`；HTTPS 走 `credential.helper=store --file=<path>`（老 git 可用）或 `http.extraHeader`；SSH 走 `~/.ssh/config` Host/IdentityFile（**老 git 无 `GIT_SSH_COMMAND`**，该路径兼容） |
| Agent 不可读 | PathGuard 机密根增补：KB 凭据文件 + `~/.ssh/id_omo_kb`（防 LLM 经 `ops_file_read` 读取外泄） |
| **兼容层** | `git --version` 探测后分支：≥2.28 用 `init -b` / `--autostash`；否则 `git init` + `checkout -b`、`stash`+`pull --rebase`+`stash pop`；`git -C` 一律改为 Runner 的 `cwd`（本仓 Runner 支持 cwd）→ **顺带修掉现有实现对老 git 的三处不兼容** |
| 分支纪律 | 实例只推 `instance/<device>`（首次 push 自动建）；`main` 仅由中心合流；pull 只取 `main`（可选叠加自己的分支） |
| 调度 | `omo kb sync`（默认 pull；`--push` 提交并推自己分支）由 `omo serve` 定时（默认 15min）+ `ops_kb_sync` 手动触发；失败静默降级 |
| 可观测 | `ops_kb_status`（read 档）：最后同步时间/结果/远端头/token 到期日 |

### 5.4 服务器侧（新建，独立交付）

- `enroll` 小服务（内网/TLS）：校验 code（一次性、TTL、绑定设备）→ GitLab API 建 token → 回传 → 写注册表 + 审计。
- `registry.yaml`：`instance(device/agentId) → token_id/prefix/scope/expiry/owner/created_at`。
- 轮换/吊销脚本：rotate（建新 token → 交付 → 撤旧）/ revoke（秒级生效）。
- 中心合流：MR 由 Owner/协调者审阅合并（保留「待审核」纪律）；可选 CI：KB 条目 lint（frontmatter 必填 + **禁凭据模式**扫描）。

### 5.5 凭据生命周期

默认 TTL **12 个月**；到期前 30 天 `ops_kb_status` 报警；轮换 = 重新 enroll（新 code）或 Owner 脚本 rotate；吊销 = 删除 deploy token（秒级生效，实例自动回落本地模式）。

## 六、风险覆盖

| 面 | 风险 | 处置 |
|---|---|---|
| 兼容 | git 1.8.3.1 三处特性不支持 | 版本探测 + 退化分支（§5.3）；真机验证项 |
| 网络 | 按主机放行 / 代理 | 内网 443 优先；支持 `http.proxy`；SSH 仅当 22 可达 [待验证] |
| 异常 | 发放服务不可达 / pull 冲突 / push 被拒 | 本地模式降级；`pull --rebase` 失败保留本地并报告；push 失败提示 scope |
| 状态 | KB 目录与凭据位置 | KB 在 `$OMO_DIR/knowledge`（私有域隔离）；凭据不入 KB、不入备份 |
| 安全 | 凭据外泄面 | 最小 scope；不经御驿传密；PathGuard 机密根；KB 内容禁含凭据（CI lint） |
| 回滚 | 需停用同步 | `omo kb disable`（撤 token + 停定时任务），只读巡检不受影响 |

## 七、验证覆盖

- **Unit**：gitSync 兼容分支（stub Runner 断言 argv/cwd 形态）；凭据落盘权限 0600；PathGuard 对 KB 凭据与 `~/.ssh/id_omo_kb` 拒读。
- **Contract**：`git ls-remote` 只读自检；enroll 服务 200 / 401（code 无效）/ 410（code 过期）。
- **Regression**：老 git 模拟（argv 形态断言；可选容器内装 git 1.8 真跑一次）。
- **Monitoring**：`ops_kb_status`（最后同步时间/结果）；服务器注册表 + GitLab audit events。
- **Rollback**：撤 token + 关定时任务；验证实例回落本地模式且只读工具正常。

## 八、不确定性治理

**Unknown（[待验证]）**
1. Git 服务器产品与版本（是否 GitLab？能否用 deploy token / project access token？API 路径前缀 `/git/`？）。
2. 实例是否允许直连 GitLab API（若否，enroll 必须由中间服务代建）。
3. SSH 22 端口可达性（对端此前未能验证）。
4. git 1.8.3.1 上三处特性的实测行为（`-C` / `init -b` / `--autostash`）。

**Conflict**：无（与 dsh-architect 迭代、KB 校验器均不冲突）。

**Human Decision（需主人拍板）**
1. 账号模型：**A 每实例 Deploy Token（推荐）** / B Project Access Token / C 每实例用户账号。
2. 发放路径：**E1 自注册（推荐）** / E2 Owner 批量脚本 / 两者并行（E2 先行、E1 后续）。
3. 写入模型：**只读镜像 + 分支贡献 + 中心 MR 合流（推荐）** / 实例直推 `main`（不推荐）。
4. 服务器侧归属：enroll 服务与注册表部署在哪台主机、由谁运维、Git 管理凭据由谁持有。
5. 生命周期：TTL（默认 12 个月）与轮换方式（重 enroll vs 脚本 rotate）。

## 九、五问自答

| 问 | 答 |
|---|---|
| 改哪里 | 实例侧：`tools/knowledge.ts`（gitSync 兼容+分支纪律）、新 `omo kb` CLI 与凭据存储、PathGuard secret、`omo serve` 定时；服务器侧：新 enroll 服务 + 注册表 + 轮换脚本 |
| 为什么改 | 共享 KB 需要**可单独吊销的每实例凭据**与**自动化发放**；现有 gitSync 既无凭据通路、也不兼容对端老 git，且直推 `main` 会绕过评审门 |
| 影响谁 | 所有 omo 实例（读路径为增强、缺席降级）；Owner（授权与合流）；Git 服务器运维（token 生命周期） |
| 如何验证 | §七：Unit/Contract/Regression/Monitoring/Rollback 五类；关键真机项=老 git 与内网 HTTPS 实跑 |
| 未确认 | §八 四条 Unknown + 五条待拍板决策 |
