---
title: KB 控制面——服务端配置管理与自有安装分发
status: 已落定
requirement: docs/designs/omo-kb-web-ui-需求包.md（2026-10-29 后续需求）
author: qoder-architect(qoder-cli)
created: 2026-10-29
review:
  score: 53.5
  conclusion: 通过（第三轮 53.5/60；3 项小修已处理；主人 2026-10-29 确认落定）
  confirmedBy: 主人
  confirmedVia: 会话确认（2026-10-29，指令「确认通过并落定，按台账拆票」）
---

# 可执行技术方案：KB 控制面——服务端配置管理与自有安装分发

> **范围声明**：本文只做详细设计，不实施。安装目标机器、修改生产配置、创建真实凭据均不在本文授权内。
> **需求基线**：`docs/designs/omo-kb-web-ui-需求包.md` 的「后续需求：服务端配置管理与安装分发（2026-10-29）」。
> **已确认边界**：首期只服务 Owner 单人高效运维；KB 内容管理复用 Gitea/GitLab；管理后台提供安装脚本/命令，由目标机器主动拉取执行，不是后台 SSH 代装。
> **评审修订（2026-10-29 v3）**：第一轮 `设计评审`（3 阻断 + 13 项）→ 第二轮 `设计复审`（N1/N2 + K1–K8/N4/N6）→ 第三轮 `设计评审-第三轮` **通过 53.5/60**。第三轮 3 项小修（§1 #3/#6 旧文、§0 Q5 计数、script.sha256 顺序 + el7 legacy TOCTOU 注意）已处理。owner 决策：TLS 自签 CA + SPKI pin 双锚（cacert+pin）、目标机包含 el7 并做 legacy 兼容、GitLab 首期仅内容同步、REQ-I03 仅新装、制品服务端缓存/代理。**主人 2026-10-29 确认通过并落定；实施按台账拆票。**

## 0. 一句话与五问速答

**一句话**：在现有 `ops-kb-enroll-server` 上演进出一个 KB 控制面：统一管理 KB 服务配置、实例与凭据、安装分发、门禁与审计；内容面继续由 Gitea/GitLab 承担。

| 五问 | 速答 |
|---|---|
| 改哪里？ | `scripts/ops-kb-enroll-server.mjs`（路由/存储/API + 第二 `Bun.serve` 管理监听、绑定重试、preflight、LISTEN 日志）、`scripts/ui/index.html`（管理页）、`scripts/install-enroll-service.sh`（部署/配置/双监听键）、新增安装分发脚本与客户端上报；不新建第二个常驻 daemon |
| 为什么改？ | 现在安装入口依赖 GitHub，服务配置分散在 `config.env`/安装参数/Gitea UI，后台只能签码和改少量配置，无法完成“获取安装命令 → 目标机器执行 → 接入 → 管理”的闭环 |
| 影响谁？ | Owner（单人运维）；目标机器（主动执行安装脚本，需 curl 支持公钥 pin）；Gitea/GitLab 内容仓；现有 KB 实例；管理面访问路径（loopback + yufu/SSH 隧道）；TLS 证书轮换流程 |
| 如何验证？ | 纯函数单测 + stub Gitea/制品服务器契约探针 + 临时 HOME 的安装脚本端到端 + TLS pin/管理面暴露/路径穿越/令牌并发等安全探针 + 现有 `test:ci` 回归；AC-M01–M07、AC-I01–I10/I12–I13 绑定 |
| 还有什么没有确认？ | 6 项决策已由主人确认（2026-10-29）：TLS cacert+pin / 目标平台含 el7 legacy / GitLab 内容同步 / REQ-I03 仅新装 / 制品服务端缓存 / 管理写 token；剩余为 Gitea 分支保护/webhook API 探针、制品容量评估、yufu 实际部署形态。均不改变已确认边界 |

## 1. 需求覆盖

### Do（做）

| # | 需求 | 方案响应 |
|---|---|---|
| 1 | 自己的管理后台直接提供安装脚本/命令 | 服务端新增 `/install/*` 分发面；UI「安装」页生成命令，脚本由服务端返回 |
| 2 | 目标机器主动拉取执行，不是后台 SSH 代装 | 安装脚本在目标机运行；后台不保存目标机 SSH 凭据、不发起远程 shell |
| 3 | 安装后完成 KB 接入 | Gitea：安装令牌兑换 KB 凭据并自证同步；GitLab 首期使用已有凭据/手工接入，不伪装一键建号 |
| 4 | 服务端集中配置与管理 | 配置页扩展；实例、凭据、安装记录、门禁、审计集中展示与操作；不以「保存成功」替代实际生效 |
| 5 | 内容管理复用 Gitea/GitLab | 只做关联入口；不实现内容编辑器、评审流、第二套存储 |
| 6 | 单人高效运维 | 一条命令安装、一个后台管理；不引入多租户/RBAC/多人协作 |
| 7 | 结果可区分、失败可行动 | 区分脚本获取、安装、接入、上报四个阶段；失败阶段明确，不假绿 |
| 8 | 安全 | 一次性安装令牌、制品完整性校验、TLS、审计；目标机不出现服务端管理员秘密 |

### Don't（不做，显式排除）

- 不做 SSH 远程代装、目标主机 SSH 凭据托管、后台任意命令执行。
- 不做通用应用部署平台；不把 KB 配置管理扩展成对 omo 模型/SSH/本地授权策略的远程控制。
- 不自建内容平台、内容编辑器、PR 评审流、内容存储；这些继续使用 Gitea/GitLab。
- 不要求迁移 GitHub 源码仓库或重建 CI/CD；自有安装入口只改变安装分发路径。
- 首期不做多租户、复杂角色、多人协作、审批流。
- 不做安装后持续自动升级；升级由 Owner 再次生成安装/升级命令触发。

### 已拍板前提（2026-10-29）

| # | 事项 | 决定 |
|---|---|---|
| 1 | 安装制品来源 | **服务端缓存/上传或代理**；目标机只访问自己的控制面；服务端本地重算哈希 |
| 2 | GitLab 管理能力 | **首期仅内容同步**；建号/授权/门禁自动化后续适配；UI 明确显示未启用 |
| 3 | 管理 UI 认证 | 管理 API 默认绑定 loopback，经 yufu 反代或 SSH 隧道；**所有 `/ui/api/*` 需本机 control-plane admin token**；`X-Auth-Username` 仅作身份，不单独构成认证 |
| 4 | 实例在线状态 | 安装/显式上报；显示「最近上报」，超阈值标 stale；不做实时心跳 |
| 5 | 配置下发到已有实例 | **REQ-I03 仅新装**；已有实例显式 `omo kb` 刷新，不推送 |
| 6 | TLS 信任 | 服务端自签 CA + **证书公钥 SPKI pin 双锚**（`--cacert`+`--pinnedpubkey`）；禁止 `-k`；pin-only 不作为路径；证书轮换需重发命令 |

## 2. 系统覆盖

| 组件 | 变更 | 依赖 | 缺席降级 |
|---|---|---|---|
| KB 控制面服务 | 演进 `scripts/ops-kb-enroll-server.mjs`：新增配置/安装/实例 API 与 UI 页 | Bun、现有 `~/.omo-kb` 私有域、Gitea API（管理面） | 服务不可用 → 安装命令不可生成/不可下载；已安装实例的 git 同步不受影响 |
| 管理 UI | 扩展 `scripts/ui/index.html`：安装页、实例页、配置页、门禁/审计；管理面独立监听 | 现有零依赖单页 + yufu 身份头；默认 loopback | UI 关闭时保留 CLI 路径，不静默开放；非受信入口不可达管理 API |
| 安装分发 | 新增 `/install/script`、`/install/manifest`、`/install/artifacts/*`、`/install/enroll`、`/install/report` | 服务端 TLS 证书公钥 pin、安装令牌、制品存储/缓存 | 无制品/证书不匹配 → 明确失败；不回退到不明旧脚本或 `-k` |
| 安装脚本 | 新增/改造服务端托管的安装包装脚本；复用现有 `scripts/install.sh`；新增既有安装守卫与平台矩阵 | 现代 curl（`--cacert`/`--pinnedpubkey`/`--header @file`）或 el7 legacy curl（`--cacert` + openssl SPKI pin + `--config` 头文件）、`sha256sum`/`shasum`、现有安装包布局 | 平台/curl/openssl 不满足 → 停止并报阶段；不降级到 `-k` |
| 实例客户端 | 复用 `omo kb enroll`；新增安装令牌模式、端点参数化与 Bearer 头；最小状态上报 | 现有 `kb-enroll.ts`、`kb-sync.ts`、`kb-credential.ts` | 上报失败不阻断本地 KB；后台标记 stale/unknown |
| 内容面 | 不新增内容实现；Gitea/GitLab 仓库、PR、评审、历史 | Gitea/GitLab | 内容面不可达 → 同步失败，本地知识库仍可用 |
| Gitea/GitLab | Gitea 管理适配已验证部分保留；GitLab 内容同步保留 | 管理员 token/权限 | GitLab 管理能力缺失 → UI 明确显示“仅内容同步”，不给假按钮 |

