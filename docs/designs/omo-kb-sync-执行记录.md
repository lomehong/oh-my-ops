# OMO-KB-SYNC 执行记录 — P1（git 兼容层 + 分支纪律 + 凭据 + `omo kb`）

> 任务号：OMO-KB-SYNC ｜ 分支：`feature/OMO-KB-SYNC` ｜ 方案：`docs/designs/omo-kb-sync-credential-design.md`
> 范围：**P1**（自包含，不依赖 Gitea 与服务）；P2 供给 CLI / P3 自注册服务待后续。
> 主人决策（2026-09-17）：① 账号模型 A（每实例 bot 账号 + 作用域 token）；② E2 先行 + E1 自注册为主；③ 只读镜像 + 实例推 `instance/<device>` + 中心 PR 合流；④ 供给服务部署位置 = 部署时决策（不在设计范围）；⑤ 生命周期建议 TTL 12 个月 + 零停机轮换。

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 结果 |
|---|---|---|---|
| K1 | git 兼容：版本解析/能力表/退化 argv 形态 | `node --test packages/ops-core/test/git-compat.test.ts` | ✅ 12 pass（含「无 init -b / 无 -C / 每条带 cwd / 脏树 stash-pull-pop」断言） |
| K2 | **真 git 端到端**（本地裸仓，无网络）：强制 el7 能力路径 | 同上 | ✅ 强制 `capsFor("1.8.3.1")` 跑通 init→commit→push 实例分支，且远端无 main |
| K3 | 分支纪律（工具/CLI 同源实现） | `bun test packages/ops-extension/test/kb-sync.test.ts` | ✅ 8 pass：A 推 `instance/<device>`、main 未被触碰、中心合流后 B 才可见；重复同步不提交；无远端=本地模式；实例分支不得等于主线 |
| K4 | 凭据 0600 + git store 格式 + 展示只到前缀 | 同上 | ✅ 两文件 0600；`https://user:token@host` 行格式；`tokenPrefix`/`daysUntilExpiry`/`redactUrl` |
| K5 | **凭据绝不入库**（含 kbDir 误配进私有域） | 同上 | ✅ 误配场景下 `git ls-files` 只有真条目，无 credential/state |
| K6 | 工具层包装语义不变 | `bun test packages/ops-extension/test/knowledge.test.ts` | ✅ 5 pass（本地模式 + 推实例分支且不推 main） |
| K7 | PathGuard 拒读 KB 凭据 | `bun test …/read-tier-structure.test.ts` | ✅ 14 pass（新增 KB 凭据机密根断言） |
| K8 | 安装器：KB 模块落位 + 启动器 kb 分支/定时/status | `bash scripts/probe-install-ops-core.sh` | ✅ 全绿（第 4 组 7 项断言；含他会话 skills 组恢复通过） |
| K9 | 全量门 | `npm run test:ci` | ✅ 全绿（L1 150 pass；L2 73 pass ×6 文件；typecheck；install/bootstrap 守卫） |
| K10 | `omo kb` 真实沙箱端到端 | 沙箱 HOME 内跑 `omo kb status` / `sync --push` | ✅ status 显示远端/分支/目录；sync 推 `instance/PC-SZ-375` ✓；再 sync「无本地改动」 |

## 二、Do → 文件映射

| 能力 | 落点 |
|---|---|
| git 兼容层 | `packages/ops-core/src/git-compat.ts`（+ `index.ts` 导出） |
| KB 同步共享实现 | `packages/ops-extension/src/kb-sync.ts` |
| 凭据存储/展示纪律 | `packages/ops-extension/src/kb-credential.ts` |
| 工具层复用 | `packages/ops-extension/src/tools/knowledge.ts`（`gitSync` 改为调用共享实现） |
| 私有域根 + 机密根 | `packages/ops-extension/src/context.ts`（`omoDir`、PathGuard secret += kb 凭据文件） |
| CLI | `packages/ops-extension/src/kb-cli.ts` |
| 启动器/调度 | `scripts/install.sh`（`OMO_DIR` 导出、bun 定位、`kb)` 分支、serve 定时循环、status 行） |
| 守卫 | `scripts/probe-install-ops-core.sh`（第 4 组）、`packages/package.json` 的 `test:l2` 纳入两测试文件 |

## 三、对照自检（实际输出摘要）

- **兼容层**：el7 能力下 argv 序列为 `git init` → `git symbolic-ref HEAD refs/heads/main`；pull 为 `status` → `stash push` → `pull --rebase` → `stash pop`；全程 `cwd`、无 `-C`。
- **分支纪律**：`push -u origin HEAD:refs/heads/instance/<device>`；中心合流用 `FETCH_HEAD:refs/heads/main` 模拟 PR；B 节点在合流前看不到 A 的条目、合流后可见。
- **凭据保护**：`kb/credential.json` 与 `kb/git-credentials` 均 0600；`ensureLocalExcludes` 把两者与 `state.json` 写进 `.git/info/exclude`（误配场景实测不入库）；PathGuard 拒读实测 `机密根`。
- **安装器**：沙箱安装 exit 0，生成启动器含 `export OMO_DIR=`、`kb)` 分支、`kb sync --quiet` 循环、status 的 KB 行；`bash -n` 通过。

