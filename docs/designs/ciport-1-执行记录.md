# CIPORT-1 执行记录 — test:ci 跨平台可推（Windows 红项归零）

> 任务号：CIPORT-1 ｜ 分支：`feature/CIPORT-1` ｜ 动作级别：L1
> 驱动指令（原文）：「系统性修复这些构建的问题，确保任何设备都可以正确的 git push，打tag触发CI。」
> 依据：`docs/tasks/CIPORT-1.yaml`（accept 六条）；`docs/designs/omovendor-1-执行记录.md` §3.6（本记录收口的「三类环境限定红项」）；`.github/workflows/release.yml`（tag 触发与打包闸门必须保持）
> 口径：只登记实测。未跑到的（Linux 真机）单独列在 §七，不与本机结论混报。

## 一、测试清单（先有验收后有代码；对应 accept 六条）

| # | accept 条目 | 可执行验收（命令/夹具） | 预期观察（红 → 绿） | 结果 |
|---|---|---|---|---|
| A1 | 全量枚举逐项落档 | 13 步逐项独立跑（每步一 log：`/e/tmp/ciport-enum/`） | 红：无基线；绿：13 步 exit/耗时表（§二），失败不中断 | ✓ |
| A2 | 逐项根因 + 红→绿证据 | 各步单独重跑 + 引文（§三/§5.1） | 红：红项无根因；绿：红项 ↔ 根因 ↔ 绿证据 一一对应 | ✓ |
| A3 | 平台能力探测统一化 | `grep -rn "can_express_0600\|canExpress0600" scripts/ packages/`；探针输出含 ⚠ 行；强制置位负例（§5.4） | 红：硬编码平台名 / 静默跳过；绿：运行时探测 + 显式告知 + POSIX 分支保留（强制置位即变红） | ✓ |
| A4 | `npm run test:ci` 本机连续 2 次全绿 | 冻结树上连跑（§5.2） | 红：枚举态 6/13 步红；绿：连续两次 exit=0（#3/#4） | ✓ |
| A5 | tag CI 路径不受影响 + 口径对齐 | `npm run test:workflow`；`git diff .githooks/pre-push .github/workflows/release.yml README.md` | 红：README:337 把 test:ci 说成 3 步（漂移）；绿：三处口径一致 + tag 触发/打包闸门原样（§5.5） | ✓ |
| A6 | 修复范围最小化 + 真实缺陷单列 | `git diff --stat`；§六 | 红：无归类；绿：平台自适应 vs 真实缺陷分列，无「顺手重构」 | ✓ |

## 二、全量枚举红基线（2026-09-26 19:53–20:08，Windows 11 + Git Bash；日志 `/e/tmp/ciport-enum/`）

| # | 步骤 | exit | 耗时 | 红项摘要 |
|---|---|---|---|---|
| 1 | test:l1 | 1 | 3s | `ℹ fail 2`：ssh.test.ts host-key 路径断言 2 项（见 §3.1-1） |
| 2 | test:l2 | 1 | 43s | `121 pass / 14 fail`：0600 断言 6 + 真 git 超时 4 + P3 端到端 5（0600 级联）+ 脱敏 1 |
| 3 | kb:provision:selftest | 0 | 2s | —（注：该步枚举日志半途截断，仅 2 行骨架；不作为可信基线，绿侧有完整输出 13/13） |
| 4 | test:enroll-install | 1 | 88s | 0600 硬拦 3 处（`pw`/`scoped.token`/`good.token` 均 644） |
| 5 | test:kb-ui | 1 | 3s | `✗ 原子写 0600 + .bak`；深挖后暴露服务侧两条真缺陷（§3.2-3） |
| 6 | test:kb-lint | 2 | 5s | `✗ 安装失败：… good.token 当前 644` |
| 7 | test:web-verify | 0 | 2s | 本机无 Chrome：显式 `⏭ SKIP`（有 Chrome 的机器照跑） |
| 8 | typecheck | 2 | 4s | 17 个 TS 错（枚举时依赖未装齐 ⇒ 装齐后 0 错，零代码改动，见 §3.1-7） |
| 9 | test:workflow | 0 | 3s | — |
| 10 | test:install | 1 | 371s | 恰 1 行红：`✗ 0600 令牌文件安装失败：… token-600 当前 644` |
| 11 | test:bootstrap | 1 | 190s | `✗ 假代理未起来` ×2（python3 = Microsoft Store 别名桩） |
| 12 | test:vendor | 0 | 35s | —（负例自证 9 通过 / 6 失败 = **预期**） |
| 13 | test:vendor-integrity | 0 | 39s | — |

