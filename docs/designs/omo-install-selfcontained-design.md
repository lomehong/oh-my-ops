# 可执行技术方案：自包含安装器——omo 零前置部署与原生 omp 共存

```yaml
---
title: omo 自包含安装器——fork omp 定制单文件运行时 + ~/.omo 私有域 + bun 自动装
status: 已落定        # 草稿 → 已评审 → 已落定（主人确认后） → 已执行
requirement: docs/requirements/omo-install-selfcontained-requirement-package.md（OMOINSTALL-1，已落定；T1–T5 已拍板）
author: omp-architect（omp_1c3610f27a3f）
created: 2026-09-14
review:
  score: 0
  conclusion: 待评审
---
```

## 0. 一句话与五问速答

| 五问 | 速答 |
|---|---|
| 改哪里？ | `scripts/`（bootstrap.sh/install.sh/构建管线 `scripts/build-omp-runtime.sh` 新增）、CI release 打包、`patch-omp-brand.mjs` 正式化进管线；产品扩展代码零改动 |
| 为什么改？ | 真实环境安装三连失败（curl:35 / vlatest 404 / 未找到 omp）：当前安装硬依赖「系统预装 omp ≥18.1.18」，且与原生 omp 共享 `~/.omp/agent` 状态面——推广不可持续（E1–E5） |
| 影响谁？ | 交付/运行时承载全变：运行时+扩展+状态全进 `~/.omo/` 私有域，新增公开命令仅 `omo`；产品扩展语义不变；原生 omp 零接触 |
| 如何验证？ | 干净容器/干净 HOME 实测一条命令安装 → A1–A6 判据逐条核对 → 主人真实环境（logstash-124）装新版并完成 D-1（A7） |
| 还有什么没有确认？ | 2 条：C1 双 variant 全嵌 471MB vs 仅 modern ~290MB（体积/老 CPU 兼容取舍，待主人定）；C2 目标机若无 `~/.local/bin` PATH 需安装器追加（登记边界） |

## A. 架构链路分析（前置）

### A.1 安装链路（新）

```
curl -fsSL …/releases/latest/download/install.sh | bash     ← install.sh = 固定版 bootstrap（制品，非 @main）
  → [1] 解析版本（semver 校验，非法即换源——A6）
  → [2] 下载发布包（多源回退 + sha256 + 魔数校验，复用既有机制）
        包内：omp-single（预编译单文件）+ scripts/install.sh + examples + README
  → [3] install.sh：
      a. 自动装 bun 1.4.x → ~/.omo/bin/bun（官方脚本直连 → 镜像回退；已装且版本匹配则跳过）
      b. 布局 ~/.omo：runtime/omp-single、home/（= omp 的 HOME，状态根）、extensions/、bin/omo 启动器
      c. ~/.local/bin/omo 软链（PATH 唯一新增公开命令）
  → [4] 验证：omo status 可用；~/.omp 不存在/未被触碰（A2/A3）
```

### A.2 运行链路

```
omo（启动器）
  export HOME=~/.omo/home            ← 状态隔离唯一机制（H4 探针实证：全部状态落 $HOME/.omp）
  exec ~/.omo/runtime/omp-single \
    --profile ops \
    -e ~/.omo/extensions/ops-pi/index.ts \
    -e ~/.omo/home/…/yuyi（如启用） "$@"
```
- 扩展发现：显式 `-e` 指向 `~/.omo` 内副本（不走 `~/.omp/agent/extensions` 自动发现——该目录随 HOME 重定向后本就不存在，天然隔离）
- 品牌化：omp-single 构建期由 `patch-omp-brand.mjs` 打品牌（正式化，运行期不再 patch）
- 版本契约：omp-single 由 pin 的上游 18.1.18 构建（T4），自愈机制废除，升级=重跑安装器/`omo upgrade`

### A.3 构建管线（CI/本地同一入口）