## 3. 证据覆盖（现状与缺口）

| 事实 | 证据 | 对设计的影响 |
|---|---|---|
| 现有后台只有状态/签码/登记表/审计/配置五区 | `scripts/ui/index.html:59-65` | 需要新增「安装」「实例」等页；不能把现有配置页当成完整管理端 |
| 配置白名单只覆盖 API/repo/team/permission/grant/host/port/UI 身份头/TLS 路径 | `scripts/lib/kb-ui-config.mjs:15-27` | `lint`、`main branch`、`webhook secret` 等仍在 `config.env` 手工配置；需扩展配置模型与安全展示 |
| 服务配置键已包含 webhook/lint/main branch，但 UI 白名单未列 | `scripts/ops-kb-enroll-server.mjs:65-84`；`scripts/lib/kb-ui-config.mjs:15-30` | 配置模型与 UI 白名单存在结构缺口，需要统一 schema |
| registry 记录供给/轮换/吊销与一次性码，不代表在线或最后同步 | `scripts/lib/kb-registry.mjs:35-103`（issueCode/checkCode/consumeCode/upsertEntry） | 新增实例状态需要独立记录，不能拿 registry 冒充在线 |
| 实例最后同步只落本地，不回报服务端 | `packages/ops-extension/src/kb-sync.ts:98-120` | 需要安装/状态上报；首期可只在上报时更新，不引入常驻心跳 |
| 客户端命令只有 sync/loop/status/disable/enroll；enroll 端点硬编码 `/enroll`、无 Bearer | `packages/ops-extension/src/kb-cli.ts:170-189`；`packages/ops-extension/src/kb-enroll.ts:150` | 需要安装令牌模式：端点参数化 + Bearer 头；不能把安装令牌塞进现有 `/enroll` 码语义 |
| Gitea 管理面有建号/改密/授权/撤权，未发现 branch protection/webhook 管理 | `scripts/lib/kb-gitea.mjs:88-168` | 门禁自动配置需新增 API 适配并先探针；MVP 至少提供状态与手工兜底 |
| 当前安装入口是 GitHub bootstrap/release 资产；制品为单一 tar.gz + 旁车 sha256，无平台矩阵 | `scripts/bootstrap.sh:1-18`；`README.md:145-163` | 自有安装入口需服务端提供脚本/清单/制品；平台矩阵与 manifest 哈希校验是全新增能力 |
| `install.sh` 没有“已有 `~/.omo` 拒绝静默覆盖”的通用守卫；只有启动器非本产品时拒绝 | `scripts/install.sh:219-221`（仅启动器归属） | 「拒绝静默覆盖/升级意图」是包装脚本全新增职责，不能按现有能力估算工作量 |
| 重启接力 `successorArgs` 的 drop 集未含 lint/main/webhook | `scripts/ops-kb-enroll-server.mjs:335` | 扩 UI 白名单后必须同步扩 drop 集，否则 config.env 新值被旧 argv 压制，且预检不覆盖 |
| UI 认证只检查身份头存在，默认 `0.0.0.0:8787`；代码默认头名 `X-Auth-Username` | `scripts/lib/kb-auth.mjs:13-19`；`scripts/install-enroll-service.sh:10,57,296-303`；`scripts/ops-kb-enroll-server.mjs:104` | 仅靠头存在等价可伪造；新增签发/轮换 API 前必须做管理面监听分离或签名头；需求包早期写的 `X-Forwarded-User` 是漂移 |
| Webhook secret 未显式进 `SECRET_KEYS`，仅靠正则兜底掩码 | `scripts/lib/kb-ui-config.mjs:30,122` | 扩 schema 时显式加入 `SECRET_KEYS`，并提供“已配置/轮换/清除”而非读取 |
| 一次性码熵为 `randomBytes(24)`=192bit | `scripts/lib/kb-registry.mjs:48` | 新安装令牌至少 256bit，并登记格式/限流/兑换次数 |
| curl 能力门槛：`--pinnedpubkey` ≥7.44、`--header @file` ≥7.55；el7 stock curl 7.29 两者皆无 | 复审报告本机实测 + curl 文档；本机 curl 8.23 复测：pin-only exit 60、`--cacert`+pin exit 0、`-k`+错误 pin exit 90 | 设计采用 `--cacert`+pin 双锚；平台矩阵必须登记 curl/openssl 门槛与 el7 legacy 路径 |
| 既有 `/ui/api/state`、`/ui/api/code` 已存在 | `scripts/ops-kb-enroll-server.mjs:553-554` | API 草案必须补列既有条目，不能只列新增 |

## 4. 风险覆盖

| 风险 | 概率/影响 | 对策 |
|---|---|---|
| TLS 信任链断裂/用 `-k` 被 MITM | 中/高 | 自签 CA 证书 + 公钥 pin 双锚：`--cacert`+`--pinnedpubkey`；禁止 `-k`；pin-only 明确失败；证书轮换重发命令 |
| 管理面身份头伪造 | 高/高 | 管理 API 独立监听 loopback；**所有管理 API 需本机管理 token**；yufu 头只做身份/审计；签发/轮换 API 不暴露在主端口 |
| el7 目标机 curl 7.29 不支持 pin/header 文件 | 高/高 | 平台矩阵登记：现代 curl ≥7.55 走 cacert+pin+header 文件；el7 7.29–7.54 走 openssl SPKI pin + `--cacert` + `--config` 头文件；curl<7.29/无 openssl 明确失败 |
| 安装令牌泄漏（argv/历史/日志） | 中/高 | 256bit 一次性、短 TTL、仅安装域、只存哈希；命令用 0600 header 文件而非 `-H` 字面量；可吊销 |
| 制品被替换/缓存投毒/下载不完整 | 低/高 | 服务端本地重算 sha256 并保存；目标机校验 size+sha256；TLS pin；不信任上游哈希；失败停止 |
| 制品写入/路径穿越 | 中/高 | `/install/artifacts/:name` 只接受 manifest 白名单名称；canonical path 必须在 artifacts 目录内；拒绝 `..`/绝对路径 |
| 服务端成为单点 | 中/中 | 安装仅在使用时依赖控制面；已安装实例的 git 同步独立；服务端沿用现有安装/单元自启 |
| 安装包体积/带宽 | 中/中 | 服务端预缓存/上传；提供 size/断点续传；容量/清理策略；不在安装时反向依赖上游 |
| 重复安装覆盖数据 | 中/高 | 包装脚本检测 `~/.omo` 与 `--upgrade` 意图；默认拒绝静默覆盖；升级保留 `~/.omo/home` 与 KB 凭据；显式确认 |
| 安装成功但 KB 接入失败 | 中/中 | 分阶段报告；服务端记录 `installed` 与 `enroll_failed` 分开状态；重试只补接入 |
| Webhook secret 轮换与门禁耦合 | 中/高 | rotate 与 Gitea webhook 更新按顺序执行/双密钥窗口；健康面显示最近成功验签；失败不报成功 |
| 控制面 JSON 并发写 | 中/中 | 进程内串行队列 + 原子写 + 版本号/乐观锁；冲突 409；不只靠 tmp+rename |
| GitLab 管理 API 能力不足 | 高/中 | 首期仅内容同步；UI 明确未启用；管理自动化后续适配，不显示假按钮 |
| UI 新增写操作被滥用 | 低/高 | 沿用 yufu 身份头；写操作审计 actor；安装令牌与管理员权限分离；限流 |
| 配置变更导致实例漂移 | 中/中 | 配置 revision + 实例上报 applied revision；显示 desired/observed；不宣称已生效直到实例回报 |

