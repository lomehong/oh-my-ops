# OPSP-P23 执行记录 — 错误回显可读性（长失败输出尾部结论）+ 受限网络取包说明

> 任务号：OPSP-P23 ｜ 分支：`feature/OPSP-P23` ｜ 改动件：`packages/ops-extension/src/tools/exec-output.ts`、`scripts/bootstrap.sh`（头注）、`packages/ops-extension/test/read-tier-structure.test.ts`
> 来源：对端 `sec-agent-manager-172-26-5-121` v0.9.5 复验通过后附带的低优先观察（非缺陷 8 未修好）

## 一、测试清单

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| E1 | 长失败输出保留尾部结论 | `bun test packages/ops-extension/test/read-tier-structure.test.ts` | 红：只取前 5 行 → traceback 全是栈帧、`Cannot connect to the Docker daemon` 被截；绿：头 5 + `…(省略 N 行)…` + 尾 3，尾部结论可见 |
| E2 | 短输出原样 | 同上 | 绿：≤8 行不加省略标记 |
| E3 | 全量门 | `npm run test:ci` | 全绿 |

## 二、根因与落点

| 项 | 根因 | 落点 |
|---|---|---|
| 尾部结论被截 | `fmtExecResult` 失败分支只回显 stderr **前 5 行**（为防 docker usage 转储淹没上下文而限行）；而 compose v1（PyInstaller 单文件）在 daemon 不可达时吐 **traceback**，可行动结论在**最后一行** | `exec-output.ts`：`clip()` 改为「≤8 行原样；否则头 5 + `…(省略 N 行)…` + 尾 3」 |
| 受限网络取包无说明 | 对端实测其网络**按主机放行**（`github.com:443` 不通，`api.github.com` / `objects.githubusercontent.com` / `codeload.github.com` / 镜像站可用）→ 直连 release 资产失败 | `scripts/bootstrap.sh` 头注补 API 资产端点取包示例（`Accept: application/octet-stream` + asset id），同一产物同一哈希（纯文档，无行为变更） |

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 绿（单元） | `bun test read-tier-structure.test.ts` → **14 pass / 0 fail**（含长输出形态断言：头/省略/尾可见、中段 `L10` 省略；traceback 用例断言 `Cannot connect to the Docker daemon` 可见） |
| 全量门 | `npm run test:ci` 全绿（L2 60 pass ×4 文件） |
| 语法 | `bash -n scripts/bootstrap.sh` PASS |

## 四、未兑现项

- **真机复验**：对端升级下一版后复验「daemon 不可达 + compose v1」场景——期望一眼可读（尾部 `Cannot connect to the Docker daemon …` 可见）；其 dockerd 当前 stopped+disabled，其复验时若 daemon 起来则同时可验「回退执行返回真实结果」。
- **发布**：需 v0.9.6（待主人授权打 tag）。
- **已知未修**：7 条启动噪音（跨任务登记）。