```
scripts/build-omp-runtime.sh：
  1. npm pack @oh-my-pi/pi-coding-agent@<pin 18.1.18>（sha256 pin 在 repo，防上游漂移）
  2. 解包 + bun install --production
  3. 生成 embedded-addon.js（嵌入 pi-natives-linux-x64 双 .node，H3 探针已验证形状）
  4. patch-omp-brand.mjs 品牌化（正式化）
  5. bun build --compile dist/cli.js --outfile omp-single
  6. 产物 + sha256 进 Release assets（平台后缀 -linux-x64）
```

### A.4 影响面与降级

- **原生 omp**：零接触——不读不写不升级 `~/.omp`，不动全局包命名空间（A2 diff 为空验收）
- **缺席降级**：目标机无 bun → 安装器自动装（A1）；`~/.local/bin` 不在 PATH → 安装器打印追加指引（C2）；网络全断 → 多源回退失败后给手动包路径（既有行为）
- **守卫纪律/访客红线**：不涉及会话/渠道访客面——不适用（安装器域）
- **一致性边界**：`~/.omo` 是唯一写入域（+`~/.local/bin/omo` 一个软链）；无跨系统接口

## 1. 需求覆盖（10 分）

### Do（做）

| # | 需求条目 | 方案响应 | 来源 |
|---|---|---|---|
| 1 | fork omp 定制正式化（R1） | 构建管线 `build-omp-runtime.sh`：pin 18.1.18（sha256 pin）+ 品牌化 patch 正式化（T4 pin 策略） | 主人原话/需求包 Do |
| 2 | 可执行文件进包（R2） | `bun build --compile` 单文件 `omp-single` 进发布包（H3 探针 ✅：471MB 可跑、扩展行为一致） | R2/H3 |
| 3 | 私有目录 `~/.omo/`（R3） | 唯一私有根：runtime/home/extensions/bin 全在其下；状态经 HOME 重定向落 `~/.omo/home/.omp`（H4 ✅） | R3/H4 |
| 4 | bun 自动装、不打包（R4） | 安装器 a 步：官方脚本直连→镜像回退，锁 1.4.x，落 `~/.omo/bin/bun`（T3 拍板） | R4/T3 |
| 5 | 零前置（R5①） | A1：干净机一条命令，无「请先自行安装」 | A1 |
| 6 | 不碰原生（R5②） | A2：`~/.omp` diff 空 + 全局命名空间无新增 + 系统 omp 不被触碰 | A2/D1 |
| 7 | 版本契约自我兜底（R5④） | pin 构建 + 自愈机制废除，升级=显式重跑安装器/`omo upgrade` | E3 反转 |
| 8 | vlatest bug（R6） | 版本解析 semver 校验：`/^[0-9]+\.[0-9]+\.[0-9]+$/` 不匹配→换源（bootstrap 与 install.sh 双侧） | A6/E5 |
| 9 | D-1 折入验证（R7） | A7：主人以新安装器部署后跑 S1–S7 判据 | A7 |

### Don't（不做，显式排除）

| # | 排除项 | 排除原因 |
|---|---|---|
| 1 | 不升级/接管系统 omp 与全局命名空间 | D1/主人红线 |
| 2 | 不写 `~/.omp` | D2/状态隔离 |
| 3 | 不把 bun 打进发布包 | D3/R4 |
| 4 | 不做 macOS/arm 首版 | D4/T2 |
| 5 | 不改产品扩展语义 | D5 |
| 6 | 不做 sudo/系统级安装 | D6 |
| 7 | 不保留「跟随系统 omp 自愈」 | 与版本契约自我兜底冲突（R5④） |

### To Confirm（待确认）

| # | 待确认项 | 问谁 | 状态 |
|---|---|---|---|
| C1 | omp-single 体积：双 variant 全嵌 471MB vs 仅 modern ~290MB（老 CPU 兼容性让步） | 主人 | 待定（设计不阻塞：默认全嵌，瘦身另排） |
| C2 | 目标机 PATH 无 `~/.local/bin` 时仅打印指引不代改 shell 配置 | 主人 | 默认打印指引 |

## 2. 系统覆盖（10 分）

