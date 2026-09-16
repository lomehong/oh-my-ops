# OPSP-P21 执行记录 — SshPool host key 策略 + PathGuard 真实 home 机密根

> 任务号：OPSP-P21 ｜ 分支：`feature/OPSP-P21`
> 来源：对端 `sec-agent-manager-172-26-5-121`（v0.9.2 官方件）续报缺陷 5/6；我方逐条回源复核后确认成立

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| S1 | 支持 accept-new（OpenSSH ≥7.6）→ 带 `StrictHostKeyChecking=accept-new` + 受管 `UserKnownHostsFile` | `node --test packages/ops-core/test/ssh.test.ts` | 红：`wrap()` 无任何 host key 选项；绿：两项齐备且 `hostKeyPolicy().mode === "accept-new"` |
| S2 | 不支持（el7 仅 7.4）→ 退化为 `no` + 受管 known_hosts（仍记录指纹） | 同上 | 绿：`mode === "no+managed-known-hosts"` |
| S3 | 调用方 `options` 可覆盖（OpenSSH「首值生效」→ 默认项须排在 caller 之后） | 同上 | 绿：caller 项索引 < 默认项索引 |
| S4 | HOME 重定向下，**真实 home 的 `.ssh` 仍在机密根**（ops_file_ls 被拒） | `bun test packages/ops-extension/test/read-tier-structure.test.ts` | 红：可列出（漏出）；绿：抛 `机密根` |
| S5 | 全量门 | `npm run test:ci` | 全绿 |

## 二、根因与落点

| 缺陷 | 根因 | 落点 |
|---|---|---|
| ⑤ SshPool host key「文档承诺 TOFU、实现没有」 | `SshConfig`/类注释承诺 `accept-new`，但 `baseOptions()` 无 `StrictHostKeyChecking`/`UserKnownHostsFile`；el7 默认 `ask` + `BatchMode=yes` → 首连直接失败（且 `accept-new` 需 OpenSSH ≥7.6，直接补会在 el7 被拒） | `packages/ops-core/src/ssh.ts`：新增 `sshSupportsAcceptNew()`（`ssh -G -o StrictHostKeyChecking=accept-new localhost` 探测，缓存）+ `SshPool.hostKeyOptionList()` 退化策略（≥7.6 → `accept-new`；否则 `no`）+ **两种情形都配受管 `UserKnownHostsFile=<controlDir>/known_hosts`**（首连即记录指纹，保住「首次信任并记录」语义）+ `hostKeyPolicy()` 可观测 + 注释与实现对平；调用方 `options` 因排在默认项之前而**可覆盖** |
| ⑥ PathGuard 机密根漏真实 home `.ssh` | `home = process.env.HOME ?? os.homedir()`，而 POSIX 下 `os.homedir()` **优先 `$HOME`** → omo 把 HOME 重定向后 `join(home,".ssh")` 与 `join(os.homedir(),".ssh")` 塌缩为 `~/.omo/home/.ssh`，真实用户 home 的 `.ssh` 落在 secret/trust 之外 | `packages/ops-extension/src/context.ts`：新增 `realUserHome()`（`os.userInfo().homedir`，getpwuid 口径；异常退回 `$HOME`），机密根改用真实 home 的 `.ssh` |

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 红⑤ | `git show HEAD:packages/ops-core/src/ssh.ts \| grep -c "StrictHostKeyChecking\|UserKnownHostsFile"` → **1**（且唯一命中是 `SshConfig.options` 的注释示例；实现里 0 处） |
| 红⑥ | `HOME=/tmp/fakehome node -e …` → `os.homedir()= /tmp/fakehome`；`旧实现两路径塌缩= true`；`getpwuid 真实 home= /home/pi`（真实 home 确实漏出） |
| 绿 | `node --test ssh.test.ts` → 10 pass / 0 fail（含 S1–S3 三例）；`bun test read-tier-structure.test.ts` → 6 pass（含 S4） |
| 全量门 | `npm run test:ci` 全绿（L1 135 pass；L2 52 pass ×4 文件；typecheck:core；install/bootstrap 守卫） |
| 类型门 | 首轮暴露 `ssh.ts` 缺 `execFileSync` 导入 → 已补，typecheck 通过 |
| **el7 现场证据（对端提供）** | 对端控制节点（CentOS/RHEL 7，OpenSSH 7.4）实测：宿主 harness 的 ssh:// 通道报 `command-line line 0: unsupported option "accept-new"`（**配置解析阶段即失败**）→ 该节点上 `ssh -G -o StrictHostKeyChecking=accept-new` 必然判不支持，我方 SshPool 将走 **`no` + 受管 known_hosts 退化分支**（与其版本推断一致）。注：该报错源自宿主 harness、非 omo；对本仓而言是「el7 上 accept-new 不可用」的现成现场证据 |

## 四、未兑现项

- **真机复验**：el7 控制节点的 `ssh -G` 探测结论已由对端现场证据**间接确认**（accept-new 不可用 → 走退化分支）；**首连后 `known_hosts` 落盘路径**仍待对端复验——其 controlDir（`$HOME/.ops-pi/ssh`，launcher 重定向后为 `~/.omo/home/.ops-pi/ssh`）当前为空目录且 `policy.json` 无目标授权，需等其升级 v0.9.3 + Owner 授权白名单 + 配置目标主机后回报。
- **未实现（登记）**：对端建议的「首连后 `ssh-keyscan` 指纹落审计」未做——受管 `known_hosts` 已提供「记录」语义，指纹入审计属增强项，留待需要时再评估。
- **文档口径确认**：`dirname(configPath)`（~/.omo/home/.ops-pi）在 trust 列表内 → vault 配置（含 `dbPath`）**设计上写拒、只能 Owner 手工落盘**；已在对端回信中确认，供其文档按此写。
- **跨任务未修**：启动时 7 条 `Custom tool load failed`（宿主扫描 `$EXT/ops-pi/tools/*.ts`）。
- **真机 18 项矩阵复验**：随 `OPSP-P20` 的 read 档修复一并在 v0.9.3 后由对端重跑。
