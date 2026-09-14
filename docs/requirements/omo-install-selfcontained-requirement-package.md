# 结构化需求包：自包含安装器——零前置装 omo，与原生 omp 共存

> 来源：主人 2026-09-14 logstash-124 实测阻塞引发，路线已由主人拍板（fork 定制 / 可执行文件进包 / `~/.omo/` 私有目录 / bun 自动装不打包）
> 产出：architect-prd-digest 六项覆盖检查（本文件）
> 状态：**待确认**（自报 ≠ 完成；待确认 T1–T5 清零前不得进入 architect-design）
> 关联：`docs/designs/ops-audit-command-design.md`（OPSAUDIT-2，/ops-audit 已执行）；台账任务：`OMOINSTALL-1`
> 实测链：logstash-124 三连失败（curl:35 TLS 重置 → `vlatest` 404 → 「未找到 omp」）——问题找方案

## 0. 一句话需求

在任意干净 Linux 机器上**一条命令装好 omo**：安装器自动备齐全部运行时（bun 自动装、omp 可执行文件随包携带、全部落 `~/.omo/` 私有目录），不要求、不依赖、不干扰机器上已有（或将来安装）的原生 omp。

## 1. 可验收目标（Acceptance，可观测、可复跑）

| # | 目标 | 验收判据 |
|---|---|---|
| A1 | 零前置自足安装 | 在一台仅有 curl、无 omp/node/bun 的干净 Linux x64 机器上，一条命令完成安装，全程无任何「请先自行安装 X」提示；装后 `omo status` 可用 |
| A2 | 原生 omp 零干扰 | 安装前后：系统 `omp` 命令行为不变（未装则仍无）；`bun pm ls -g`/npm 全局命名空间无新增 omp 条目；`~/.omp` 目录清单 diff 为空 |
| A3 | 状态全量私有化 | 运行时、扩展、AGENTS.md、会话数据全部位于 `~/.omo/`；不写 `~/.omp`（A2 的 diff 即证） |
| A4 | 可执行文件进包 | 发布包内含按主人路线构建的 omp 定制可执行文件；构建管线可复跑（CI 或脚本），产物来源可回溯到 fork/patch 声明 |
| A5 | 升级/卸载干净 | 重跑安装器=升级；卸载=删 `~/.omo/` + `omo` 入口，原生 omp 与 `~/.omp` 不受影响 |
| A6 | bootstrap 健壮性 | 版本解析结果非 semver（如 `latest`）→ 拒绝并换源，不透传下载（vlatest 404 回归用例） |
| A7 | 真实环境实测 | 主人在真实机器以新安装器部署后完成 D-1（S1–S7，`ops-audit-conflict-drill-D1-runbook.md`）判据全过 |

## 2. 范围（Do）

- 安装器（bootstrap.sh + install.sh 重构）：bun 自动安装到 `~/.omo/`（不打包进发布物、不装系统级，R4）；解析 tarball 内预置的 omp 可执行文件落 `~/.omo/`；版本解析加 semver 校验（A6）；沿用多源回退 + sha256 校验 + 魔数校验既有机制
- 构建管线：fork/patch 定制的 omp → 可执行文件产物进发布包（R1/R2）；`patch-omp-brand.mjs` 的定制内容正式化进管线
- 运行时布局：`~/.omo/` 为唯一私有根（运行时/扩展/策略/凭据/会话）；`omo` 启动器指向 `~/.omo` 内运行时；「跟随系统 omp 自愈」机制废除，改为随 omo 自身版本升级（R5④）
- 文档：README 安装段重写（含卸载说明）

## 3. 不做项（Don't，显式排除）

| # | 不做 | 原因 |
|---|---|---|
| D1 | 不升级/不接管/不卸载系统 omp 与其包命名空间 | 主人红线「不能跟原生 omp 冲突」 |
| D2 | 不写 `~/.omp`（扩展、AGENTS.md、会话一律进 `~/.omo`） | 状态面隔离（R5③/A3） |
| D3 | 不把 bun 二进制打进发布包 | 主人明确（R4）；安装器自动装到 `~/.omo` |
| D4 | 首版不做多平台矩阵（macOS/arm 等） | 平台待确认 T2；先覆盖主人实际环境（Linux x64） |
| D5 | 不改产品扩展语义（/ops-audit 等既有验收不变） | 本需求只动交付与运行时承载 |
| D6 | 不做 sudo/系统级安装 | 私有目录自足（R3）；免权限纠纷 |