## 四、未兑现项

- **P2 供给 CLI（E2）**：`ops-kb-provision` / `ops-kb-rotate` 按 §5.6 契约实现；代码与桩测试可先行，**真机跑**需 Owner 提供 Gitea 管理 token。
- **P3 自注册（E1）**：`omo kb enroll` + 服务端 `/enroll`、`/rotate`、`/revoke`；需**部署决策**（主人）+ §八 的 4 条 Gitea 待验证事实。
- **Gitea 侧 4 条待验证**：管理员能否代签 token / scope 名称与 `expires_at` / 创建 PR 所需 scope / 是否暴露 SSH 端点。
- **真机复验**：对端 el7 上跑 `omo kb status`（应显示 `git 1.8.3.1（cwd 模式；stash/pop 替代 --autostash；symbolic-ref 替代 init -b）`）——需其装下一版后执行。
- **未做（有意）**：`omo serve --foreground` 不含 KB 定时（前台用于调试）；SSH/Deploy Key 路线（可达性未证）；KB 条目 lint（供 P2/P3 的服务侧或 CI 承担）。

---

## 第二轮：真机验证（2026-09-17）——凭据注入形态 + 供给 CLI + 实测约束

**触发**：主人给出生产 Gitea 的 Owner 令牌（`omo-admin`，UI 签发，8 个 write scope），要求「连接真机验证 P1/P2」。

**真机测到什么（全部对生产 `twin.hzins.com/git/hzins-ops/ops-kb`）**

1. **P1 凭据路径端到端可用**：`omo kb sync` 拉取 3 条目；`sync --push` 推 `instance/PC-SZ-375` ✓（服务器侧 API 可见），main 未动，提交内无凭据文件。
2. **踩到并修掉三处（已入代码 + 守卫）**：
   - `-c credential.helper="store --file=<path>"` **不被本版 git 采纳**（三写法均 `Failed to authenticate user`；同令牌 `curl -u` 200、`git https://<token>@…` 可用）→ 改 **canonical store 路径 `$HOME/.git-credentials` + 私有 HOME**；
   - 首跑 `kbDir` 不存在 → spawn ENOENT 且报错无信息 → 先 `mkdir -p` + 补 `cwd=` 上下文；
   - pull/push 失败曾仍报 `ok:true` → 失败如实上报（仍不抛错）。
3. **签发约束（改变方案前提）**：`POST /users/{u}/tokens`（基本认证）**只回 `sha1`+`token_last_eight`，不回明文** ⇒ API 签发的令牌不可用；UI 的 scope 清单**不含 admin 类** ⇒ `POST /admin/users` 不可达 ⇒ **E1 自注册在本实例不可实现**，且 **bot 建号亦须人工**。
4. **替代凭据形态评估**：密码基本认证（git 端点 401，但密码已被主人轮换 ⇒ 结论未定）；**SSH 部署密钥不可行**（`ssh_url=git@localhost:…`、容器内无 ssh/ssh-keygen、TCP 不可达）⇒ **HTTPS + 令牌是当前唯一通路**。
5. **可自动化的部分（逐个真机验证）**：团队 create 201 / 成员 PUT 204 / 团队 DELETE 204 / 协作者 PUT 204 / DELETE 204 / 临时仓 create+delete 204 / PR create 201（PR #1 已建，待主人审阅）。

**交付**

- `scripts/ops-kb-provision.mjs`（P2 供给 CLI）：`grant`/`revoke`/`list` + `--selftest`(9/9) + `--dry-run`/`--apply`；已挂入 `npm run test:ci`。
- 真机实跑（可逆）：dry-run → apply（建团队 id=3 + 加成员 204）→ 服务器侧核验 → revoke（成员 204 + 解散团队 204）→ org 团队列表复原；登记文件 0600 且不含令牌本体。
- 实跑 PR：`https://twin.hzins.com/git/hzins-ops/ops-kb/pulls/1`（实例分支 → main，待审阅）。

**待主人决策**：凭据签发路径（见会话内提问）：E2 人工两步（现状，立即可用）／启用 Gitea SSH + 部署密钥（API 可自助签发+吊销，需改配置并放行端口）／提供 Git 服务器 shell（`gitea admin user generate-access-token` 可批量出明文）。

---

## 第三轮：推翻「不可行」结论 + 凭据形态改为密码（2026-09-17）