## 5. 验证覆盖

### 5.1 单元/纯函数

- manifest 解析与校验（版本、平台、sha256、必填字段）。
- 安装令牌生成/哈希/过期/一次性/设备绑定/吊销。
- 配置 schema 校验、UI 白名单与秘密掩码。
- 实例状态机（installed/enrolled/stale/failed）与阶段聚合。

### 5.2 契约探针（stub Gitea + stub 制品服务）

- `GET /install/script`：无令牌 401；有效令牌返回脚本；过期/已用/吊销拒绝；证书 pin 不匹配拒绝。
- `GET /install/manifest`：返回与所选版本/平台匹配的清单；缺失制品明确报错；manifest 被篡改/哈希不符拒绝。
- `GET /install/artifacts/*`：sha256/大小校验；Range/断点；损坏制品拒绝；`..`/绝对路径/非白名单名称拒绝。
- `POST /install/enroll`：令牌换凭据；重复兑换/过期/设备不匹配明确拒绝；不返回管理员秘密；限流/爆破探针。
- `POST /install/report`：阶段报告幂等；安装成功/接入失败分开；伪造 token 拒绝；洪泛限流。
- 管理面：仅 loopback 可访问；`/ui/api/*` 写操作无本机管理 token 一律 401/403；本机直连伪造 `X-Auth-Username` 不获得签发/轮换权限；有 token 才可写；`/ui/api/state`、`/ui/api/code` 既有行为回归。
- AC-M01：`/ui/api/config` 合法/非法值、预检失败回滚/不重启、配置修订变化；AC-M02：registry 无上报不算在线 + lastSync/applied revision；AC-M03：rotate/revoke 命令与审计；AC-M04：门禁状态与拒写真失败；AC-M05：审计 actor/无秘密；AC-M06：本机伪造头/token；AC-M07：内容深链。
- 安装令牌状态机：issued→active→completed/expired/revoked 的触发条件；并发兑换只成功一次；JSON 读改写冲突返回 409。
- 旧 `/enroll`、`/kb/webhook`、`/healthz`、`/ui` 回归不破。

### 5.3 端到端（临时 HOME，不碰生产）

- 干净临时 HOME 执行服务端生成的安装命令：脚本获取（`--cacert`+pin）→ manifest → 制品校验 → `install.sh` → KB enroll → status 自证 → report。
- 既有 `~/.omo` 场景：默认拒绝静默覆盖；`--upgrade` 保留 home/凭据；断言不删除知识数据。
- 失败注入：下载失败、sha256 不符、pin-only 无 trust anchor 失败、错误 pin、CA 证书被替换但 pin 拒绝、curl 不支持 pin、KB 服务不可达、令牌过期、重复 report、不支持的 OS/arch、非白名单制品名；每项断言阶段与提示。
- AC-I02 验证：管理 API 生成的命令/响应不含目标主机 SSH 凭据；运行探针断言没有向目标主机发起 SSH/远程执行连接（只允许客户端主动访问控制面与内容仓）。
- AC-M07 验证：后台内容入口只打开 Gitea/GitLab 链接，不提供内容编辑/评审表单。
- 目标平台：
  - Linux x86_64 + 现代 curl（≥7.55）：`--cacert`+`--pinnedpubkey`+`--header @file` 全链必测。
  - el7 类 curl 7.29–7.54：`openssl` SPKI pin 校验 + `curl --cacert` + `--config` 头文件；实现前 el7 真机探针；curl <7.29 或缺 openssl 明确失败。
  - macOS 按现有安装器能力；Windows Git Bash 明确支持边界（不静默假装支持）。

### 5.4 回归

- 现有 `npm run test:ci` 全绿（L1/L2/typecheck/ledger/install/bootstrap/vendor 等）。
- 新增 `test:kb-install` 探针纳入 test:ci；无 Chrome 的 web-verify 仍显式 SKIP。

### 5.5 验收对应

- 安装分发 AC-I01–AC-I10、AC-I12–AC-I13。
- 管理/内容面 AC-M01–AC-M07。
- 安全探针：令牌爆破/限流、pin-only 失败、错误 pin、CA 证书替换、证书轮换后旧命令失效、服务重启中断→TTL 内重试、installers.json 篡改/缓存投毒、report 洪泛、`:name` 穿越、本机伪造头无 token、管理面非受信入口。
- 每个 AC 在实现任务中绑定探针或人工验收步骤；AC-M07 绑定到 P0-5 内容深链任务；AC-M01–M04 绑定到 P0-5/P0-6/P1-1。

## 6. 不确定性治理（2026-10-29 已拍板）

| # | 事项 | 决定 | 变更触发 |
|---|---|---|---|
| 1 | 制品托管 | **服务端缓存/上传或代理**；目标机只访问控制面 | 服务器磁盘/带宽不可接受 → 重新评估 |
| 2 | GitLab 管理 | **首期仅内容同步**；管理自动化后续适配 | 要求 GitLab 同等管理自动化 |
| 3 | UI 认证 | 管理 API loopback + **本机管理 token 强制**；yufu 头只做身份/审计；远程 yufu 反代/SSH 隧道 | 要求脱离 yufu 独立登录 |
| 4 | 在线/心跳 | 安装/显式上报；显示「最近上报」，不宣称实时在线 | 要求实时在线/自动巡检 |
| 5 | 配置下发 | **REQ-I03 仅新装**；已有实例显式刷新 | 要求后台自动下发已有实例 |
| 6 | 升级 | 再次生成安装/升级命令；不做自动更新 | 要求自动升级/灰度发布 |
| 7 | TLS 信任 | **自签 CA + 公钥 SPKI pin 双锚**（`--cacert`+`--pinnedpubkey`）；禁止 `-k`；证书轮换重发命令 | 要求改用受信 CA/yufu 证书 |
| 8 | 目标平台 | 现代 curl ≥7.55 全功能；el7 curl 7.29–7.54 走 openssl pin + `--cacert` + `--config`；curl<7.29 失败 | 目标集变化/el7 探针失败 |
| 9 | 一期待确认 #1（yufu API 规格） | 管理面 loopback + 本机 token；yufu 头只做身份；MVP 不依赖 yufu 内部 API | 要求脱离反代直连管理面 |
| 10 | 一期待确认 #2（enroll 证书） | 由本条 #7 的 cacert+pin 方案继承；不再依赖 `--allow-insecure-tls` | 迁 yufu 受信证书时重评 |

## 7. 架构设计

### 7.1 组件与边界

```
Owner 浏览器
   │  yufu 反代 / SSH 隧道
   ▼
┌─────────────────────────────┐
│ KB 控制面（单进程，双监听）   │
│ 管理监听 127.0.0.1:8788      │
│  /ui 配置/安装/实例/门禁/审计 │
│  /ui/api/* 签发/轮换/上传     │
│ 主监听 0.0.0.0:8787          │
│  /install/* 脚本/清单/制品/报告│
│  /enroll /kb/webhook /healthz │
│  config.env + control-plane/*.json │
└──────────────┬──────────────┘
               │ Gitea API（管理面，已有部分）
               ▼
        Gitea / GitLab（内容面：仓库/PR/评审/历史）

目标机器（用户执行命令）
   curl/脚本 ──► /install/script（TLS pin）──► manifest ──► 制品
        └──► install.sh（复用）──► omo kb enroll/安装令牌 ──► /install/enroll
        └──► 自证 ──► /install/report ──► 实例记录
```

**边界**：
- 控制面负责“如何拿到、如何装、如何接入、装到哪台、是否成功”。
- 内容面负责“内容长什么样、怎么评审、怎么合并、历史是什么”。
- 目标机器负责“执行安装”；控制面不建立到目标机器的远程 shell。