合计 ≈ 788s（≈13 分钟）：红 8 步（l1/l2/enroll-install/kb-ui/kb-lint/typecheck/install/bootstrap，exit≠0），绿 5 步（provision-selftest/web-verify/workflow/vendor/vendor-integrity）。

## 三、逐项根因与红→绿

### 3.1 平台语义差异（改测试/探针侧；POSIX 原判据一字未减）

1. **L1：ssh host-key 路径断言 2 项**
   - 红：`✖ 支持 accept-new（OpenSSH ≥7.6）→ StrictHostKeyChecking=accept-new + 受管 known_hosts` / `AssertionError: 应指向受管 known_hosts`。
   - 根因：断言拿 `path.join` 结果（Windows 反斜杠 `…\known_hosts`）与 POSIX 字面量比较；被断言的 argv 本身正确，属**测试侧平台假设**。
   - 修复：`packages/ops-core/test/ssh.test.ts:122` 加 `posix()` 归一化（仅比较用），`:127,:135` 应用；Linux 上 `posix()` 为恒等 ⇒ 判据不弱化。
   - 绿：run#2 `ℹ pass 140 / ℹ fail 0`。

2. **L2：测试侧 0600 断言（6 项）**
   - 红：`kb-credential 落盘/轮换`、`凭据注入机制`、`脱敏：状态落盘` 等 6 项在 Windows 断言 `mode & 0o777 === 0o600` 必红（本机 chmod 600 ⇒ 实际 644/666）。
   - 根因：Windows 文件系统**不可表达** 0600（能力缺失，非产品缺陷）。
   - 修复：新增 `packages/ops-extension/test/runtime/perm-mode.ts`（`canExpress0600()`:15 运行时实测；`expectSecret0600()`:43 可表达⇒严格等值、不可表达⇒存在性检查 + 首次降级打印一行 ⚠）；kb-sync/kb-enroll/redact 测试改用之。

3. **L2：真 git 端到端 4 项超时（5000ms 默认值）**
   - 红：`KBORG-1 … ^ this test timed out after 5000ms`、`syncKb：分支纪律 [7946.72ms]`、`★ 同设备名的新克隆`、`★ 已有本地提交…必须推送`。
   - 根因：这些用例跑**真 git**（file:// 裸仓、推送/合并、Windows FS 慢）。绿侧实测单项 10.4s ⇒ 5000ms 预算不适用。
   - 修复：`package.json:13` `test:l2` 加 `--timeout 60000`（预算问题，与 §3.2-1 的真实缺陷叠加）。
   - 绿：run#2 `135 pass / 0 fail；Ran 135 tests across 11 files. [66.57s]`。

4. **探针夹具 0600 硬拦（enroll-install / kb-lint / kb-ui / install 的 0600 段）**
   - 红：`✗ 拒绝原因不明确：✗ 权限过宽（应 0600）：/tmp/tmp.Bemqn8lPTR/pw 当前 644`（enroll-install 3 处）、`✗ 安装失败：… good.token 当前 644`（kb-lint）、`✗ 0600 令牌文件安装失败：… token-600 当前 644`（install，恰 1 行）。
   - 根因：探针自建夹具（`chmod 600` 后 644）触发产品侧硬拦；在不可表达 0600 的平台上这是**必然**结果。
   - 修复：产品侧 `scripts/lib/secret-perm.sh`（`can_express_0600`:16 / `check_secret_perm`:31）统一探测；探针用 `perm_pass` 断言「降级放行但必须告警」，并在 `can_express_0600` 为真时走原严格断言（`probe-install-ops-core.sh:234`、`probe-install-enroll-service.sh:78`）。
   - 绿：`✓ 不可表达 0600 ⇒ 降级放行且告警（POSIX 上仍硬拒）`；`✓ 管理员令牌文件权限过宽 ⇒ 降级放行但必须告警（不可静默）`。

5. **bootstrap：`✗ 假代理未起来` ×2**
   - 根因：探针用 `python3 -m http.server` 起假代理；Windows 上 `python3` 是 Microsoft Store 别名桩（存在、一跑就退）。
   - 修复：`probe-bootstrap-version.sh:17,37,64` 改为 bun `proxy.mjs`（测试链本就硬依赖 bun），并显式断言 bun 存在。