| 服务/插件/仓库 | 变更类型 | 关键依赖 | 缺席降级影响 |
|---|---|---|---|
| oh-my-ops `scripts/` | 增 `build-omp-runtime.sh`；改 bootstrap.sh（semver 校验）/install.sh（布局重写） | bun 1.4.x（编译+运行时）、上游 omp 18.1.18 npm 包（sha256 pin）、GitHub Release 通道 + 镜像 | 上游包不可达 → 构建失败（CI 显式红）；安装网络断 → 多源回退+手动包指引 |
| oh-my-ops CI（release.yml） | 改：打包清单加入 omp-single（按平台后缀）；test 岗加 audit-view.test.ts | GitHub Actions | CI 红 → Release 不出（天然门禁） |
| oh-my-ops 产品扩展（ops-extension/ops-core） | **不动** | — | — |
| 原生 omp / `~/.omp` | 不动（零接触） | — | — |
| 上游 oh-my-pi | fork 关系（pin 18.1.18，不推动上游） | — | 上游安全更新 → 季度评估升级（T4） |

- 范围外参与方：无（单机安装域）。
- 对照 suite-map：oh-my-ops 未收录（单仓试点），无跨系统接口，无遗漏声明。

## 3. 证据覆盖（10 分）

| 关键结论 | 证据类型 | 证据出处 | 核对人 |
|---|---|---|---|
| omp 可构建为单文件且扩展行为一致 | Code+实测 | `docs/reports/omo-install-probes.md` H3（omp-single 471MB；`--version`=omp/18.1.18；数据面探针全链路一致） | 本方实测；dsh 评审复核 |
| 状态目录严格随 $HOME | Code+实测 | 同上 H4（fakehome 全量落点 + 真实 `~/.omp` 零写入） | 本方实测 |
| 现状硬依赖系统 omp | Code | `install.sh:51`；logstash-124 实测 | logstash 实测 |
| 共享状态面冲突 | Code | `install.sh:22-23,92,248`（extensions/AGENTS.md → `~/.omp/agent`） | 需求包 E4 |
| 自愈=跟随系统 omp（废除对象） | Code | `install.sh:136` | 需求包 E3 |
| vlatest 透传 bug | Code+实测 | `bootstrap.sh:87,92`；logstash-124 实测 404 | logstash 实测 |
| 多源回退+校验机制可复用 | Code | `bootstrap.sh:32-66`（valid_download/fetch）；v0.6.1 实测（老 curl 模拟端到端过） | 本方实测 |
| 原生件嵌入契约 | Code | `pi-natives/native/embedded-addon.js`（AUTOGENERATED）+ `loader-state.js`（files[].filePath→readFileSync→落盘；detectCompiledBinary 认 $bunfs/PI_COMPILED/embeddedAddon）。注：两文件位于**构建期依赖树**（探针期 /tmp/omp-probe/package，不进仓）；持久证据=探针报告 §H3 根因段 | 本方实测 |
| bun 官方安装默认私有目录 | Config | bun 官方安装脚本（`~/.bun` 免 sudo）；T3 拍板锁 1.4.x | 主人拍板 |
| 品牌化 patch 既有能力 | Code | `scripts/patch-omp-brand.mjs`、`build-mirror.sh`（正式化对象） | 现状安装器 |

> 四层装载记录：业务层=主人实测链+四要素路线（本包 §0/来源）；架构层=suite-map（未收录本仓）+联邦原则（显式降级三要素→A.4）；系统层=install.sh/bootstrap.sh/build-mirror.sh/CI yml 代码；基建层=`practice/omp-extension-contract-pitfalls`（npm 分发形态）+ bun/omp 版本事实（CI setup-bun latest→现锁 1.4.x 的差异在 §4 兼容行声明）。未发现知识与代码冲突。

## 4. 风险覆盖（10 分）