### 7.2 部署形态

- **一个常驻进程，两个监听面**：沿用 `~/.omo-kb/`、现有 TLS、启动器/systemd 形态；不新增第二个 daemon。
  - **主监听**（默认 `0.0.0.0:8787`）：`/enroll`、`/kb/webhook`、`/healthz`、`/install/*`；供实例/目标机访问。
  - **管理监听**（默认 `127.0.0.1:8788`，`OMO_KB_UI=on` 时才启动）：`/ui`、`/ui/api/*`；远程仅经 yufu 反代或 SSH 隧道，不在主监听暴露管理路由。
  - 主监听上的 `/ui`、`/ui/api/*` 一律 404；管理监听为 loopback 时允许明文 HTTP（仅本机），远程由 yufu 终结 TLS。
- 服务目录新增（均 0600）：
  - `control-plane/config.json`：控制面自身的非秘密配置/修订号（若继续用 config.env，则只新增 `config.revision` 派生值）。
  - `control-plane/installers.json`：可用安装版本/渠道/清单元数据。
  - `control-plane/install-tokens.json`：一次性安装令牌（只存哈希）。
  - `control-plane/instances.json`：实例登记与最近上报。
  - `control-plane/artifacts/`：可选制品缓存目录。
  - `control-plane/admin.token`：**控制面本机管理 token**（0600，独立于 Gitea 管理员凭据），安装时生成；所有 `/ui/api/*` 调用必须携带。
- 审计继续使用现有哈希链 `audit.jsonl`；新增事件带 `actor`、`installId`、`device`。
- 本机 `omo-kb` CLI 保留；管理 UI 默认 `off`。**管理监听可达不是授权**：所有管理 API（含读）要求本机 `control-plane/admin.token`；yufu 身份头只作为 actor 身份/审计，不参与授权。本机进程直连 8788 伪造 `X-Auth-Username` 不能获得任何管理权限。
- **本地账户模型**：loopback 端口对本机所有 UID 可达；首期按单用户服务机假设，若同机多用户需防火墙、独立主机或 UNIX socket（实现前评估）。

### 7.3 配置模型

**原则**：`config.env` 仍是服务启动的兼容事实源；控制面新增一个经过 schema 校验的“配置视图”，UI 不直接拼字符串。

分三层：

1. **服务运行配置**（现有 `config.env`）：API/repo/team/permission/grant/host/port/TLS/registry/audit/log/UI/auth。
2. **KB 行为配置**：`OMO_KB_LINT_MODE`、`OMO_KB_MAIN_BRANCH`、`OMO_KB_WEBHOOK_SECRET`（秘密仅显示“已配置/未配置”，支持轮换，不回显）。
3. **控制面数据**：安装版本/渠道、实例、令牌、制品缓存；放 `control-plane/*.json`，不塞进 `config.env`。

**配置修订（configRevision）**：
- 每次服务配置或 KB 行为配置成功保存，生成递增修订号/内容哈希。
- 安装令牌绑定生成时的 `configRevision`；安装脚本把该修订写入实例报告。
- UI 显示 desired revision；实例列表显示 applied revision；不一致标记「待刷新」，但不自动远程改实例。

**UI 写配置**：
- 沿用现有「校验 → 原子写 0600(.bak) → 预检 → 重启接力」。
- 扩展白名单：`OMO_KB_LINT_MODE`、`OMO_KB_MAIN_BRANCH`；`OMO_KB_WEBHOOK_SECRET` 只提供“生成/轮换/清除”，不提供读取，并显式加入 `SECRET_KEYS`（不能只靠 `TOKEN|PASSWORD|SECRET` 正则兜底）。
- **重启接力连带修改**：`successorArgs` 的 `drop` 集必须同步加入 `lint-mode`、`main-branch`、`webhook-secret`、`ui`、`ui-identity-header`（以及新增的 `ui-host`/`ui-port`）；否则 config.env 新值会被旧 argv 压制。预检需覆盖这些键的语法，而不是只查 API/registry/TLS。
- **三个落点必须同步**：`ui-host`/`ui-port` 同时加入 `CONFIG_KEY_TO_ARG`、`UI_CONFIG_KEYS` 与 `drop` 集；`ui`/`ui-identity-header` 至少加入 `drop` 集，避免显式 `--ui` 启动时页面关不掉。
- 管理员凭据、registry/audit 路径、日志路径仍不通过 UI 修改，避免自锁/提权。
- `kb-enroll.ts` 的 `enroll()` 端点参数化并支持 Bearer：安装令牌走 `/install/enroll`，手工兑换仍走 `/enroll`；不能在 `/enroll` 里混用两种令牌。
- **CLI 写路径**：`omo-kb installer import` 等写操作必须走管理 API（携带本机管理 token），不得直接写 `control-plane/*.json`；若服务不可用则失败，不另起跨进程写路径。确需离线导入时，使用独立的跨进程锁并登记，不能假设服务内串行队列能覆盖 CLI。

### 7.4 安装分发

#### 7.4.1 安装版本与清单

`control-plane/installers.json` 记录可用版本：

```json
{
  "version": "v0.17.0",
  "channel": "stable",
  "createdAt": "2026-10-29T00:00:00Z",
  "script": { "path": "install/install.sh", "sha256": "..." },
  "script_sha256": "...",
  "manifest": {
    "version": "v0.17.0",
    "platforms": [
      { "os": "linux", "arch": "x86_64", "artifact": "oh-my-ops-v0.17.0.tar.gz", "sha256": "...", "size": 123, "curl": "modern|legacy", "openssl": "required-for-legacy" }
    ]
  },
  "kb": { "server": "https://<控制面>", "repo": "hzins-ops/ops-kb", "mainBranch": "main" },
  "status": "available"
}
```

- 清单由服务端生成/登记；不要求目标机解析 GitHub Release 页面。
- 制品路径可为本地预缓存/上传，也可由服务端按配置代理上游；对目标机暴露同一个 `/install/artifacts/<name>` URL。预缓存路径应允许安装时完全不访问上游，避免控制面自身成为新的 GitHub 依赖。
- **制品写入权限**：只有管理监听（loopback/yufu）可调用 `POST /ui/api/installers` 与 `POST /ui/api/installers/:version/artifacts`（流式/分片），或本机 CLI `omo-kb installer import`；主监听不可写。服务端对实际收到的字节**本地重算 sha256/size**并保存，拒绝与清单不符；代理上游时也先落地重算，不信任上游元数据。
- **平台矩阵**：manifest 必须列 `os/arch`，并声明 curl 能力档（modern ≥7.55：cacert+pin+header 文件；legacy 7.29–7.54：openssl pin+cacert+`--config`）；安装脚本在下载前匹配目标与 curl/openssl 能力，匹配失败即停止，不进入 `install.sh` 的试运行阶段（现状无平台矩阵，这是净新增）。
- **script.sha256**：服务端对实际托管的安装脚本计算并写入 manifest（同时提供扁平 `script_sha256` 便于无 jq 解析）；目标机**先取 manifest、再取脚本、校验后执行**，不能先执行后校验，也不能只信上游提供的哈希。
- **制品可信定义**：服务端本地重算 sha256/size 并保存；目标机以 TLS 公钥 pin + manifest 内嵌哈希 + size 校验；可选服务端签名作为加固。任何一环不通过即拒绝，不使用“上游说可信”作为判据。
- **容量/带宽评估**：实施前必须按目标版本制品大小、实例数量、缓存保留策略做容量评估；未完成评估不得把“服务端缓存/代理”当成已落地方案。
- 版本/渠道选择由 UI 决定；默认只暴露一个 `stable`，避免首期做复杂发布体系。

#### 7.4.2 安装令牌

`control-plane/install-tokens.json` 记录：

```json
{
  "sha256": "<token sha256>",
  "installId": "ins_...",
  "version": "v0.17.0",
  "channel": "stable",
  "device": "optional-device-name",
  "createdAt": "...",
  "expiresAt": "...",
  "redeemedAt": null,
  "completedAt": null,
  "createdBy": "ui:<actor>",
  "revokedAt": null
}
```