6. **探针 EXIT trap + `set -e` 缺陷（全绿却 exit 1 + 泄漏）**
   - 红：探针打印 `结果：0 项失败` 却 `exit=1`；同时残留服务进程与 `rm -rf` 删不掉的临时目录（Windows 文件句柄）。
   - 根因（`bash -x` 追到 trap 末行）：trap 内的 `kill <原生 Windows pid>` 失败 ⇒ `set -e` 点着 ⇒ trap 中断（既没删临时目录也没 `return 0`）⇒ 全绿翻红。最小复现：trap 内失败命令 ⇒ `bad_exit=1`。
   - 修复：新增 `scripts/lib/proc.sh`（`pid_alive`:14 双命名空间存活探测 = `kill -0` ∨ `tasklist`；`proc_kill`:21 温柔终止 + `taskkill //F //T` 兜底 + 退不干净大声告警）；所有探针 cleanup 首行 `set +e` + 用 `proc_kill`（kb-ui/kb-lint/enroll-install/bootstrap/web-verify/vendor-integrity）。
   - 绿：探针 `exit=0` 且跑后无残留进程/临时目录（§5.6）。

7. **typecheck 17 错（枚举时）**
   - 根因：枚举时 `node_modules` 未装齐（`@types/bun → bun-types` 提供 `Promise.withResolvers` 等声明；bun-types/globals.d.ts:1425-1441）。
   - 结论：依赖装齐后 `npm run typecheck` = 0 错，**零代码/配置改动**；不属产品缺陷。

8. **web-verify 无 Chrome**：本机显式 `⏭ SKIP` 并打印原因（非静默）；有 Chrome 的机器照跑。

### 3.2 真实缺陷（产品侧，最小修复）

1. **`-c credential.helper=store` 只追加，系统 helper 先跑（安全面）**
   - 现象：kb-sync 的凭据注入实测 57s 挂起，且 `git credential fill` 返回**本机开发凭据**（Git Credential Manager 先响应）。
   - 根因：`-c credential.helper=store` 是**追加**到继承的 helper 链尾，系统级 helper 优先级更高。
   - 修复：`packages/ops-extension/src/kb-sync.ts:134-139` 先 `-c credential.helper=`（空值）重置链，再挂 `store`；测试同款同步（`kb-sync.test.ts`）。
2. **`hostname -I` 只有 GNU 有**（`scripts/omo-kb-fleet.sh:77-83`）：Windows Git Bash/macOS/BSD 上该命令不存在，叠加 `pipefail` 会**静默退出**（SAN 取不到就无声失败）。修复：bun 读首个非回环 IPv4 兜底 + 取不到显式 `die`。
3. **enroll 服务配置切换两条（kb-ui 探针深挖所得）**：
   - `config.env` 写入 MSYS 形式路径（`/e/…`）⇒ 原生 bun 读配置 `ENOENT`；修复 `native_path()`（cygpath -m，`install-enroll-service.sh:89,276-280`）。
   - 接班进程**静默消失**（直接 spawn 随父进程退出；端口重绑窗口过短）：修复为进程内预检（`ops-kb-enroll-server.mjs:135`）+ 先 `server.stop(true)` + `detached` spawn + `OMO_KB_BIND_RETRY_MS=20000`（`:383-392,497`）。
4. **`kb-enroll.ts readCodeFile` 0600 硬拦**（`packages/ops-extension/src/kb-enroll.ts:74-104`）：Windows 上兑换码文件永远 644 ⇒ enroll 整链锁死。修复：同策略运行时探测 + 首次降级大声告警（绝不静默）。
5. **同类硬化**：`scripts/lib/kb-gitea.mjs:12,16-17`（readSecretFile 统一走 `assertSecretFilePerm`）、`scripts/ops-kb-provision.mjs:37-40,292,300,310`（os.tmpdir/fileURLToPath/canExpress0600）、`scripts/omo-kb-doctor.sh:25,45-51`（体检不报假红）。
6. **`probe-kb-ui.sh` 的 `--outfile /dev/null`**：Windows 上 bun 把它落成 CWD 的 `nul` **实体文件**（污染仓库根；隔离复现两次 + 历史件溯源同源）。修复：产物写 `$TMP`（`:97`）。
7. **待决（登记，不在本次收口范围）**：`handleKbWebhook` 的 status/comment 写回未检查 `resp.ok`（`ops-kb-enroll-server.mjs:221-226`）——Gitea 侧 4xx/5xx 会被静默吞掉（审计仍记 `lint.blocked`）。桩 Hub 恒 201 ⇒ 探针看不见。建议：查 `resp.ok`、失败入审计 `lint.writeback_failed` 并 `ok:false`。**未改**（避免污染刚验证过的服务证据）。
8. **`kb:provision:selftest` 负例把默认名产物写进 CWD（跨设备污染）**
   - 现象：全链跑完仓库根多出 `n-credential.json`（伪秘密 `omo--…`、kind=password）与 `ops-kb-registry.json`；`git status` 见两个 untracked 件，误 `git add -A` 即成「凭据形状文件进提交」。
   - 根因：自检「管理员令牌权限过宽」负例调 `create --device n --login x --apply` 时**未给 `--registry`/`--deliver`** ⇒ 落到默认名（`ops-kb-provision.mjs:129,131`：`<device>-credential.json` / `ops-kb-registry.json`），相对 **CWD**（npm 脚本即仓库根）。POSIX 上该负例在权限校验处**早拒**（永不落盘），故长期不暴露；不可表达 0600 的平台降级放行后会一路跑到落盘 ⇒ 每次 `test:ci`/pre-push 污染一份（实证三处：run #2 21:34:15、run #3 21:49:41、单步复现 22:04；run #3 后指纹漂移 `c114434d…` 即由此）。
   - 修复：负例显式 `--registry`/`--deliver` 指进临时目录（`ops-kb-provision.mjs:325-326`）；自检新增断言「降级路径产物只落临时目录、不污染 CWD」（`:333-337`）。
   - 自证（变异）：撤销显式路径的副本 ⇒ `自检：13/14 通过` 且两文件复现（exit=1）；修复版 ⇒ `自检：14/14 通过` 且 CWD 无散落。