**起因**：主人驳回「API 无法自动化」的结论，要求必须走通 API。复核发现前一轮的判定有据但结论下早了。

**排查路径**

1. 先怀疑自己的观测：上一轮「建令牌响应无明文」是否因我 `head -c 300` 截断？
2. 读 `release/v1.27` 源码：`CreateAccessToken` 确实返回 `Token: t.Token` ⇒ 一度以为是我截断误判；
3. **本地起同版本 Gitea 1.27.3 复现 ⇒ 响应仍无 `token` 字段**（仅 `sha1`/`token_last_eight`）
   ⇒ 令牌路线在本版本**确实不可用**（源码分支含后续补丁，与 1.27.3 行为不同）；
4. 于是换问法：**有没有别的凭据形态能被 API 完全掌控？** —— 答案是**密码**：
   - 源码：`tokenRequiresScopes` 对**非令牌认证直接 return（不做 scope 检查）**；`reqToken()` 只要求「已登录」
     ⇒ **站点管理员用基本认证即可调 `/admin/*`**；
   - `CreateAccessToken` 需 `reqBasicOrRevProxyAuth` ⇒ 令牌路线还需基本认证，反而更绕。

**同版本实机验证（本地 Gitea 1.27.3，非生产，避免污染）**

| 步骤 | 结果 |
|---|---|
| 站点管理员基本认证 / `all` 令牌 调 `GET /admin/users` | **200 / 200** ✅ |
| `POST /admin/users` 建 bot（随机密码） | **201** ✅ |
| `PUT /repos/{o}/{r}/collaborators/{bot}` | **204** ✅ |
| git over HTTPS 用「用户名+密码」`git ls-remote`（直连 + omo store 机制） | **成功** ✅ |
| `PATCH /admin/users/{bot}` 改密 → 旧密码 401 / 新密码 200 / git 随新密码通过 | ✅ |
| 改乱密码（吊销）→ git 立即失败 | ✅ |
| 全链脚本化：`ops-kb-provision.mjs create/rotate/revoke` + 实例侧 `omo kb sync` | ✅（含 git 层自证 `ls-remote ✓`） |

**同轮修掉的三个真缺陷（均由实机暴露）**

1. 凭据 schema 迁移后实例**静默退化为「本地模式」**（有凭据却不生效）⇒ 改为**大声失败**：旧格式/字段缺失/非 JSON 一律明确报错；
2. **轮换后 git store 文件不刷新**（原实现仅当文件缺失才写）⇒ 改为按需刷新（内容变更即写，已入回归守卫）；
3. `spawn` 失败只报「命令失败：git」（首跑 cwd 不存在）⇒ 补 `cwd=` 上下文 + 先建目录。

**新增能力**：`ops-kb-provision.mjs` 重写为 `create / rotate / revoke / grant / list`（管理员令牌或站点管理员密码二选一），
`create` 内置 API + **git** 双层自证，交付物写独立 0600 文件（秘密不进 argv/终端/登记），自检 10/10 已入 `npm run test:ci`。

**遗留待确认（唯一一项）**：生产 Gitea 的**一次性引导凭据**由主人签发（`gitea admin user generate-access-token -u <admin> --scopes all --raw`，或提供站点管理员密码）。
拿到后即可在生产逐台全自动供给，并用「生产首台实例 `omo kb sync`」做最终把关（含生产是否允许密码基本认证的验证）。

**第三轮补记（引导凭据的三条路，均已实测）**

| 路径 | 做法 | 实测 |
|---|---|---|
| ① **UI 令牌（推荐）** | 站点管理员登录后 → 用户设置 → 应用 → 生成令牌 → 勾 `read:admin`+`write:admin`+`write:organization`+`write:repository`+`write:user` | 同版本 1.27.3 UI 令牌页**确有 admin 类**（9 类 × 读写）；该 5-scope 组合在真机上跑通 create/rotate/revoke ✅ |
| ② 站点管理员密码 | `--admin-user <admin> --admin-password-file <0600>` | 真机全链：建号 201 → 授权 204 → API+git 自证 ✓ → 实例 `omo kb sync` pull ✓ → 轮换 200 → 吊销 200/204 ✅ |
| ③ 服务端 CLI | `gitea admin user generate-access-token --scopes read:admin,write:admin,…` | 本地实测 CLI 签名令牌同样可驱动全链 ✅ |

注：`omo-admin` 是站点管理员，但**其令牌缺 `admin` scope ⇒ 仍被 403**（`required=[read:admin]`）——scope 属令牌，不属账号。

---

## 第四轮：**生产环境**全链落地（2026-09-17，主人给出站点管理员密码后）

**生产凭据**：`omo-admin`（`is_admin=true`）+ 密码 → 基本认证 `GET /admin/users` **200** ✅（无需 admin 作用域令牌、无需服务器 shell）。

**生产供给实跑（首次即成功）**