## 4. 假设（Assumptions，未确认即失效）

| # | 假设 | 依据 | 若不成立的影响 |
|---|---|---|---|
| H1 | 目标机有 curl（root 可写 $HOME） | logstash-124 实测有 curl | 无 curl 的机器超出首版范围（安装前提示） |
| H2 | bun 可经安装脚本/镜像自动装到私有目录（非系统级） | bun 官方安装脚本默认 `~/.bun` 免 sudo；CN 网络需镜像通道（待确认 T3） | 需换通道或降级为「下载 bun 到 ~/.omo」自研逻辑 |
| H3 | omp CLI 可构建为**可执行文件**（如 bun compile）且扩展体系（registerCommand/getBranch/appendEntry）在其中行为一致 | 主人路线要求（R2）；**可行性未验证**——omp 现以 npm 包分发（dist+node_modules），原生模块能否进 compile 未知 | 降级形态：包内携带 dist+node_modules+私有 bun 运行（T1 fallback，需主人预接受） |
| H4 | omp 的状态目录（默认 `~/.omp/agent`）可重定向到 `~/.omo`（env/flag/补丁） | 矩阵 #51：agentDir「默认」`~/.omp/agent/extensions`，暗示可配但**未验证**；不可重定向则需 fork 补丁实现（管线内做） | 隔离破功 → A3 不可验收 → 需 fork 补丁或与主人重新对齐隔离口径 |
| H5 | fork 定制以「上游产物 + 构建期 patch」维护（即 patch-omp-brand.mjs 正式化），非源码级硬改 | 主人原话「就是 patch-omp-brand.mjs 做的事情」 | 若需源码级 fork，上游跟进策略复杂化（T4） |

## 5. 阻断项

**无硬阻断**。H3/H4 为高风险未知，处置：设计前先打可行性探针（omp compile + 状态重定向各一支），探针失败即触发 T1 fallback / 隔离口径对齐——不解除不得出架构方案。

## 6. 待确认（需主人拍板；未清前不得进入 architect-design）

| # | 待确认 | 建议默认 | 影响 |
|---|---|---|---|
| T1 | 可执行形态：omp compile 单文件可行→用它；不可行→是否预接受「dist+node_modules+私有 bun」过渡形态 | compile 可行用 compile；否则接受过渡形态 | 决定 A4 与构建管线形状 |
| T2 | 首版平台矩阵 | 仅 Linux x64 | 交付范围 |
| T3 | bun 安装通道与版本锁定 | 官方安装脚本 + CN 镜像回退（如 npmmirror bun 镜像）；版本锁定（如 bun 1.4.x）写入安装器 | A1 在 CN 网络的可达性 |
| T4 | fork 上游跟进策略 | pin 上游 18.1.x，跟随安全/特性需要按季评估升级 | 长期维护成本 |
| T5 | `main` 合并时机（v0.6.1 教训：Release 正文推荐的 @main 一行命令在 main 合并前仍拉旧 bootstrap） | 本需求产出首个可用安装器后，将已落定工作链合并 main，官方通道自愈 | 官方安装通道正确性 |

## 7. 专项评审触发

| 触发项 | 是否命中 | 理由 |
|---|---|---|
| 高风险变更 | **是** | 交付面整体重塑（安装器/运行时承载）；靠 T1–T5 + 可行性探针收敛 |
| 安全评审 | **是**（轻度） | 安装期下载执行（bun 安装脚本、可执行产物）→ 沿用 sha256 校验 + 官方源/镜像白名单 |
| 合规评审 | 否 | 无 |
| 跨团队 | 否 | 上游 omp 为公共 npm 包，fork 自用 |
| Unknown 多发 | **是** | H3/H4 两条高危未知 → 设计前探针裁决 |

## 8. 六项覆盖检查表