## 四、Do → 文件/行映射

| 改动 | 落点 |
|---|---|
| L1 路径断言归一化 | `packages/ops-core/test/ssh.test.ts:122,127,135` |
| L2 单测预算 | `package.json:13`（test:l2 `--timeout 60000`） |
| 真实缺陷：凭据 helper 链重置 | `packages/ops-extension/src/kb-sync.ts:134-139` |
| 测试侧 0600 能力分级 | `packages/ops-extension/test/runtime/perm-mode.ts`（新建）；引用：kb-sync.test.ts、kb-enroll.test.ts、redact.test.ts |
| 产品侧 0600 能力分级（bash/mjs） | `scripts/lib/secret-perm.sh`（新建）、`scripts/lib/secret-perm.mjs`（新建） |
| 兑换码读取降级告警 | `packages/ops-extension/src/kb-enroll.ts:74-104` |
| 服务端秘密读取统一 | `scripts/lib/kb-gitea.mjs:12,16-17` |
| 供给 CLI 硬化 | `scripts/ops-kb-provision.mjs:37-40,292,300,310` |
| selftest 负例 CWD 污染 | `scripts/ops-kb-provision.mjs:325-326`（显式临时路径）、`:333-337`（不污染 CWD 断言） |
| 体检脚本适配 | `scripts/omo-kb-doctor.sh:25,45-51` |
| 安装器闸门（source + 落盘前校验） | `scripts/install.sh:26`；`scripts/install-enroll-service.sh:41,89,276-280` |
| 安装器进程管理（双命名空间） | `scripts/install-enroll-service.sh:106-120,358,413-420` |
| 探针进程库（新建） | `scripts/lib/proc.sh:14,21` |
| 探针收尾（`set +e` + proc_kill + 守卫替换） | `probe-kb-ui.sh:12-24,137,157,160,174`；`probe-kb-lint.sh:9-13`；`probe-install-enroll-service.sh:9-11`；`probe-bootstrap-version.sh:19-23`；`probe-web-verify.sh:7-16`；`probe-install-ops-core.sh`；`probe-vendor-integrity.sh:91` |
| MSYS→原生路径（探针侧） | `probe-kb-ui.sh:7-10`（cygpath -m）、`:97`（`--outfile /dev/null`→`$TMP`）；`probe-kb-lint.sh`（TMP_NATIVE） |
| bootstrap 假代理换 bun | `scripts/probe-bootstrap-version.sh:17,37,64` |
| 真实缺陷：本机 IP 兜底 | `scripts/omo-kb-fleet.sh:77-83` |
| 真实缺陷：配置切换交接 | `scripts/ops-kb-enroll-server.mjs:135,368-392,497` |
| 服务包清单/打包 + 新库入包 | `.github/workflows/release.yml:95-96,127-130`（secret-perm.sh/.mjs、proc.sh） |
| 口径对齐（钩子/工作流/README） | `.githooks/pre-push:2-4,14`；`.github/workflows/release.yml:28-29`；`README.md:335,337` |
| 打包门路径修复 + 守卫（追记 §5.7） | `.github/workflows/release.yml:112-115`（清单引用改 `$GITHUB_WORKSPACE` 绝对路径 + 读空即红）；`scripts/probe-workflow-yaml.sh:44-55`（`cd` 后仓库相对路径守卫） |

