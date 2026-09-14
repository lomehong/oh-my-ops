# OMOINSTALL-2 · H3/H4 可行性探针报告

> 任务：`OMOINSTALL-2`（设计前置硬门，需求包 `docs/requirements/omo-install-selfcontained-requirement-package.md` §4 H3/H4）
> 环境：本容器（bun 1.4.2 / omp npm 包 `@oh-my-pi/pi-coding-agent@18.1.18` / Linux x64）
> 结论：**H3 ✅ 通过（单文件可执行可行）· H4 ✅ 通过（状态目录随 $HOME 重定向）**

## H3：omp CLI 构建为单文件可执行 + 扩展体系行为一致 —— ✅

| 步骤 | 命令/动作 | 结果 |
|---|---|---|
| 取包 | `npm pack @oh-my-pi/pi-coding-agent@18.1.18` → 解包 | dist/cli.js shebang=`#!/usr/bin/env bun`；包内无 `.node`（56MB） |
| 依赖 | `bun install --production`（package 内） | 138 包；`@oh-my-pi/pi-natives` + `pi-natives-linux-x64`（含 `pi_natives.linux-x64-{baseline,modern}.node`，180.8MB/180.7MB） |
| 直接过编译 | `bun build --compile dist/cli.js` | 编译成功（109.8MB），但运行抛 `Unsupported platform`——pi-natives 加载器在编译产物里找不到平台原生件 |
| 根因 | 读 `pi-natives/native/{embedded-addon,loader-state}.js` | `embedded-addon.js` 为上游自动生成占位（`embeddedAddon=null`，注释指向其构建脚本 embed-native.ts）；加载器契约：`files[].filePath` 经 `fs.readFileSync` 读取后落盘加载；`detectCompiledBinary` 认 `$bunfs`/`PI_COMPILED`/embeddedAddon 三者 |
| 修复（管线化） | 按上游 embed-native.ts 产物形状生成 `embedded-addon.js`（asset import 两个 .node，platformTag=linux-x64，version=18.1.18）→ 重编译 | **成功**：`omp-single` 471MB（309→311 模块，两个 variant 全嵌） |
| 行为验证 | `./omp-single --version` | `omp/18.1.18` ✓ |
| 扩展一致性 | `omp-single -e test/runtime/probes/ops-audit-dataplane-probe.ts -p …`（ops 扩展探针） | ✅ session_start 探针产出 out.json：appendEntry/getBranch/收窄/格式化全链路行为与普通模式一致；LLM 回合正常完成 |

**H3 判定：PASS。** 单文件可执行可行；关键管线步骤=「生成 embedded-addon.js（嵌入 .node 资产）→ bun compile」。
**遗留设计项**：471MB 因 baseline+modern 双 variant 全嵌；若需瘦身可只嵌 modern（老 CPU 兼容性让步）或运行期选择——设计期定。

## H4：状态目录随 $HOME 重定向 —— ✅

| 步骤 | 动作 | 结果 |
|---|---|---|
| 重定向启动 | `HOME=/tmp/fakehome omp-single -e <探针> -p …` | 完整启动并完成 LLM 回合（回复 ok） |
| 落点检查 | `find /tmp/fakehome` | 全部状态落在 `/tmp/fakehome/.omp/`（cache/run/natives…）；真实 `~/.omp` 零写入 |

**H4 判定：PASS。** 状态目录严格跟随 `$HOME` → 安装器把 omo 启动器的 `HOME` 指向 `~/.omo`（内含 home 子目录）即实现与原生 omp 的状态面隔离，**无需 fork 改 omp 代码**（H4 的「fork 补丁」分支不触发）。

## 对设计阶段的输入

1. 构建管线 = `bun install → 生成 embedded-addon.js → bun build --compile`（+品牌 patch 正式化）；
2. 体积决策（471MB 双 variant vs 瘦身）→ 设计期定；
3. 隔离方案 = 启动器 `HOME=~/.omo/home` 重定向 + `~/.omo/` 布局设计；
4. H3 探针产物：`/tmp/omp-probe/omp-single`（临时，不进仓）。