```
POST /admin/users                → 201（omo-bot-pcsz375, id=4）
POST /orgs/hzins-ops/teams       → 建团队 omo-kb-ops-kb
PUT  /teams/{id}/repos/hzins-ops/ops-kb → 204（**挂仓库**）
PUT  /teams/{id}/members/omo-bot-pcsz375 → 204
GET  /repos/hzins-ops/ops-kb（bot 凭据） → 200（自证一）
git ls-remote（同凭据）          → ✓（自证二；**证明生产允许密码基本认证**）
```
⇒ 交付 `{repo,username,secret,kind:"password"}`（0600）→ 装到本机实例 → `omo kb status` 显示凭据 → `omo kb sync` **pull ✓**（3 条目）。

**生产轮换**：`PATCH /admin/users/omo-bot-pcsz375 {password}` → **200**；旧凭据 git **失败**；实例侧 store 文件自动刷新后 **pull ✓**。
**生产写入**：`omo kb sync --push` → `push instance/PC-SZ-375 ✓`（服务器侧树已含 2 条新条目）。

**本轮由生产暴露并修掉的 3 个真缺陷**

1. **团队不挂仓库 = 无任何权限**：`--grant team` 原先只 `units_map` + 加成员，未 `PUT /teams/{id}/repos/{org}/{repo}`
   ⇒ 成员拿不到仓库访问。已补，并在 `create` 里用 bot 凭据自证兜底。
2. **新克隆推送被 `fetch first` 拒绝**：同步只拉 `main`，从不拉自己的实例分支 ⇒ 远端已有同名实例分支时非快进被拒。
   已加 `integrateRemoteBranch`（推前 fetch + merge，冲突即 abort 并保留本地，**绝不 force**）。
3. **漏推**：只在「本轮有新改动」时才 push ⇒ 上次推送失败留下的本地提交会被静默搁置。
   已改为按 `hasCommitsToPush`（`rev-list --count <远端 tip>..HEAD`）判定。

三项均有回归守卫（`kb-sync.test.ts` 15 pass）。至此 **P1 的凭据/同步/分支纪律在真实生产上全部闭环**。

---

## 第五轮：P3 自注册服务落地（2026-09-17）

**交付**
- `scripts/lib/kb-gitea.mjs`（Gitea 原语，供给 CLI 与服务**共用一份实现**）、`scripts/lib/kb-registry.mjs`（登记表 + 一次性码，只存 sha256/sha1）；
- `scripts/ops-kb-enroll-server.mjs`（`/healthz` + `/enroll`；一次性码授权；TLS 默认强制；哈希链审计）；
- `omo kb enroll`（客户端：兑换 → 落盘 0600 → **立刻自证同步**；revoke 时删除本地凭据）；
- `ops-kb-provision.mjs code --op enroll|rotate|revoke [--device] [--ttl]`（签发一次性码）；
- 测试 `packages/ops-extension/test/kb-enroll.test.ts`（真子进程真 HTTP + 桩 Gitea）：一次性、设备绑定、过期、吊销、TLS 拒绝启动、healthz、**秘密不落登记/审计** → 5 pass；已入 `test:ci`。

**生产实测（真 Gitea，真码）**
| 动作 | 结果 |
|---|---|
| `code --op enroll` → 客户端兑换 | ✓ 建号 `omo-bot-pc-sz-375` + 授权 + 自证同步 **pull ✓**（3 条目），凭据落盘 0600 |
| 码重放 | **409**「已被使用」（审计记 `enroll.rejected(used)`） |
| `code --op rotate` → 兑换 | ✓ 新凭据生效、**旧凭据 git 立即失败** |
| `code --op revoke` → 兑换 | ✓ 服务改密+撤权；客户端**删除**本地凭据；同步回落本地模式 |
| 再 `enroll` | ✓ 凭据恢复、自证同步通过 |
| **TLS 直连** | ✓ 服务 HTTPS（`/healthz` → `tls:true`）；客户端默认拒绝自签证书；`--allow-insecure-tls` 后经 TLS 完成生产轮换 |

**顺带清理**：今日用 `provision` 临时建的 `omo-bot-pcsz375` 已 `revoke --delete-user`（同一设备只留一个 bot）。

**门禁**：`npm run test:ci` 全绿（L1 150、L2 含 enroll 5 例、provisioner 自检 11/11、**core+extension 双侧 typecheck**、install/bootstrap 探针）。

**口径（2026-09-17 主人指令）**：手工部署的 omo 节点**由主人手工升级**，agent **不触达、不引导其安装**。
本文档中所有"对端配合"的内容仅作**事实记录**（其网络与权限约束已固化为代码：HOME 重定向守卫、
`--token-file` 0600、受限网络入口 codeload/jsdelivr），升级动作一律由主人执行；el7 真机退化验收待主人升级后另定。