## 五、对照自检（实际输出）

### 5.1 关键红→绿（引文）

| 步骤 | 红（枚举，`/e/tmp/ciport-enum/`） | 绿（run#2，`/e/tmp/ci-run2.log`） |
|---|---|---|
| test:l1 | `✖ … 应指向受管 known_hosts`；`ℹ fail 2` | `ℹ pass 140` / `ℹ fail 0` |
| test:l2 | `121 pass / 14 fail [41.73s]`；`^ this test timed out after 5000ms` | `135 pass / 0 fail`；`Ran 135 tests across 11 files. [66.57s]` |
| kb:provision:selftest | （枚举日志截断，不作基线） | `自检：14/14 通过`（含 0600 降级告警 2 项 + CWD 不污染 1 项；#2/#3 时尚未加护栏，为 `13/13`） |
| test:enroll-install | `✗ 拒绝原因不明确：… 当前 644` ×3 | `✓ 不可表达 0600 ⇒ 降级放行且告警（POSIX 上仍硬拒）` |
| test:kb-ui | `✗ 原子写 0600 + .bak` | `✓ 原子写 0600（本文件系统不可表达 ⇒ 降级：断言 .bak 与可读）` |
| test:kb-lint | `✗ 安装失败：… good.token 当前 644` | `结果：0 项失败` |
| test:install | `✗ 0600 令牌文件安装失败：… 当前 644` | `✓ 管理员令牌文件权限过宽 ⇒ 降级放行但必须告警（不可静默）` |
| test:bootstrap | `✗ 假代理未起来` ×2 | 全绿（bun `proxy.mjs`） |
| typecheck | 17 错（依赖未装齐） | 0 错（零代码改动） |
| 探针退出码 | `结果：0 项失败` 但 `exit=1`（trap 缺陷） | `结果：0 项失败` 且 `exit=0`；跑后无残留 |

### 5.2 全链连续绿（`npm run test:ci`）

| # | 起止 | 树状态 | exit | 备注 |
|---|---|---|---|---|
| #1 | （无 START/END 标记，见 `ci-run1.log`） | 运行中改过 `release.yml` 清单行 | **0** | 13 步全绿；`结果：全绿`×5、`0 项失败`×2；log 内 `✗` 计数 = 0（vendor 负例自证在捕获输出内：`9 通过 / 6 失败` 为预期）；**树漂移，不作严格对** |
| #2 | 21:32:48–21:46:38（`ci-run2.log`） | 运行中改过 README / `probe-kb-ui.sh`（均不在被测步骤依赖面：kb-ui 步已于 21:36 完成） | **0** | 同上；l1 `140/0`、l2 `135/0`；**树漂移，不作严格对** |
| #3 | 21:48:14–22:02:17（`ci-run3.log`） | 修前冻结树（起点 `23b966ac…`）；运行中 selftest 降级路径落盘（§3.2-8）⇒ 终点 `c114434d…` | **0** | 全链绿但发生落盘漂移，**不作严格对**（漂移根因即 §六-8，已修） |
| #4 | 22:06:20–22:20:23（`ci-run4.log`） | 修后冻结：起点=终点=`74f3b320…`（链内 `自检：14/14 通过`、无散落） | **0** | **严格对之一**；`✗`=0 |
| #5 | 22:20:33–22:34:39（`ci-run5.log`） | 修后冻结：起点=终点=`74f3b320…` | **0** | **严格对之二**；`✗`=0 |

### 5.3 冻结树指纹

定义（**不含本记录文件**——它是文档，跑前跑后都要追加）：

```bash
{ git diff; git status --porcelain | grep -v "ciport-1-执行记录"; \
  sha256sum docs/tasks/CIPORT-1.yaml packages/ops-extension/test/runtime/perm-mode.ts \
            scripts/lib/proc.sh scripts/lib/secret-perm.mjs scripts/lib/secret-perm.sh; } | git hash-object --stdin
```

| 取值点 | 指纹 |
|---|---|
| 修前冻结（#3 起点） | `23b966ac134f19e82f43a8a61b6ecc3ffedef502` |
| 修前冻结（#3 终点） | `c114434d5d5d35438654d13ca9383e6f6c28f291`（落盘污染所致，§3.2-8 ⇒ #3 不作严格对） |
| 修后冻结（#4 起点 = #4 终点 = #5 终点） | `74f3b320a821f64e0ee28166095b1da766f175ba` |