规则：
- **熵与格式**：`randomBytes(32).toString("base64url")`（256bit），前缀 `omoinst_`；不低于现有 enroll 码的 192bit。登记格式校验，拒绝弱/重复令牌。
- **状态机**：`issued → active（首次成功获取 script/manifest）→ completed（report verified）| expired | revoked`；触发条件在 §7.9 固定。`active` 允许同一 installId 在 TTL 内重试；`completed` 后不可再用。
- **并发与持久化**：`install-tokens.json`/`instances.json` 读改写走进程内串行队列 + 原子写 + `revision` 乐观锁；冲突返回 409。仅 tmp+rename 不能防丢失更新。
- 默认 TTL 60 分钟；一次性完成语义；只存哈希；只能访问 `/install/*` 与 `/install/report`，不能访问管理 API。
- **安装令牌不是现有 enroll 兑换码**：`/enroll` 的一次性码继续用于手工接入/轮换/吊销；安装令牌只用于安装会话，二者不混用、不互相替代。
- 若令牌绑定 `device`，`/install/enroll` 与 report 必须匹配；未绑定时以脚本上报的 hostname 作为实例名，但 `installId` 才是实例唯一键（防 hostname 伪造污染）。
- 兑换/报告限流：按 token + IP 限制失败次数（例如 10 次/分钟、5 次失败/10 分钟），超限 429；记录审计但不记录明文。
- 生成命令时只在响应中返回一次明文 token；不写服务端日志、不写审计明文。

#### 7.4.3 安装脚本

服务端托管 `install/install.sh`（可由现有 `scripts/install.sh` 加一层包装生成；不复制安装逻辑）：

0. **TLS trust（cacert+pin 双锚）**：安装命令携带服务端自签 CA 证书（PEM；命令可用 base64 或 here-doc 交付）与证书**公钥 SPKI 的 SHA-256（base64）**。现代 curl：`--cacert <CA> --pinnedpubkey 'sha256//<pin>'`；**不使用 `-k`**。注意 pin 不是 `openssl x509 -fingerprint -sha256` 的证书指纹；现有 `omo-kb cert` 需新增/改为输出 SPKI pin，或由 UI 计算后写入命令。`pin-only`（无 `--cacert`）会先被链校验拒绝（本机实测 exit 60），因此不采用。
1. `set -euo pipefail`；检测 OS/arch、磁盘、`sha256sum`/`shasum`、curl 版本与 openssl：
   - curl ≥7.55：modern 路径（cacert+pin+header @file）。
   - curl 7.29–7.54：legacy 路径（openssl 校验 CA 的 SPKI pin + `curl --cacert` + `--config` 头文件）；缺 openssl 则失败。注意：openssl pin 校验与 curl 下载是**两次连接**（TOCTOU 窗口），最终信任锚是 `--cacert` 交付链，pin 是连续性辅助校验，语义弱于现代路径；必须由 el7 真机探针验证 openssl 1.0.2 命令序列。
   - curl <7.29：失败，给出升级 curl 的指引；不尝试 `-k`。
2. 令牌经 0600 header 文件或 `--config` 文件传入，不放在 argv/URL；临时目录 `mktemp -d`，`trap` 退出清理。
3. `GET /install/manifest`（cacert+pin 或 legacy 等价校验），校验版本/平台/curl 档/字段；选择制品；平台不匹配立即停止。
4. `GET /install/artifacts/<name>`（同上）到临时文件；校验 size + sha256；失败即停止并报告阶段。
5. 解包到 staging；调用现有 `scripts/install.sh`（或复用它支持的包布局），保留 `~/.omo/home`、KB 凭据。**既有安装检测是包装脚本新增职责**（现有 `install.sh` 只在启动器归属冲突时拒绝，没有通用 `~/.omo` 守卫）：
   - 已安装且未传 upgrade 意图 → 拒绝静默覆盖，提示用升级命令；
   - 升级 → 走现有升级路径，保留数据；写入升级标记供 report 区分。
6. KB 接入（按内容平台能力分支）：
   - **Gitea（首期自动）**：`omo kb enroll --install-token`（新增客户端模式）或等价的 `/install/enroll` 兑换；成功后落盘 `$OMO_DIR/kb/credential.json` 0600 + git store，调用 `omo kb status`/拉主线自证。
   - **GitLab（首期不自动建号）**：安装命令携带/引导已有 GitLab 凭据的配置方式，或安装后由 Owner 执行现有 `omo kb` 配置；后台明确显示 GitLab 管理自动化未启用，不伪装一键接入。
7. `POST /install/report`，上报阶段：`script_fetched`、`downloaded`、`installed`、`enrolled`、`verified`；失败上报 `stage` + `reason`（不含秘密）。
8. 清理临时文件；输出下一步（后台实例页/内容仓链接）。

**命令形态（示例，评审时可改）**：

```bash
export OMO_CONTROL_PLANE="https://<kb-host>:8787"
export OMO_TLS_PIN="sha256//<证书公钥 pin>"
export OMO_INSTALL_TOKEN_FILE="$HOME/.omo-install.token"   # 0600，由后台提供/用户写入
TMPD="$(mktemp -d)"; umask 077; trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/ca.pem" <<'CA'
<自签 CA 证书 PEM；由后台生成命令时嵌入>
CA
printf 'Authorization: Bearer %s\n' "$(cat "$OMO_INSTALL_TOKEN_FILE")" > "$TMPD/headers"
curl -fsS --cacert "$TMPD/ca.pem" --pinnedpubkey "$OMO_TLS_PIN" \
  --header @"$TMPD/headers" "$OMO_CONTROL_PLANE/install/manifest" -o "$TMPD/manifest.json"
EXPECTED="$(sed -n 's/.*"script_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$TMPD/manifest.json" | head -1)"
[ -n "$EXPECTED" ] || { echo "✗ manifest 缺 script_sha256" >&2; exit 1; }
curl -fsS --cacert "$TMPD/ca.pem" --pinnedpubkey "$OMO_TLS_PIN" \
  --header @"$TMPD/headers" "$OMO_CONTROL_PLANE/install/script" -o "$TMPD/install.sh"
ACTUAL="$(sha256sum "$TMPD/install.sh" | awk '{print $1}')"
[ "$ACTUAL" = "$EXPECTED" ] || { echo "✗ script.sha256 不匹配" >&2; exit 1; }
sh "$TMPD/install.sh"
```

说明：
- 顺序固定：先取 manifest → 取脚本 → 校验 `script_sha256` → 执行；不能先执行后校验。
- `-f` 必须保留：否则 401/403 响应体会被 `sh` 执行。
- macOS 用 `shasum -a 256` 替代 `sha256sum`；服务端生成的命令按目标平台选择。
- 令牌不进入 argv/URL；放在 0600 文件并 `trap` 清理；固定 `/tmp` 名称已改为 `mktemp -d`；`OMO_INSTALL_TOKEN_FILE` 由用户 0600 保存，安装成功后删除。
- 该示例是现代 curl 路径；脚本检测到 curl 7.29–7.54 时转 legacy（openssl 校验 CA SPKI pin + `curl --cacert` + `--config` 头文件），curl<7.29/缺 openssl 明确失败。
- **不得回退到 `-k`**；`pin-only`（无 `--cacert`）会链校验失败，不作为路径。

#### 7.4.4 安装阶段与失败

| 阶段 | 成功条件 | 失败处理 |
|---|---|---|
| `platform` | OS/arch、curl 档（modern/legacy）、openssl（legacy）满足 manifest | 立即停止；列出支持矩阵与升级指引；不尝试“尽力安装” |
| `tls_trust` | 自签 CA 证书通过 `--cacert` 链校验，且公钥 SPKI 与命令 pin 一致；legacy 由 openssl 校验同一 pin | 立即停止；提示重新获取命令/证书已轮换；**不回退 `-k`** |
| `manifest` | 清单存在、版本/平台匹配、含 `script_sha256` | 停止；提示选择其他版本或平台 |
| `script_fetched` | 服务端返回脚本且 script_sha256 校验通过 | 不执行；提示服务端不可达/令牌无效/脚本损坏 |
| `downloaded` | 制品 size/sha256 通过 | 删除临时文件；提示重试/检查制品/缓存投毒 |
| `installed` | `install.sh` 退出 0；启动器可用；既有安装意图合法 | 保留日志；不报告成功；按现有安装器恢复指引；覆盖风险场景停止并提示升级命令 |
| `enrolled` | KB 凭据落盘且自证同步成功 | 标记 `installed / enroll_failed`；可重试接入，不重装 |
| `verified` | `omo kb status` 自证、实例上报成功 | 标记 `enrolled / report_failed`；后台显示待上报 |

