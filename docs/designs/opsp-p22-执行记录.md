# OPSP-P22 执行记录 — compose 探测缺陷 8（执行探测 → 存在性探测）

> 任务号：OPSP-P22 ｜ 分支：`feature/OPSP-P22` ｜ 改动件：`packages/ops-extension/src/tools/docker-k8s.ts`、`packages/ops-extension/test/read-tier-structure.test.ts`
> 来源：对端 `sec-agent-manager-172-26-5-121` 装 v0.9.4 后复跑 —— 缺陷 7 **确认修复**；④ 分支化部分生效但「两者皆无」分支未走到（缺陷 8）

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| C1 | v1 二进制不存在（spawn 抛错）时仍落到「两者皆无」建议分支 | `bun test packages/ops-extension/test/read-tier-structure.test.ts`（新例：`ThrowOnComposeRunner`） | 红：异常穿透 → `[EXEC_FAILED] 命令执行失败：docker-compose`（对端实测形态）；绿：输出平台分支建议 |
| C2 | v1 用存在性探测（不执行本体） | 同上（调用序列断言） | 绿：`["docker","compose","version"]` → `["sh","-c","command -v docker-compose"]` →（命中才执行） |
| C3 | 全缺分支可达且建议按 CLI 版本分支 | 同上 | 绿：含「18.09」+「无 CLI 插件机制」+「standalone docker-compose v1」 |
| C4 | v2 缺、v1 在 → 自动回退执行 | 同上 | 绿：`docker-compose -f … ps` |
| C5 | 版本解析健壮（18.09.6 / 24.0.7 版式） | 同上（两例分别覆盖老/新 CLI） | 绿：老平台给 v1 建议；新平台给 v2 插件建议 |
| C6 | 全量门 | `npm run test:ci` | 全绿 |

## 二、根因与落点

| 缺陷 | 根因 | 落点 |
|---|---|---|
| ⑧ 「两者皆无」分支不可达 | v1 探测写成**执行** `docker-compose version`；而本仓 `ShellExec` 在二进制不存在时**抛 `EXEC_FAILED`（spawn ENOENT）而非返回非 0** → 异常穿透工具边界，绕过建议分支（对端实测返回 `[EXEC_FAILED] 命令执行失败：docker-compose`） | `docker-k8s.ts`：探测统一包 `try/catch`（spawn 失败视作不可用，`code=-1`）；v1 改为 **`sh -c 'command -v docker-compose'` 存在性探测**（不执行本体）；`docker --version` 解析健壮化（`/version[,\s]+v?(\d+)\.(\d+)/i`，兼容 `18.09.6, build …` 与 `24.0.7, build …`） |

> 同类机制的旁证：CI 早期在无 `ps` 二进制的容器里同样得到 `[EXEC_FAILED] 命令执行失败：ps` —— 证实「二进制缺失 = 抛错」而非「退出码非 0」，故一切**可选依赖的探测都必须包 try/catch 或改用存在性探测**。

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 红（对端实测） | v0.9.4 上返回 `[EXEC_FAILED] 命令执行失败：docker-compose`（与 kubectl 缺失同形态），未进入建议分支 |
| 绿 | `bun test read-tier-structure.test.ts` → **13 pass / 0 fail**（含新增 `ThrowOnComposeRunner` 例：断言全程不再直接执行 `docker-compose` 探测） |
| 全量门 | `npm run test:ci` 全绿（L2 59 pass ×4 文件） |
| 对端交叉核验 | 其独立核验 v0.9.4 发布事实（published 08:46:20Z、install.sh 7537B、tarball 127,526,112B）与我方一致 |

## 四、未兑现项

- **真机复验（对端已排期，非阻塞）**：对端 2026-09-16 09:29 说明——复验安排在**其部署交接窗口之后**：① 升级需重启会话（由 Owner 执行），当前窗口升级会把主链路卡在重启上；② 缺陷 8 属**错误提示分支**，不阻塞其任何主链路。届时按我方两点回报（v2/v1 皆缺 → 分支化文案、不再 spawn ENOENT 穿透；装 v1 单文件 → 自动回退执行）。
  - 对端环境价值：其 el7 控制节点**无任何 compose 形态**（v1/v2 皆无）→ 正是场景 ① 的原生复现环境；场景 ② 需其先装 v1 单文件（CLI 18.09.6 无插件机制，只能 standalone）。
- **真机复验结果（对端 2026-09-16 10:04 回报）：两点全部通过 ✅**
  - ① v2/v1 皆缺 → 分支化文案如期（不再有 `[EXEC_FAILED] …：docker-compose` 穿透）；代码级核验 probe() try/catch、`command -v` 存在性探测、版本正则在其 `Docker version 18.09.6, build …` 上正确解出 `18.09`。
  - ② 其按红线纪律装 compose v1（1.29.2 单文件，12,737,304B，sha256 `f3f10cf3…` 校验通过）→ `ops_docker_compose(ps)` **自动回退执行** `docker-compose -f … ps`，返回 compose 本体输出（exit=255 + compose 报错），不再走「不可用」分支。
  - 附带观察（非缺陷 8 未修好，属「错误形态」家族新成员）：compose v1 在 daemon 不可达时吐 PyInstaller traceback，而回显只取 stderr 前 5 行 → 结论在尾部被截 → 已立项 **OPSP-P23** 修复（长输出改「头 5 + 省略 + 尾 3」）。
  - 环境事实（对端）：其网络**按主机放行**（`github.com:443` 不通，`api.github.com` 等可用）→ 可用 API 资产端点取同一产物；已写入 bootstrap 头注（OPSP-P23）。
- **缺陷 7 收口**：✅ **已收口（对端 2026-09-16 09:10 正式回执）**。依据：实测返回含 `exitCode:1` / `stderr:"No journal files were opened due to insufficient permissions."` / `note`；代码级核验 `JournalctlResult` 三字段齐、`stderr===""` 时不产出 note。对端业务结论：其 [INFERENCE] 升级为实测事实，并据此判定「容器日志走 json-file 落盘 → 影响可控」，已写入其 Runbook。
- **对端知识沉淀（供互相印证）**：其对本次事件立了 KB 条目 `omo-upgrade-breaks-ops-channel`，含现象/根因（`cp -r` 不对称 + 目录索引赢得解析）/两种止血/正式修复（v0.9.1 整包替换 + 启动器转义）/18 项矩阵/el7 平台约束（OpenSSH 7.4 无 accept-new、Docker CLI 18.09.6 无插件机制、git 1.8.3.1 无 GIT_SSH_COMMAND、journal 易失）/遗留规避（单路径 log_grep、docker_ps 空输出、journalctl 空结果三类不可信）。
- **环境侧建议（不属缺陷）**：对端需 Owner 侧两项变更才能让系统日志可读可回溯——加入 `systemd-journal` 组 + 启用持久化（现仅 `/run/journal`，重启即丢）；其容器日志走 json-file 落盘，影响可控。