「连续两次全绿」= #4 与 #5 均满足「起点指纹 = 终点指纹 = 上表修后冻结值」。

注：指纹的台账分量为 `report` 前修订——`report`/`confirm` 事件属台账元数据，不被任何被测步骤读取；本记录文件按定义排除。

### 5.4 判据未弱化自证（强制置位负例）

`scripts/lib/secret-perm.sh` 的探测结果有缓存（`_OMO_PERM_CACHE`）。把缓存**强制置为 `yes`**（等价于「本机可表达 0600」）后，对同一 0644 文件重跑断言（实跑输出）：

```
① 真实态：can_express_0600 → probe=false
  ⚠ 本文件系统无法表达 0600（Windows/Git Bash 已知短板）：秘密文件 …/wide 实际权限 644 不受约束
  ⚠ 已降级放行；POSIX 主机上同一检查仍会硬拦。请确保该文件所在目录仅本账号可读。
① exit=0
② 强制置位（_OMO_PERM_CACHE=yes）：
✗ 秘密文件权限过宽（应 0600）：…/wide 当前 644 —— 修复：chmod 600 …/wide 后重跑本条
② exit=1
```

⇒ 严格分支存活且有区分力；「降级」只发生在本机**确实无法表达** 0600 时，且必定打印 ⚠（不静默）。

mjs 侧（`secret-perm.mjs`，供 kb-gitea / ops-kb-provision / kb-enroll 的同款判定）以**变异副本**同法自证（副本置于临时目录，不触碰发布件）：真实态 `canExpress0600 = false` ⇒ 打印 ⚠ 两行、不抛；副本把探测强制为 `true` ⇒ `秘密文件权限过宽（应 0600）：… 当前 666` 抛出。

### 5.5 tag/发布门与口径对齐

- `on: push: tags: ["v*"]`（`release.yml:3-5`）原样；打包 job 的三处闸门（清单断言 `:95-96`、打包前探针、包内指纹抽验）在本轮改动中原样（**包内指纹抽验的路径缺陷与修复见 §5.7**）；新增 `secret-perm.sh/.mjs`、`proc.sh` 入清单与打包（服务包零依赖自检仍过）。
- `npm run test:workflow` 绿（`release.yml 结构检查通过`）。
- 口径漂移消除：`README.md:337`（test:ci=3 步 → 13 步）、`:335`（l2 文件清单）、`.githooks/pre-push:2-4`、`release.yml:28-29` 四处口径统一为「本地 13 步 / CI test job 只跑 l1+l2+typecheck:core」。

### 5.6 清理面

- 跑后无残留 bun 服务进程（`tasklist`/`taskkill` 双命名空间核查）；临时目录可删（`rm -rf` 不再被句柄挡住）。
- 仓库根无污染件（`--outfile /dev/null` 的 `nul` 已修；`n-credential.json`/`ops-kb-registry.json` 曾误判为实验遗留——实为 selftest 降级路径写出的污染件，见 §六-8，已修复并加断言）。

### 5.7 v0.16.0 首发 CI 实况与打包门修复（追记 2026-09-26 23:2x–）

