# omo 知识库同步与凭据分发设计（ops-kb）

> 来源需求：主人 2026-09-17 会话——内部 git 仓 `https://twin.hzins.com/git/hzins-ops/ops-kb` 已创建，用于 omo 实例间同步共享知识库；需**自动化**为每个 omo 实例分配可用账号/令牌，用于拉取与同步。
> 状态：**待主人拍板**（本文件为设计产出，未进入编码）
> **服务器已确认（2026-09-17 主人）**：**Gitea 1.27.3**，根路径 `https://twin.hzins.com/git/`。
> 我方对实例的只读探测（未持凭据）：
> · `GET /git/` → 200（Gitea Web UI 正常）；`GET /git/api/v1/version` → **403 `Only signed in user is allowed to call APIs`**（该实例 API **禁止匿名**）；
> · 仓库页 `…/hzins-ops/ops-kb` → **303**（跳登录）；`…/info/refs?service=git-upload-pack`（匿名 clone）→ **401** ⇒ **仓库为私有，读也需凭据**（与主人需求一致）；
> · SSH 端口探测：**22 与 2222 从本容器均不可达** ⇒ 「SSH Deploy Key 路线」可达性未证（见 §八 Unknown）。
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

### 5.1 账号/凭据模型（Gitea 语境，三选一）

> Gitea 与 GitLab 的凭据面不同：**没有「项目级 HTTPS deploy token」**；可用的是「用户级 access token（自 1.20 起带 scope，可单独吊销）」与「仓库级 deploy key（SSH）」。

| 方案 | 说明 | 优点 | 代价 |
|---|---|---|---|
| **A. 每实例机器人账号 + 作用域 access token（推荐）** | 管理 API 建 bot 用户（`admin/users`）+ 授予仓库/团队权限（read 或 write）+ 为该用户签发 `read:repository`（贡献者再加 `write:repository`）token | 归属最清晰；**可单独吊销**；自托管无许可证成本 | 需管理 N 个 bot 账号生命周期；token 的签发/轮换需该用户凭据 [待验证：管理员能否代签] |
| B. 单服务账号 + N 个 token（token 名编码实例） | 一个服务用户，每实例一个 token | 运维最简（只有 1 个账号） | Gitea 侧审计只到「服务用户」；需靠 per-repo `user.name/user.email` 与提交内容做归属 |
| C. 每实例 Deploy Key（SSH，仓库级，可授写） | 实例**本地生成密钥对**，只上送**公钥**注册 | **零秘密分发**（私钥不出实例）；`~/.ssh` 已在 PathGuard 机密根 | **SSH 可达性未证**（本容器 22/2222 均不可达）；密钥为仓库级 |

**推荐 A**；若运维希望账号数最小化 → B；**若 SSH 可达性验证通过**，C 在安全面最优（无秘密分发），可作为贡献者实例的加分选项。

### 5.2 发放（自动化）——两条路径

- **E1 自注册（推荐）**：Owner 在注册表登记实例（设备名 + agentId）并生成**一次性 code**（TTL 30min）→ 实例执行
  `omo kb enroll --server https://twin.hzins.com/git --code <code>` → 服务用 **Gitea 管理 token** 调用 API：
  *方案 A*：建 bot 用户 → 授仓库/团队权限 → 签发作用域 token → **TLS 直连回给该实例**；
  *方案 C*：接收实例上送的**公钥** → 注册为该仓库 deploy key（读/写按授权）；
  → 实例落盘（0600）+ `git ls-remote` 自检。
- **E2 Owner 批量脚本（半自动）**：服务器上跑 `ops-kb-provision --registry registry.yaml` 批量建账号/签发 token 或注册公钥，再逐台交付（安装参数 / 一次性 code 兑换）。适合实例数少的早期。

> 两条路径共同纪律：注册表**只存** `instance → 账号名/token id/deploy key id/scope/permission/expiry`，**不存明文**；明文（或公钥交换）只在「服务 ↔ 目标实例」一次性出现。
> 已知约束：该实例 **API 禁匿名**（403），故服务侧必须持管理 token；实例侧若仅做 git 操作则**无需 API 权限**（SSH 方案尤其干净）。

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

### 5.6 服务器侧归属（建议）