### 7.5 实例与凭据管理

`control-plane/instances.json` 核心字段：

```json
{
  "id": "inst_...",
  "device": "hostname",
  "version": "v0.17.0",
  "os": "linux",
  "arch": "x86_64",
  "status": "installed|enrolled|failed|stale",
  "lastSeen": "...",
  "lastSync": "...",
  "configRevision": "...",
  "appliedRevision": "...",
  "credential": { "login": "omobot-...", "repo": "...", "expiresAt": "..." },
  "installId": "ins_...",
  "lastError": { "stage": "...", "reason": "..." }
}
```

- **来源**：安装 report、`omo kb status --report`（新增最小命令）、后台操作记录；不把 registry 条目直接当在线。
- **唯一键**：以 `installId` 作为实例唯一键；`device`/hostname 只作展示。未绑定 device 的令牌必须把 hostname 当作不可信输入，重复/伪造 hostname 不得覆盖已有实例。
- **在线语义**：只显示「最近上报」；超过可配置阈值（默认 24h）标 `stale`，不显示“在线”。report 幂等键 = installId + stage；重复 report 不重复计数。
- **凭据操作**：
  - `rotate`/`revoke` 继续复用一次性码/`ops-kb-provision` 语义；UI 生成操作命令，不直接在服务器上静默改实例凭据。
  - 后台可显示凭据登录名、仓库、到期日、撤销状态；秘密不回显。
- **配置修订**：实例上报 `appliedRevision`；与 desired 不一致时显示「待刷新」，并提供 `omo kb` 刷新命令；首期不远程推送。

### 7.6 管理 UI 与 API

#### UI 信息架构

| 页 | 内容 | 首期 |
|---|---|---|
| 概览 | 服务健康、配置修订、门禁状态、实例数/最近上报 | P0 |
| 安装 | 版本/渠道、生成安装命令、令牌列表、安装历史 | P0 |
| 实例 | 列表、阶段、版本、最近上报/同步、凭据状态、操作命令 | P0 |
| 配置 | 服务配置 + KB 行为配置 + 秘密轮换 | P0（扩展现有页） |
| 门禁 | lint 模式/主分支/webhook 配置状态、最近 lint 事件、手动兜底说明 | P1（Gitea 自动 apply 需 API 探针） |
| 审计 | 现有审计尾 + 安装/凭据/配置事件过滤 | P1 |
| 内容 | 深链到 Gitea/GitLab 仓库/PR | P0（链接） |

#### API 草案

**管理 API（仅管理监听；所有调用需 `Authorization: Bearer <control-plane-admin-token>`；yufu 头仅作 actor 身份/审计；写操作审计 actor）**

| Method | Path | 说明 |
|---|---|---|
| GET | `/ui/api/state` | 既有：状态/登记表/审计尾/配置视图；保留 |
| POST | `/ui/api/code` | 既有：签发 enroll 码；保留 |
| GET/POST | `/ui/api/config` | 既有：读/写配置；扩展 lint/main branch；写后同步 drop 集/预检 |
| POST | `/ui/api/secret/rotate` | 生成/轮换 webhook secret（不回显旧值）；与 gate/apply 的顺序约束见 §7.6.1 |
| POST | `/ui/api/secret/close` | 关闭双密钥宽限：要求已观测到新密钥验签成功（`lastVerifiedAt ≥ rotatedAt`），否则 400；关闭后重启仅新密钥生效 |
| GET | `/ui/api/instances` | 实例列表/最近上报/applied revision |
| POST | `/ui/api/instances/:id/rotate` | 生成轮换码/命令 |
| POST | `/ui/api/instances/:id/revoke` | 生成吊销码/命令 |
| GET | `/ui/api/installers` | 可用版本/清单 |
| POST | `/ui/api/installers` | 登记版本/清单（仅管理监听；写操作审计） |
| POST | `/ui/api/installers/:version/artifacts` | 流式/分片上传制品；服务端本地重算 sha256/size；仅管理监听 |
| POST | `/ui/api/install-tokens` | 生成一次性安装令牌，返回命令（明文一次） |
| GET | `/ui/api/install-tokens` | 令牌元数据（无明文） |
| POST | `/ui/api/install-tokens/:id/revoke` | 吊销 |
| GET | `/ui/api/gate` | desired/observed/最近事件/最近成功验签 |
| POST | `/ui/api/gate/apply` | Gitea 分支保护/webhook（能力探针通过才启用）；与 secret/rotate 的联动见 §7.6.1 |
| GET | `/ui/api/audit` | 审计过滤 |

**管理面暴露约束**：以上管理 API 不注册在主监听；主监听 `/ui`、`/ui/api/*` 返回 404。管理监听默认 `127.0.0.1:8788`；远程由 yufu 反代或 SSH 隧道。**即使带 `X-Auth-Username` 或来自 loopback，没有 `control-plane/admin.token` 也不得调用任何 `/ui/api/*`**；本机直连伪造头必须 401/403。UI 首次使用输入 token（仅存内存/session），不写入 URL/日志；CLI 从 0600 文件读取。

#### 7.6.1 secret 轮换与门禁顺序

1. 生成新 webhook secret（旧值仍可用）。
2. 通过 Gitea API 更新 webhook secret；若 API 不可用，进入“待 Owner 手工更新”状态，不把轮换报成功。
3. 更新本地 `OMO_KB_WEBHOOK_SECRET`，重启/接力。
4. 发一个测试 PR 或等待一次真实 webhook，确认签名验签成功；健康面显示“最近成功验签”时间。
5. 失败时保留双密钥窗口（服务端同时接受新旧 secret）或回滚；不得在 Gitea 仍用旧 secret 时先删旧值。
6. **双密钥窗口参数**：默认 24h；关闭条件 = 至少一次真实 webhook 验签成功且 Owner 确认；回滚步骤 = 恢复旧 secret、重新 apply Gitea webhook、重启服务；窗口期与关闭操作入审计。健康面显示最近成功验签时间，失败不报成功。

**安装 API（安装令牌）**

| Method | Path | 说明 |
|---|---|---|
| GET | `/install/script` | 返回包装脚本；Bearer token；TLS 公钥 pin；返回 script.sha256 |
| GET | `/install/manifest` | 返回版本/平台清单；Bearer token；pin；不含管理员秘密 |
| GET | `/install/artifacts/:name` | 制品流；Range/断点；Bearer token；`name` 必须命中 manifest 白名单，canonical path 在 artifacts 目录内，拒绝 `..`/绝对路径 |
| POST | `/install/enroll` | Gitea：令牌换 KB 凭据，复用现有建号/授权/自证逻辑；GitLab 首期不走此接口；限流 |
| POST | `/install/report` | 阶段/结果上报；installId+stage 幂等；限流；不接收秘密 |

**保留**：`/enroll`、`/kb/webhook`、`/healthz` 原行为（主监听）；`/ui` 只在管理监听。

### 7.7 内容面复用

- **Gitea**：保留现有建号/改密/团队/协作者/撤权能力；内容编辑/PR/评审由 Gitea 提供；后台只做深链。
- **GitLab**：保留普通 git 同步；MVP 不承诺 GitLab 管理 API 自动建号/授权；UI 按能力探测显示「仅内容同步 / 管理自动化不可用」，不显示假按钮。安装接入不通过 `/install/enroll` 自动建号，改为携带/引导已有 GitLab 凭据或在安装后执行现有 `omo kb` 配置；后台需明确显示这一差异。
- **不新增**：内容条目 CRUD、域管理、评审流、内容搜索、第二套数据库。