- **CI 首次真跑（run #90，<https://github.com/lomehong/oh-my-ops/actions/runs/36251780672>）**：test job **✅ 全步过**（L1、L2、typecheck:core —— POSIX 严格分支首次真机绿）；打包发布 job **❌ 于「打部署包」**，其后「打 kb-enroll 服务包」「发布 Release」均 skipped ⇒ **无 Release 产物**。job 日志端点需鉴权（本机未登录，403），故以 step 结论 + 本机逐字复现定位。
- **根因（本机逐字复现，非推测）**：`cd /tmp`（`release.yml:110`）之后 `LISTED="$(awk '{print $1}' vendor/yuyi-omp-extension.sha256 | head -1)"` 仍按**仓库相对路径**读清单 ⇒ `awk: fatal: cannot open file 'vendor/yuyi-omp-extension.sha256'`、`LISTED` 空 ⇒ 抽验判「不符」⇒ `✗ 发布包内适配器 sha256 与清单不符：ec25ec8e929014ca… ≠ …`、exit 1。复现中 `IN_PKG` 与清单**逐字相同**（`ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751`）——**红的是路径引用，不是产物**。该抽验块由 OMOVENDOR-1（`2f19113`）引入，v0.15.1 早于它，故为「发布门首次真跑」暴露。
- **最小修复**：清单改以 `$GITHUB_WORKSPACE/vendor/…` 绝对路径引用（与同步骤 `mv … "$GITHUB_WORKSPACE/"` 同源），并加「读空即红」`✗ 读不到 vendor 适配器清单：…`（清单存在但为空/不可读时给精确原因；缺文件仍由打包清单断言先红）。
- **修复后本机复现（verbatim）**：从 `release.yml` 逐字抽取两步 run 块（`/e/tmp/pkgrepro/extract.mjs`，禁手抄）在 scratch 工作区（`git archive HEAD` 展开 + `GITHUB_WORKSPACE` 指向 scratch，不触碰仓库根）执行 ⇒ `打部署包` **exit 0**（产出 `oh-my-ops-v0.16.0.tar.gz{,.sha256}`、`install.sh` 落 scratch 根）、`打 kb-enroll 服务包` **exit 0**（含 CIPORT-1 新增 `secret-perm.mjs` 清单项与 `bun -e` 零依赖自检）；包内指纹与清单两行逐字相同。
- **新行未死代码自证（变异）**：scratch 内把清单截为 0 字节 ⇒ `✗ 读不到 vendor 适配器清单：…`、exit 1；复原 ⇒ exit 0、产物齐（`oh-my-ops-v0.16.0.tar.gz` 318 862 B）。
- **修复后全链复跑（本机）**：ci-run6 23:31:22–23:47:31（`START_EPOCH=1790436682`/`END_EPOCH=1790437651`，969s），`TEST_CI_EXIT=0`、✗=0；13 步全跑（自检 14/14、`✓ .github/workflows/release.yml 结构检查通过`（新守卫在内）、vendor-integrity 15/0 含负例红证、web-verify 本机 SKIP 照旧）。
- **结构守卫（新，红→绿自证）**：`scripts/probe-workflow-yaml.sh` 增「run 块内 `cd` 之后的仓库相对路径必须以 `$GITHUB_WORKSPACE` 打底」。**红证**：对 `HEAD:.github/workflows/release.yml`（修前副本，`/e/tmp/wfguard/`）跑 ⇒ 精确命中 `LISTED="$(awk … vendor/yuyi-omp-extension.sha256 …)"`、exit 1；**绿证**：对修后工作树 ⇒ `✓ .github/workflows/release.yml 结构检查通过`、`结果：全绿`（`npm run test:workflow` exit 0）。
- **边界（诚实登记）**：本机复现以合成 `dist/omp-single` 充当品牌断言对象；真实二进制由 CI 构建（run #90 步骤 6「构建 omp 单文件运行时」success、步骤 7 vendor 探针 success，且品牌断言自 OMOBRAND-1 起在 v0.15.1 真跑通过）⇒ 未跑通的分支不在品牌断言。

## 六、真实缺陷登记（产品侧，影响面）

| # | 缺陷 | 影响面 | 修复 |
|---|---|---|---|
| 1 | 凭据 helper 链未重置（系统 helper 先跑） | 所有设备的 kb sync：**慢（57s）且可能取到本机真实凭据** | `kb-sync.ts:134-139` 先置空再挂 store |
| 2 | `hostname -I` GNU-only + pipefail 静默 | 非 GNU 设备的 fleet 服务模式：SAN 取不到则静默失败 | bun IPv4 兜底 + 显式 `die` |
| 3 | `config.env` 落 MSYS 路径 | Windows 端 `--check`/重启后读配置 ENOENT | `native_path()`（cygpath -m） |
| 4 | 接班进程静默消失 | /ui 改配后服务可能不再起来（pid 文件停旧值） | 进程内预检 + detached spawn + 先停监听 + 绑定重试 |
| 5 | 兑换码/秘密文件 0600 硬拦 | Windows 端 enroll 与多处 CLI 整链锁死 | 运行时能力探测 + 降级告警（POSIX 仍硬拒） |
| 6 | `--outfile /dev/null` 落 `nul` | Windows 端跑一次 kb-ui 探针即在仓库根留垃圾 | 产物写 `$TMP` |
| 7 | webhook 写回未检查 `resp.ok`（**待决，未改**） | 真 Gitea 拒写时 PR 无状态/无评论而审计显示已拦截 | 建议见 §3.2-7 |
| 8 | selftest 负例缺省路径落 CWD | 不可表达 0600 的设备：每次 `test:ci`/pre-push 在仓库根写 `n-credential.json`（伪秘密）+ `ops-kb-registry.json` | 负例显式临时 `--registry/--deliver` + 新增「不污染 CWD」断言（`ops-kb-provision.mjs:325-326,333-337`） |

## 七、未兑现 / 待真机