| 风险类 | 有无涉及 | 分析与对策 |
|---|---|---|
| Compatibility 兼容 | 有 | ① 原生共存：`~/.omo` 私有域 + 零接触 `~/.omp`（A2 验收）；② 上游漂移：pin+sha256（T4）；③ 老 curl：能力探测（v0.6.1 已修，回归用例保留）；④ CI bun latest vs 锁 1.4.x：CI 改用同锁版本，消除「构建/运行时版本分裂」 |
| Exception 异常 | 有 | 下载失败→多源回退+手动指引（既有）；bun 安装失败→显式失败+镜像重试；安装中断→`~/.omo` 原子布局（先临时目录后 rename），不留半成品；`omo` 对损坏运行时 fail-soft 报错指向重装 |
| Cache 缓存 | 不涉及 | 无缓存层；bun cache 落 `~/.omo/home/.bun`（私有域内） |
| MQ 消息 | 不涉及 | 无 |
| State 状态机 | 有 | 升级=重跑安装器（版本对比后替换 runtime，状态/策略保留）；卸载=删 `~/.omo`+软链；`~/.local/bin/omo` 覆盖前检测同名非本产品文件则拒绝并提示（防误伤） |
| Security 安全 | 有（轻度） | 安装期执行外来二进制 → sha256 校验（Release assets）+ 官方源/镜像白名单（T3）+ pin 的上游包校验；运行期沙箱/审批三层不受影响（扩展语义零改动） |

## 5. 验证覆盖（10 分）

| 验证手段 | 内容 | 可执行入口 |
|---|---|---|
| Unit 单测 | bootstrap semver 校验函数（合法/`latest`/空/恶意串） | `bash -n` + 专用用例脚本（bootstrap 函数可 source 化重构以可测） |
| Contract 契约 | 干净容器（docker run --rm -v $PWD:/w ubuntu bash）实测一条命令安装：无前置提示/`omo status` 可用/`~/.omp` 不存在/全局命名空间无 omp | `docker` 冒烟脚本（CI 可选岗） |
| Regression 回归 | `npm test` 全量 + typecheck + runtime 12 探针（产品侧零改动应全绿）；bootstrap vlatest 用例 | `npm test`；`12-ops-audit.sh` |
| Monitoring 监控 | 安装器每步显式输出（✓/✗）；`omo status` 健康面；安装失败输出已下载 sha256 便于诊断 | 安装日志 |
| Rollback 回滚 | 卸载=`omo uninstall`（删 `~/.omo`+软链）；旧版本=OMO_VERSION=v0.6.x 重跑；git revert 安装器 | 手册 |

## 6. 不确定性治理（10 分）

| # | 类型 | 描述 | 处置 |
|---|---|---|---|
| C1 | Human Decision | omp-single 体积：双 variant 全嵌 471MB vs 仅 modern ~290MB（老 CPU 兼容让步） | 默认全嵌（不阻塞），瘦身作为后续优化项待主人定 |
| C2 | Unknown | 目标机 PATH 是否含 `~/.local/bin` | 安装器检测并打印追加指引；不代改 shell 配置 |
| — | Unknown（已清） | H3/H4 已探针裁决（双 ✅，见 `docs/reports/omo-install-probes.md`） | — |
| — | Human Decision（已清） | T1–T5 主人 2026-09-14 拍板（单文件/Linux x64/官方+镜像锁 1.4.x/pin 18.1.x/验收后合 main） | 需求包 §6 拍板列 + OMOINSTALL-1 台账 owner-decision 事件（评审 N1 后补齐） |
| — | Conflict | 无（四层装载无知识-代码冲突） | — |

## 7. 任务拆解（落定后填）

评审通过、主人确认后拆解：① 构建管线脚本 + CI 打包改造；② 安装器重构（bootstrap semver 校验 + install.sh ~/.omo 布局 + bun 自动装）；③ 干净容器契约冒烟；④ 文档。执行方按主人点名（预期本会话自编）。

## 8. 决策门记录

| 命中门 | 决策 | 决策人/时间 |
|---|---|---|
| Unknown | H3/H4 已探针裁决（双 ✅）；C1/C2 显式登记不阻塞 | omp-architect（本方案） |
| Conflict | 未命中 | — |
| Business Trade-off | C1 体积取舍默认全嵌，主人可改 | 待主人（设计确认时） |
| Cross-team Commitment | 未命中（上游为公共 npm 包，pin 自用） | — |
| Compliance | 未命中（安装期执行安全已列风险+校验对策） | — |
| High-risk Change | 命中（交付面重塑）→ 本方案即风险收敛载体，评审+主人确认后执行 | 主人（准入拍板 2026-09-14） |