| # | 检查 | 结论 | 证据来源 |
|---|---|---|---|
| ① | 需求覆盖 | ✅ 主人原话逐条归属：fork 定制→Do/管线；可执行文件进包→Do+A4；`~/.omo`→Do/A3；bun 自动装不打包→Do/D3；四条共存硬性→A2/A3/A5 + Do 自愈废除；vlatest bug→A6；D-1 折入→A7。无悬空 | 本文件 §1–§3、§6 |
| ② | 系统覆盖 | ✅ 受影响：bootstrap.sh/install.sh/构建管线/CI release 打包；范围外：产品扩展语义（ops-extension/ops-core 代码不动）；对照 suite-map：oh-my-ops 未收录（单仓），上游 omp 为公共依赖 | suite-map 未收录声明 + §10 E1–E7 |
| ③ | 证据覆盖 | ✅ 关键结论全部回源（§10 E1–E9），含 logstash-124 三连实测与代码行号 | §10 |
| ④ | 风险覆盖 | ✅ 六类过：兼容（原生共存 A2/隔离 H4）/异常（下载失败多源回退+校验）/灰度（首版单平台 T2）/缓存（无）/消息（无）/状态机（升级=重跑，卸载=删目录 A5）+ 安装期执行安全（官方源+sha256） | §4–§5、§7 |
| ⑤ | 验证覆盖 | ✅ A1–A7 可观测可复跑；「如何算完成」= A1–A6 全绿 + A7 主人实测；探针两支（H3/H4）设计前先行 | §1 |
| ⑥ | 不确定性治理 | ✅ H3/H4 高危未知显式登记 + 探针裁决路径；T1–T5 待主人拍板，未擅自补全 | §4–§6 |

### 8.1 五问准入

| # | 问 | 答 |
|---|---|---|
| 1 | 问题与方案匹配 | ✅ 问题找方案：真实机器三连失败（curl:35 / vlatest 404 / 未找到 omp）实证安装链不可用 |
| 2 | 价值依据 | ✅ 真实环境推广的前提——每台目标机都要过安装这一关；且不得破坏已有环境 |
| 3 | 范围受控 | ✅ 只动交付/运行时承载与构建管线；产品扩展语义 D5 排除 |
| 4 | 复用优先 | ✅ Reuse：多源回退+校验（bootstrap 既有）、品牌化 patch（patch-omp-brand/build-mirror 既有）、install.sh 骨架；Build：仅「omp 可执行构建管线、私有 bun 自动装、状态隔离」三件 |
| 5 | 可逆/可回滚 | ✅ 全部落 `~/.omo`：卸载=删目录；不动系统；git revert 即回滚安装器 |

## 9. 准入结论

**有条件通过（Conditional Pass）。**
- 六项覆盖齐备、五问通过、无硬阻断；
- **停止条件**：① H3/H4 可行性探针（omp 可执行构建 / 状态目录重定向）设计前必须先行，失败即触发 T1 fallback 与隔离口径对齐；② T1–T5 未清零不得进入 architect-design；
- 本文件为自报产出，落定以主人确认为准（纪律 1）。

## 10. 证据表

| # | 结论 | 来源 |
|---|---|---|
| E1 | 现状安装第一关=找系统 omp，找不到即死 | `scripts/install.sh:51`；logstash-124 实测「✗ 未找到 omp」 |
| E2 | 品牌镜像=拷贝系统 omp + node_modules 软链指向系统 | `scripts/install.sh:7`、`:107`（build-mirror.sh）；`build-mirror.sh` 三种 node_modules 布局注释 |
| E3 | 启动器自愈=跟随系统 omp（版本契约握在系统侧） | `scripts/install.sh:136`（系统 omp 较新→重建镜像） |
| E4 | 扩展与 AGENTS.md 写入共享 `~/.omp/agent` | `scripts/install.sh:22-23,92`、`:248`（AGENTS_DST） |
| E5 | bootstrap 版本解析无 semver 校验，`latest` 被透传 | `scripts/bootstrap.sh:87`（basename url_effective）、`:92`（补 v 前缀）；logstash-124 实测 `vlatest` 404 |
| E6 | omp agentDir 默认 `~/.omp/agent/extensions`（重定向能力未验证） | `docs/reports/pi-vs-omp-host-capability-matrix.md` #51 |
| E7 | 分发形态=npm 包（dist+node_modules），运行底座=bun | 知识库 `practice/omp-extension-contract-pitfalls.md` 头注（npm 分发 @oh-my-pi/pi-coding-agent）+ adapter oh-my-pi.md（bun 全局安装）；CI 用 setup-bun |
| E8 | logstash-124 实测三连 | 主人贴回日志：curl:35（TLS 重置）→ `vlatest` 404 → 「未找到 omp」（2026-09-14） |
| E9 | bun 官方安装默认落 `~/.bun`（免 sudo 私有目录），支持自定义安装位置 | bun 官方安装机制（设计期复核具体 flag） |
