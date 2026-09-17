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