- **release.yml 三处闸门已在首次真跑中兑现**：run #90 中「vendor 适配器回归探针」步骤 ✅；「打部署包」❌ 暴露抽验块的路径缺陷（详见 §5.7），已最小修复 + 结构守卫红/绿自证，**待授权后提交并重发**；「打 kb-enroll 服务包」在 run #90 被跳过（前序红），修复后已在本机逐字复现为绿。
- **POSIX 严格分支未在 Linux 真机复跑**：本机以「强制置位」负例自证（§5.4）；Linux 侧建议下一次 CI/真机顺带实证（预期：`can_express_0600=true` ⇒ 严格断言照跑）。
- **test:install / enroll-install 的 Linux 语义未复跑**：本机全绿，但 0600 严格段按定义只能在 POSIX 上真正生效。
- **test:web-verify 本机 SKIP**（无 Chrome）：有 Chrome 的机器照跑，未实证。
- **`test:l2` 的 60000ms 预算**：本机最慢单项 10.4s；更慢的磁盘/冷缓存机器是否够用未验证。
- **提交/推送/tag（已执行，供事后对账）**：提交 `b61f264`（30 文件，+887/−175）→ 推 main（22:36:41–22:51:41，pre-push 全链通过；远端 API 确证 `refs/heads/main` = `b61f264`）→ tag `v0.16.0` **首推失败**：本地门全绿但推送阶段瞬时报 `RPC failed; curl 35 schannel: failed to receive handshake`（22:51:59–23:07:17，tag 未落地，API 404 确证、CI 未触发）→ **重推成功**（23:08:09–23:23:42，仍走门）⇒ Release CI run #90 触发：<https://github.com/lomehong/oh-my-ops/actions/runs/36251780672>。
- **run #90 结果（已观测）**：test job ✅ / 打包发布 job ❌ 于「打部署包」⇒ **v0.16.0 未产出 Release**。根因 = 抽验块 `cd /tmp` 后的相对路径读清单（§5.7）；修复（清单改 `$GITHUB_WORKSPACE` 绝对路径 + 读空即红）与结构守卫见 §5.7，随本次修复提交入库。
- **重发路径（主人 2026-09-26 决定）**：**删除远端 tag `v0.16.0` 并在修复提交上重打同名 tag**（保持版本号 v0.16.0）。属改写已发布引用，已获明示授权。执行顺序：提交修复 + 记录 → 推 main（过 pre-push 全链门）→ 删远端 tag 并重打/重推 → CI 复跑核验（Release 5 产物）。

## 八、可回源性

| 基准 | 来源 | 说明 |
|---|---|---|
| 枚举红基线 | `/e/tmp/ciport-enum/`（13 份 log + SUMMARY） | 本机临时证据，未入库；每步命令即 `npm run <step>` |
| 全链绿日志 | `/e/tmp/ci-run1.log`…`ci-run6.log` | 同上；含 START/END_EPOCH；#4/#5 为修后冻结严格对（起点=终点=`74f3b320…`）；ci-run6 为打包门修复 + 新守卫的复跑（23:31:22–23:47:31，`TEST_CI_EXIT=0`、✗=0） |
| 关键单步 | `npm run test:l1 / test:l2 / test:install / test:bootstrap / test:kb-ui / test:kb-lint / test:enroll-install / typecheck / test:workflow` | 均可独立重跑 |
| 打包两步逐字复现 | `/e/tmp/pkgrepro/`（`extract.mjs` + `run-steps.sh` + `step-pkg.sh`/`step-kb.sh` + ws 产物） | 从 `release.yml` 逐字抽 step（禁手抄）；scratch 工作区（`GITHUB_WORKSPACE` 指向 scratch），不触碰仓库根 |
| 守卫红/绿证 | `/e/tmp/wfguard/`（修前 release.yml 副本）+ 仓库工作树 | 红证对修前文件（命中 `LISTED…vendor/…`，exit 1）；绿证 `npm run test:workflow`（结果：全绿） |
| CI 首次真跑 | <https://github.com/lomehong/oh-my-ops/actions/runs/36251780672>（run #90） | test job ✅ / 打包 ❌ 于「打部署包」（job 日志端点需鉴权，403）；结论取自 jobs/steps API |
| 收口动作 | 提交 / 推 main / tag / CI 观测 | 见 `git log` 与台账 `docs/tasks/CIPORT-1.yaml`（report 态）；打包门修复为工作树改动（§5.7、§七末） |
| 先例记录 | `docs/designs/omovendor-1-执行记录.md`、`docs/designs/web-verify-执行记录.md` | 防线与真机教训的写法参照 |