### 7.8 安全模型

| 面 | 措施 |
|---|---|
| 管理 UI/API | 独立 loopback 监听；主监听不暴露 `/ui`；远程仅 yufu 反代/SSH 隧道；**所有 API 需 control-plane admin token**；yufu 头只作身份/审计；本机伪造头无 token 一律拒绝；写操作审计 actor；限流；不回显秘密。单人使用不等于取消认证 |
| 本地账户模型 | loopback 端口对本机所有 UID 可达；首期按单用户服务机假设；同机多用户需防火墙/独立主机/UNIX socket |
| 安装分发 TLS | 自签 CA + SPKI pin 双锚（`--cacert`+`--pinnedpubkey`）；禁止 `-k`；pin-only 失败；legacy 用 openssl pin+cacert；证书轮换重发命令 |
| 安装令牌 | 256bit、一次性、短 TTL、仅 `/install/*`、只存哈希、可吊销；0600 header/`--config` 传 token，不进 argv/URL；失败限流 |
| 管理员凭据 | Gitea 管理员凭据与控制面 `control-plane/admin.token` 分离；均 0600；不进入安装脚本、不返回客户端、不写日志 |
| 制品完整性 | 服务端本地重算 sha256/size；目标机校验；TLS pin；缓存投毒/路径穿越拒绝；可选服务端签名 |
| 目标机 | 不接收服务端管理员 secret；不建立反向 SSH/远程 shell；安装文件 0600（凭据） |
| 内容面 | 复用 Gitea/GitLab 权限；后台不存内容凭据以外的管理 token |
| 审计 | 配置变更、令牌签发/使用、安装阶段、凭据操作、门禁结果均入现有哈希链审计；不记明文秘密 |

### 7.9 状态机

**安装令牌**：`issued → active（首次成功获取 script/manifest）→ completed（report verified）| expired（TTL）| revoked（Owner）`。`active` 可在 TTL 内重试；`completed` 后所有 `/install/*` 拒绝。转换由服务端在请求处理内原子完成；并发首用只允许一个成功，其余返回 409/429。

**安装会话**：`created → platform → tls_trust → manifest_ok → script_fetched → downloaded → installed → enrolled → verified`；任一阶段失败 → `failed(stage)`，保留已完成阶段和错误，不伪报后续阶段。`platform`/`tls_trust`/`manifest`/`script_fetched` 失败不进入下载/执行。

**实例**：`pending → installed → enrolled → active/stale`；`failed`；`revoked`。`active` 只由最近上报维护，不承诺实时心跳；`installId` 唯一，hostname 不唯一。实例记录/令牌的读改写使用进程内串行队列 + revision 乐观锁；冲突 409。

### 7.10 错误处理

| 场景 | 行为 |
|---|---|
| TLS 链校验失败 / pin 不匹配 / CA 被替换 / pin-only | 停止在 `tls_trust`；不下载脚本/制品；提示重新获取命令或证书轮换；**不回退 `-k`** |
| curl/openssl 能力不满足（含 el7 7.29 无 pin/header） | 停止在 `platform`；给出 modern/legacy 支持矩阵与升级指引；不尝试“尽力安装” |
| 令牌无效/过期/已用/并发首用冲突 | 401/409/410；脚本停止；UI 提示重新生成命令 |
| 制品 404/校验失败/缓存被篡改 | 停止；删除临时文件；报告 `download` 阶段；不执行旧文件 |
| 制品名含 `..`/绝对路径/非白名单 | 400；不读文件；审计记录 |
| 不支持的 OS/arch | 下载前停止并列出支持矩阵；不尝试“尽力安装” |
| 已有 `~/.omo` 且无升级意图 | 默认拒绝静默覆盖；提示升级命令；保留 home/凭据 |
| KB 服务不可达 | 安装成功但 `enroll_failed`；重试接入不重装 |
| report 失败/洪泛 | 本地安装/接入仍成功；后台标记 `report_failed`，给出补报命令；超限 429 |
| 管理 API 非受信入口/无 token/伪造头 | 404/401/403；管理路由不在主监听；loopback 直连也必须 token；不暴露内部路径/秘密 |
| 控制面 JSON 并发写冲突 | 409；不静默覆盖；客户端可重试 |
| webhook secret 轮换顺序错误 | 不报成功；保留双密钥/回滚；健康面显示最近成功验签 |
| Gitea 门禁 API 不可用 | UI 显示「不可自动配置」+ 明确手工步骤；不伪造成功 |

## 8. 任务拆解（设计评审通过后再立项/实施）

| 阶段 | 任务 | 验收 |
|---|---|---|
| P0-1 | 控制面数据模型与存储（installers/tokens/instances/audit） | 单测：原子写、权限、损坏兼容、状态机、并发 409 |
| P0-2 | 安装分发 API + 令牌 + TLS 双锚 | 契约探针：401/过期/重复/吊销/pin-only 失败/错误 pin/CA 替换/限流/路径穿越 |
| P0-3 | 安装包装脚本（复用 install.sh） | 临时 HOME 端到端：platform→cacert+pin→下载→校验→安装→接入→上报；已有安装守卫、modern/el7 legacy、`-f`/mktemp/trap |
| P0-4 | `/install/enroll` 与客户端安装令牌模式 | 令牌换凭据、落盘 0600、自证；`kb-enroll.ts` 端点参数化+Bearer；旧 `/enroll` 回归 |
| P0-5 | UI 安装页/实例页/配置扩展/内容深链 | 生成命令、令牌列表、实例阶段、秘密不回显；AC-M01 配置写、AC-M02 实例/lastSync、AC-M07 内容链接 |
| P0-6 | 管理监听分离与认证加固 | 主监听 `/ui` 404；loopback 管理面；control-plane admin token 强制；伪造头无 token 不获权限；AC-M06 |
| P1-1 | 实例上报/最近状态 + 凭据操作命令 | AC-M03 轮换/吊销；不引入常驻心跳 |
| P1-2 | 门禁状态/配置 + Gitea API 探针 + secret 顺序 | AC-M04 门禁；Gitea 能力通过才 apply；轮换顺序/双密钥；GitLab 明确不支持项 |
| P1-3 | 审计过滤/安装历史 | 审计事件可追溯，不含秘密 |
| P2 | GitLab 管理适配器 | 能力矩阵与独立任务 |

> 以上是设计阶段的工作分解；正式实施仍需按仓库台账立项、逐项验收，不在本文直接开工。

## 9. 决策门记录（2026-10-29）

| 决策 | 内容 | 来源 |
|---|---|---|
| 单人目标 | 首期只服务 Owner 一人高效运维，不做多租户/复杂角色；单人使用不等于取消认证 | 主人 2026-10-29 会话 |
| 内容面复用 | 内容仓库/编辑/评审/历史用 Gitea/GitLab，不自建内容平台 | 主人 2026-10-29 会话 |
| 安装分发 | 自己的后台提供安装脚本/命令，目标机器主动执行；不是 SSH 代装 | 主人 2026-10-29 会话（纠正） |
| TLS 信任 | 自签 CA + 公钥 SPKI pin 双锚（`--cacert`+`--pinnedpubkey`）；禁止 `-k`；证书轮换重发命令 | 主人 2026-10-29 复审答复 |
| 目标平台 | 现代 curl ≥7.55；el7 curl 7.29–7.54 legacy（openssl pin + cacert + `--config`）；curl<7.29 失败 | 主人 2026-10-29 复审答复 |
| GitLab 范围 | 首期仅内容同步；管理自动化后续 | 主人 2026-10-29 评审答复 |
| REQ-I03 范围 | 仅新装实例；已有实例显式刷新 | 主人 2026-10-29 评审答复 |
| 制品托管 | 服务端缓存/上传或代理；服务端本地重算哈希 | 主人 2026-10-29 评审答复 |
| 管理面入口 | 管理 API 默认 loopback；远程仅 yufu 反代/SSH 隧道；**所有管理 API 需 control-plane admin token**；yufu 头只做身份/审计 | 本设计安全加固（复审 N2 要求） |
| 服务落点 | 演进现有 `ops-kb-enroll-server`，单进程双监听 | 本设计默认（复审可改） |
| 在线状态 | 最近上报，不做实时心跳 | 本设计默认（复审可改） |
| 升级 | 再次生成安装/升级命令，不做自动更新 | 本设计默认（复审可改） |

