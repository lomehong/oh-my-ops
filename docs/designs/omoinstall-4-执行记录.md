# OMOINSTALL-4 执行记录 — v0.9.0 生产回归热修（安装器）

> 任务号：OMOINSTALL-4 ｜ 分支：`feature/OMOINSTALL-4` ｜ 改动件：`scripts/install.sh`、新增 `scripts/probe-install-ops-core.sh`、`package.json`
> 触发：对端 `omo-172-26-5-121`（设备 `sec-agent-manager-172-26-5-121`）装上 **v0.9.0** 后报告 ops 通道全断（2026-09-16 12:42）

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| G1 | 干净机安装后 core 布局正确 | `bash scripts/probe-install-ops-core.sh` 场景 1 | 旧件：`core/package.json` 缺失、`core/src` 缺失（靠扁平拷贝侥幸可用）；新件：两者就位且解析含 `AuditLog` |
| G2 | **升级路径**（core 目录已存在旧平铺文件）解析正确 | 同上场景 2 | 旧件：解析出 `CredentialVault` 旧导出 + 旧文件残留（**对端生产症状**）；新件：解析含 `AuditLog`、旧文件已清理 |
| G3 | 启动器 serve 后台分支 `$0`/`$@` 不被生成期展开 | 同上场景 3 | 旧件：写死安装器临时路径（`/tmp/.../install.sh`）；新件：保留字面量 `exec "$0" --profile ops "$@"` |
| G4 | 全量门 | `npm run test:ci`（已纳入 test:install） | 全绿 |
| G5 | 既有 vendor 修复不受影响 | `node scripts/probe-yuyi-reply-frame.mjs` | 15 通过 / 0 失败 |
| G6 | 语法门 | `bash -n scripts/install.sh` | PASS |

## 二、根因与落点

| 缺陷 | 根因 | 落点（改动前 → 后） |
|---|---|---|
| ① ops 全灭（升级路径） | `cp -r <src> <dest>` 语义不对称：dest 不存在 → 扁平拷贝（可用）；dest **已存在** → 生成 `dest/src/`，旧平铺 `index.ts` 仍在并赢得裸 import 解析 → 新扩展要 `AuditLog` 失败 → 扩展整体不加载 | `scripts/install.sh:173` 单行 `cp -r .../ops-core/src ...` → 整包替换（`rm -rf` + 拷 `package.json` + `src/`） |
| ② `omo serve` 后台失效 | 启动器生成用**未加引号 heredoc**，其展开不认单引号 → `$0`/`$@` 在生成期被替换为安装器自身路径与参数 | `scripts/install.sh:237` → 转义 `\$0`/`\$@`（并加注释说明 heredoc 陷阱） |

> heredoc 全量审计：该 heredoc 内未转义 `$` 仅 5 处——`$OMO_DIR`/`$REAL_HOME`/`$HOME_DIR` 为**有意**的安装期常量，`$0`/`$@` 为缺陷（已修）。

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 红（旧安装器 = v0.9.0 `HEAD:scripts/install.sh`） | `bash scripts/probe-install-ops-core.sh --installer /tmp/install-old.sh` → **7 项失败**；其中场景 2 打印 `升级后解析异常（回归复现）：CredentialVault` —— 与对端日志症状一致 |
| 绿（修复后） | 同命令（默认安装器）→ **全绿**（10 项断言） |
| 全量门 | `npm run test:ci`（L1 + L2 + typecheck:core + **test:install**）全绿 |
| 既有修复未回退 | yuyi 夹具 15/15 |
| 语法 | `bash -n scripts/install.sh` PASS |
| **v0.9.1 发布包全量复验** | 下载 `oh-my-ops-v0.9.1.tar.gz`（127,523,222B）→ `sha256sum -c` 对发布侧 `.sha256`（`7f2b5beb…`）**OK**；包内 `scripts/install.sh` 含 `CORE_DST`×5 与启动器转义修复；包内 `vendor/yuyi-omp-extension.js` md5 `5f4df589…`（yuyi 修复保留）；包内含 `scripts/probe-install-ops-core.sh` 与 `omp-single` |

## 四、未兑现项

- **v0.9.1 发布**：✅ 已完成（tag `v0.9.1` → 主干 `18b47b0`；CI run 35059903972 两 job success；发布包全量复验通过，见 §三）。
- **对端验收**：对端以 `ops_*` 工具可用 + `omo serve` 后台可用为验收；本记录提交时对端尚未执行（其变更需 Owner 预授权）。
- **未修（已登记）**：启动时 7 条 `Custom tool load failed: "Tool must export a default function"` 噪音（宿主把 `$EXT/ops-pi/tools/*.ts` 当自定义工具扫描）——既有、非本次病因，需先确认宿主扫描规则再定修法。
- **止血已同步对端**：`rm -rf .../@ops-pi/core` 后重装，或 `core/` 根加 `export * from "./src/index.ts";` shim（两条我均本地验证等价可用）。