| 项 | 建议 | 理由（本仓实证） |
|---|---|---|
| enroll 服务位置 | **与御驿 Hub 同机**（`172.20.10.91`），独立端口 + 独立 systemd 单元 | 该机是**当前唯一被所有实例证明可达的中心节点**（全部对端都经 `ws://172.20.10.91:7377` 在线）；不必在 Git 服务器上引入新服务 |
| 通信方式 | 实例→服务 **HTTPS 直连**（内网 CA 或自签+指纹固定），**不经御驿** | 沿用「凭据禁经御驿」纪律；Hub 是 `ws://` 明文，凭据不宜并入该通道 |
| 注册表位置 | 服务同机文件 `registry.yaml`（0600）+ 每次变更 append 审计行 | 与现有文件承载审批/台账的做法一致；无 DB 依赖 |
| 运维归属 | **Owner（hz0704027）**：持有 Gitea 管理 token、维护注册表、执行轮换/吊销 | 管理 token 是**单点最高权限**，不宜下发给任何实例或 Agent |
| Gitea 管理 token | 仅存于该机 0600 文件（或 systemd `LoadCredential`），**不入仓/不入 KB/不入御驿**；90 天轮换 | 与「sign_secret 只在御符 API + 本机配置」同款纪律 |
| 备选（若不想加服务） | 仅走 **E2**：Owner 在服务机跑脚本批量签发，逐台交付 | 放弃自注册的自动化，换取零新增常驻服务 |

### 5.7 生命周期（建议）

| 项 | 建议 | 说明 |
|---|---|---|
| Token TTL | **12 个月**（若 Gitea 1.27.3 支持 `expires_at` 则落到服务端；否则由注册表强制） | 到期前 **30 天** `ops_kb_status` 与注册表同时告警 |
| 自动轮换（推荐形态） | 实例用**现有 token 作凭证**调用 `POST /rotate`：服务校验该 token 在 Gitea 仍有效 → 为同一 bot 用户签发新 token → 实例落盘并 `git ls-remote` 自检成功回调 → 服务**在确认后**吊销旧 token | 零停机、无需人工；旧 token 在确认前保留（注册表记 `previous_token_id`，保留 7 天） |
| 事件驱动轮换 | 实例重装/迁移、疑似泄漏、Owner 主动 | 重装走 `omo kb enroll` 重新兑换（一次性 code） |
| 吊销 | 服务调 Gitea `DELETE …/tokens/{id}`；实例下次同步失败即回落**本地模式**（只读巡检不受影响） | 秒级生效 |
| 检测 | 实例 token 与注册表 **双处对账**：`omo kb status --json` 上报「token 前缀 + 到期日 + 最后同步时间」；注册表侧可选巡检比对 | 单边丢失可及时发现 |
| 存储 | 实例侧 `$OMO_DIR/kb/credential.json`（0600）+ PathGuard 机密根；**不进 KB、不进随主机迁移的备份** | 见 §5.3 |

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
1. ~~Git 服务器产品与版本~~ → **已确认：Gitea 1.27.3，路径前缀 `/git/`，API 禁匿名，仓库私有（读亦需凭据）**。剩余 Gitea 侧待验证：① 管理员能否代某个 bot 用户签发 token（否则需先设随机密码再用其基本认证签发）；② 该版本 token 的 scope 名称与是否支持过期；③ 创建 PR 需要的作用域（`write:issue`?）；④ 是否暴露 SSH 端点。
2. 实例是否允许直连 GitLab API（若否，enroll 必须由中间服务代建）。
3. **SSH 端点可达性**：本容器对 22/2222 均不可达（对端此前亦未验证）；方案 C（Deploy Key）依赖此项 → 需在至少一台目标实例上实测。
4. git 1.8.3.1 上三处特性的实测行为（`-C` / `init -b` / `--autostash`）。

**Conflict**：无（与 dsh-architect 迭代、KB 校验器均不冲突）。

**Human Decision**
1. ✅ **已定：A 每实例 bot 账号 + 作用域 token**（主人 2026-09-17）。
2. ✅ **已定：E2 先行 + E1 自注册为主**（主人 2026-09-17）。
3. ✅ **已定：只读镜像 + 实例推 `instance/<device>` + 中心 PR 合流**（主人 2026-09-17）。
4. ⏳ 待定：服务器侧归属 → 见 §5.6 建议。
5. ⏳ 待定：生命周期 → 见 §5.7 建议。

## 九、五问自答

| 问 | 答 |
|---|---|
| 改哪里 | 实例侧：`tools/knowledge.ts`（gitSync 兼容+分支纪律）、新 `omo kb` CLI 与凭据存储、PathGuard secret、`omo serve` 定时；服务器侧：新 enroll 服务 + 注册表 + 轮换脚本 |
| 为什么改 | 共享 KB 需要**可单独吊销的每实例凭据**与**自动化发放**；现有 gitSync 既无凭据通路、也不兼容对端老 git，且直推 `main` 会绕过评审门 |
| 影响谁 | 所有 omo 实例（读路径为增强、缺席降级）；Owner（授权与合流）；Git 服务器运维（token 生命周期） |
| 如何验证 | §七：Unit/Contract/Regression/Monitoring/Rollback 五类；关键真机项=老 git 与内网 HTTPS 实跑 |
| 未确认 | §八 四条 Unknown + 五条待拍板决策 |