## 10. 复审关注点

决策记录已落档；6 项已由主人确认（TLS cacert+pin / 目标平台 el7 / GitLab 内容同步 / REQ-I03 仅新装 / 制品服务端缓存 / 管理写 token）。第三轮复审请重点检查：

1. **N1 TLS 双锚**：`--cacert`+pin 现代路径、el7 legacy、pin-only 失败、CA 替换/轮换、无 `-k` 回退。
2. **N2 管理写认证**：所有 `/ui/api/*` 需 control-plane admin token；本机直连伪造头无 token 必须 401/403；主监听不暴露管理路由。
3. **安装令牌/制品**：256bit、header/`--config` 文件、状态机/并发、路径穿越、服务端本地哈希、缓存投毒。
4. **验证绑定**：AC-M01–M07、AC-I01–I10/I12–I13、AC-I02 无 SSH 探针；AC-M07 入 P0-5。
5. **新增能力边界**：既有安装守卫、平台矩阵、`kb-enroll.ts` 端点参数化按“净新增”估算。
6. **K1–K8/N4/N6**：AC-M01–M04 探针、需求包 L101、同步状态、§0 双监听、drop 集 `ui`/`ui-identity-header`、CLI 写路径、本地账户假设、双密钥参数、命令 `-f`/mktemp/trap。

### 10.1 评审意见处置（摘要）

| 评审项 | 处置 |
|---|---|
| RSK-B1 TLS 信任链 | §7.4.3 双锚 `--cacert`+pin + `platform`/`tls_trust`；§7.8/§7.10 禁止 `-k`；需求包 REQ-I05/I07、AC-I09/I12/I13 |
| RSK-B2 管理面伪造头 | §7.2 双监听 + control-plane admin token；§7.6 管理 API 仅 loopback/yufu；§7.8 安全表；需求包 AC-M06 |
| REQ-B1 REQ-M01 无 AC | 需求包新增 AC-M01–AC-M07 |
| REQ-Z1 GitLab 例外 | 需求包 REQ-M02 显式例外；§7.7 说明首期仅内容同步 |
| REQ-Z2 REQ-I03 范围 | 需求包 REQ-I03 限定新装；§6/§7.5 显式刷新 |
| REQ-Z3 AC-I02 无验证 | §5.3 增加“无 SSH/远程执行连接”探针 |
| REQ-Z4 GitLab 能力未核实 | 首期范围收窄为内容同步；P2 独立适配器 |
| A4 行号超界 | §3 修正为 `kb-registry.mjs:35-103` |
| C1 既有安装守卫 | §3/§7.4.3 标注净新增；P0-3 验收 |
| C2 平台矩阵 | §7.4.1/§7.4.3 标注净新增；P0-3 验收 |
| 证据轴④ drop 集 | §7.3 明确同步扩展 lint/main/webhook/ui/ui-identity-header/ui-host/ui-port，并登记三处落点 |
| N1 pin-only 不可达 | §7.4.3 改为 cacert+pin 双锚；§7.4.4 增 `platform`；§5.3 增 pin-only/CA 替换/轮换探针；需求包 AC-I12/I13 |
| N2 本机伪造头 | §7.2/§7.6 所有管理 API 需 control-plane admin token；§7.8 本地账户假设；需求包 AC-M06 |
| K1 AC-M01–M04 绑定 | §5.2/§5.5/§8 P0-5/P0-6/P1-1 显式绑定 |
| K2 需求包旧文 | 需求包「明确不做」改为制品来源已拍板 |
| K3 四项拍板记录 | 需求包新增「决策记录（主人 2026-10-29）」 |
| K4 同步状态 AC | AC-M02 增 lastSync |
| K5 §0 改哪里 | §0 增第二 Bun.serve/绑定重试/preflight/LISTEN 日志 |
| K6 drop 集漏键 | §7.3 增 ui/ui-identity-header；ui-host/ui-port 三处落点 |
| K7 CLI 写路径 | §7.3 明确 CLI 走管理 API/独立锁 |
| K8 loopback 本地 UID | 需求包假设/§7.8 安全表登记 |
| N4 双密钥参数 | §7.6.1 增 24h/关闭条件/回滚/审计 |
| N6 命令安全 | §7.4.3 示例改 `-f`/mktemp/trap/头文件；无 bashism |
| SECRET_KEYS / API 遗漏 | §7.3 显式入列；§7.6 补 `/ui/api/state`、`/ui/api/code` 与上传 API |
| I1–I7 安全/并发 | §7.4.1/§7.4.2/§7.6.1/§7.9/§7.10 分别处置 |
| J2–J8 | 需求包补假设/阻断、AC-I04 失败注入、AC-I08 P0-5、制品评估/可信定义、认证底线 |
| 知识漂移：身份头默认键名 | 需求包一期正文改为 `X-Auth-Username`（以代码为准）并注明旧表述 |

## 11. 实施状态（2026-10-30）

设计已于 2026-10-29 由主人确认落定；以下为实施与验证台账（自报 ≠ 完成，台账状态以 `docs/tasks/KBCP-*.yaml` 为准）。

| 票据 | 状态（台账） | 已验证 | 未兑现 |
|---|---|---|---|
| KBCP-P0-1 数据模型与存储 | 待确认 | 单元 10 pass；0600/原子写/revision/并发/损坏大声失败 | — |
| KBCP-P0-2 安装分发 API + TLS 双锚 | 待确认 | 契约探针 [1][2][3][7]；错误 pin/路径穿越/令牌重放 | 真机公网/网关前缀未复验 |
| KBCP-P0-3 安装包装脚本 | 待确认 | modern/legacy 双路径 + 失败注入 + 临时 HOME e2e | 真实 el7 主机、正式发布包 |
| KBCP-P0-4 客户端安装令牌模式 | 待确认 | 6 pass；e2e 真实客户端落盘 + CA 持久化 | 真实 git 自证（e2e 用本地状态替代） |
| KBCP-P0-5 UI 安装/实例/配置/内容 | 待确认 | 渲染垫片 18/18；内容只深链、无第二套评审流 | 真浏览器人工点检 |
| KBCP-P0-6 管理监听分离 + admin token | 待确认 | 无 token 401；主监听 /ui 404；伪造头非认证；重启接力 | — |
| KBCP-P1-1 实例上报/状态/凭据操作 | 待确认 | 上报令牌哈希/吊销/幂等/设备绑定；`omo kb status --report` | 真实同步后的 lastSync |
| KBCP-P1-2 门禁状态/轮换 | 待确认 | gate apply/observed；双密钥 24h 宽限；回滚顺序；审计 | 真实 Gitea API；GitLab 例外 |
| KBCP-P1-3 审计过滤/安装历史 | 待确认 | 过滤 API/UI + installId 归组 + 无秘密 | 真浏览器点检 |
| KBCP-P2-1 GitLab 管理适配器 | 待执行 | — | 独立设计/评审后实施 |

验证入口：

```
npm run test:kb-control-plane   # 控制面契约 + 安装包装 e2e（含 legacy 模拟与失败注入）
npm run test:kb-ui              # 管理后台配置/预检/重启接力
bun scripts/probe-kb-ui-render.mjs
npm run test:kb-lint            # 门禁 lint + 拒写不假绿
npm run typecheck
```

安全与并发要点（实现即证据）：上报令牌与安装令牌分离（安装令牌 completed 后仍可上报）；上报令牌只存 sha256、吊销保留哈希以区分 revoked/not_found；安装上报不回退为安装令牌（避免吊销被掩盖成 401）；TLS 信任由 node:https 显式 CA 绑定到单次请求（不写进程级 `NODE_TLS_REJECT_UNAUTHORIZED`）；webhook 轮换先改 Gitea 再落配置，配置写失败回滚 Gitea。

本文已由主人确认落定（2026-10-29，指令「确认通过并落定，按台账拆票」）；实施进度与未兑现项见 §11，状态机以台账为准。
