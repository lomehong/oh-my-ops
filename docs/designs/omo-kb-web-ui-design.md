---
title: kb 服务 Web 配置前端（一期：面板+签码+配置修改，认证预留 yufu）
status: 草稿
requirement: docs/designs/omo-kb-web-ui-需求包.md
author: omp-architect（omp-docker / PC-SZ-375）
created: 2026-09-21
review:
  score: 60
  conclusion: 通过（architect_review 2026-09-21，待主人确认落定）
---

# 可执行技术方案：kb 服务 Web 配置前端（一期）

## 0. 一句话与五问速答

| 五问 | 速答 |
|---|---|
| 改哪里？ | oh-my-ops 仓 `scripts/ops-kb-enroll-server.mjs`（+197 行基数上增路由）、新增 `scripts/ui/index.html`、安装器与发布清单小改；实例侧零改动 |
| 为什么改？ | 主人要求在前端页面完成必要配置，消除 SSH 手改 config.env + 重启的繁琐（真机多轮部署反复暴露该痛点） |
| 影响谁？ | 服务机运维（受益）；4 台已接入实例（无感，/enroll、/healthz 不动）；Gitea（仅既有 API 复用） |
| 如何验证？ | 新增契约探针 probe-kb-ui.sh（登录→读态→签码→改配置→预检→重启切换全链）+ 单测 + test:ci 全绿回归 |
| 还有什么没有确认？ | 2 项待确认（yufu API 规格、操作者身份粒度），均不阻断一期；最关键是 yufu 接口规格（二期前须主人提供） |

## 1. 需求覆盖（10 分）

### Do（做）

| # | 需求条目 | 方案响应 | 来源 |
|---|---|---|---|
| 1 | 前端页面（中文、零依赖单页） | 服务包内 `ui/index.html`，服务端 `GET /ui` 直出；vanilla JS + fetch，无构建链 | 需求包·范围 |
| 2 | 查看服务状态/登记表/审计 | `GET /ui/api/state`：health、config 脱敏视图、registry 全量（只存 sha256 天然无秘密）、审计尾部 N 条 | 同上 |
| 3 | 签发 enroll 码 | `POST /ui/api/code`：服务进程内直接调 `issueCode()`（kb-registry.mjs:41，与 CLI 同库同登记表），明文只显示一次 + 复制按钮 | 同上 |
| 4 | 修改服务配置 | `GET/POST /ui/api/config`：白名单键校验 → 原子写 config.env（0600，留 .bak 一代）→ `--check` 预检 → 停旧起新 | 同上 |
| 5 | 认证预留 yufu | `AUTH_MODE=none\|yufu` 配置位 + `lib/kb-auth.mjs` 的 `authenticate(req)` 接口；一期 none，接口签名按 yufu 语义留形 | 主人决策 2026-09-21 |
| 6 | 同端口 8787 | 全部新路由挂 `/ui` 前缀，与 /healthz、/enroll 同进程同证书 | 主人决策 2026-09-21 |

### Don't（不做，显式排除）

| # | 排除项 | 排除原因 |
|---|---|---|
| 1 | bot rotate/revoke/删号 UI、fleet 逐台签码 | 主人选 b 不选 c；生产变更台误操作风险高 |
| 2 | yufu 认证实现 | 主人拍板一期预留；API 规格未提供（待确认 #1） |
| 3 | enroll 协议/实例侧任何变更 | 兼容红线：4 台生产实例零感 |
| 4 | 前端框架与构建链 | 服务包「零外部依赖」既有约束（发布清单断言佐证）；页面规模（4 区块）不需要框架 |
| 5 | TLS 证书签发 UI | 证书生命周期属安装器职责，UI 只可改路径引用 |

### To Confirm（待确认）

| # | 待确认项 | 问谁 | 状态 |
|---|---|---|---|
| 1 | yufu 鉴权 API 规格（`E:\code\go\Yufu` 本容器不可达） | 主人 | 二期前 |
| 2 | 操作者身份粒度（一期 actor 统一记 `ui`，是否需要按人区分） | 主人 | 二期随 yufu |

## 2. 系统覆盖（10 分）

| 服务/插件/仓库 | 变更类型 | 关键依赖 | 缺席降级影响 |
|---|---|---|---|
| scripts/ops-kb-enroll-server.mjs | 改（增 /ui 路由组 + re-exec 重启） | kb-registry/kb-audit/kb-auth | UI 关闭时=纯 enroll 服务，现状不变 |
| scripts/ui/index.html | 增 | 无（内联 JS/CSS） | 缺文件 ⇒ /ui 返回 503，其余路由不受影响 |
| scripts/lib/kb-auth.mjs | 增 | 无（一期 stub） | 不存在 ⇒ 服务按 none 模式启动并告警 |
| scripts/install-enroll-service.sh | 改（config.env 增 OMO_KB_UI/AUTH_MODE 键；完成提示加 UI 入口） | — | 老配置文件缺新键 ⇒ 按默认 off，零影响 |
| 发布清单（release.yml 服务包） | 改（加 ui/ + 断言） | — | 缺断言文件 ⇒ CI 红，不发布 |
| 4 台已接入实例 | **不动** | — | 零感（/enroll 协议与路径不变） |

- 范围外参与方：Gitea（twin.hzins.com，只被既有 API 复用）；logstash-124 等 4 实例（不改协议）。
- 对照 dsh-suite-architecture-map：本需求属 oh-my-ops 单仓变更，无跨服务拓扑变化——地图核对不适用（单仓内服务增强），显式声明。

## 3. 证据覆盖（10 分）

| 关键结论 | 证据类型 | 出处 |
|---|---|---|
| 服务端现有面=2 路由，扩展点干净 | Code | ops-kb-enroll-server.mjs:190-191（/healthz GET、/enroll POST） |
| 签码可进程内复用，无需子进程 | Code | lib/kb-registry.mjs:41 `issueCode`（provision:232 同库调用） |
| el7 无 systemd ⇒ 重启=nohup stop/start | Code/Config | install-enroll-service.sh:308-323,350,402 |
| 配置键全集与 0600 纪律 | Config | install-enroll-service.sh:209-226（config.env 生成段） |
| 登记表不含明文秘密 | Code | lib/kb-registry.mjs（sha256/sha1 only）；真机 `omo-kb list` 输出佐证 |
| IP 失败限流可复用于登录 | Code | ops-kb-enroll-server.mjs `throttled()`（1 分钟 10 次） |
| 服务包零依赖约束 | Business | 发布清单断言 + 「真机 Cannot find module」事故修复记录（release.yml 注释） |

## 4. 风险覆盖（10 分）

| 风险类 | 有无涉及 | 分析与对策 |
|---|---|---|
| Compatibility 兼容 | 有 | /enroll、/healthz 路径/语义/响应体不动；老 config.env 缺新键按默认值（UI off）跑 ⇒ 升级即滚回安全态 |
| Exception 异常 | 有 | 配置保存先 `--check` 预检（临时端口起服务自证：参数合法+registry 可读+Gitea 可达）失败则**不重启**并回显原因；写盘原子（tmp+mv，0600，.bak 一代） |
| Cache 缓存 | 不适用 | 服务无缓存层；前端页面带版本参数防旧缓存（`/ui?v=<REGISTRY_VERSION>`） |
| MQ 消息 | 不适用 | 无消息中间件 |
| State 状态机 | 有 | 重启=停旧起新存在端口交接窗口：先起新进程（绑定失败自动退避重试 ≤5s）再停旧？——**定案**：预检通过后 `server.stop(true)` → 立即 spawn 新进程（同参重构自新 config.env）→ 旧进程退出；窗口 <1s，期间 /healthz 短暂拒绝属预期，UI 明示 |
| Security 安全 | 有（核心） | 一期无认证（主人拍板 yufu 二期）：① `OMO_KB_UI` **默认 off**，显式 `on` 才挂载 /ui，开启时日志打横幅警告；② 会话 cookie HttpOnly+SameSite=Strict+8h 过期；③ 写操作校验 Origin 头（CSRF）；④ 登录/写失败复用 throttled(ip) 限流；⑤ **一切响应不含秘密**（admin 凭据只回「已配置(sha1 前 8 位)」）；⑥ 审计 actor=ui 记录每次签码/改配 |

## 5. 验证覆盖（10 分）

| 验证手段 | 内容 | 可执行入口 |
|---|---|---|
| Unit 单测 | config 白名单校验（坏 repo/port/host/非白名单键）；会话签发/过期；Origin 校验 | `packages/ops-extension/test/kb-ui.test.ts`（bun test） |
| Contract 契约 | 真服务全链：off 默认（/ui 404）→ on 启动横幅 → 登录 → state 脱敏断言 → 签码（登记表+审计落账）→ 改配置预检失败不重启 → 预检通过重启切换（新值生效）→ /enroll 回归不受影响 | 新增 `scripts/probe-kb-ui.sh` 入 `npm run test:ci` |
| Regression 回归 | 既有 test:ci 全绿（enroll e2e、install 探针、provision 自检） | `npm run test:ci` |
| Monitoring 监控 | 审计 JSONL 已有；UI 开关状态打印进 LISTEN 行（`ui=on/off auth=none`） | `omo-kb logs` |
| Rollback 回滚 | `OMO_KB_UI=off`（或删键）+ `omo-kb restart` ⇒ UI 全部消失；配置改坏用 `config.env.bak` 覆盖回 + restart；服务包整体可用上一版本包重装 | 安装器现有能力 |

## 6. 不确定性治理（10 分）

| # | 类型 | 描述 | 处置 |
|---|---|---|---|
| 1 | Unknown | yufu 鉴权 API 规格（参考项目在主人 Windows 机，本容器不可达） | 已登记；二期设计前主人提供规格或只读访问；本期仅留 `authenticate(req)` 接口形 |
| 2 | Unknown | 操作者身份粒度（一期 actor=ui） | 已登记；随 yufu 二期升级为按人 |
| 3 | Human Decision | 一期无认证暴露面（同端口+配置修改权） | **主人已拍板**（2026-09-21：yufu 负责认证，一期预留）；工程缓解=UI 默认 off+显式开启+横幅警告+限流+CSRF 防护，记录于 §8 |

## 7. 任务拆解（落定后填）

| 看板任务号 | 任务 | 可验收条目 | 级别预期 |
|---|---|---|---|
| 待立项 | T1 服务端 /ui 路由组 + kb-auth 接口 | probe-kb-ui.sh 契约全绿 | — |
| 待立项 | T2 单页前端 ui/index.html | 四区块可操作；无外部资源引用 | — |
| 待立项 | T3 配置写回 + 预检 + re-exec 重启 | 预检失败不重启；成功切换新值生效 | — |
| 待立项 | T4 安装器/发布清单/文档 | test:ci 全绿；服务包含 ui/ 断言 | — |

## 8. 决策门记录

| 命中门 | 决策 | 决策人/时间 |
|---|---|---|
| Business Trade-off（能力范围） | 选 b：面板+签码+配置修改（不做 bot 生命周期操作） | 主人 2026-09-21 |
| High-risk Change（同端口暴露配置权，一期无认证） | 认证鉴权由 yufu 负责，一期预留接口二期实现；工程缓解：UI 默认关闭、显式开启、横幅警告、限流、CSRF、秘密不回显 | 主人 2026-09-21 |
| Business Trade-off（暴露面） | 同端口 8787，/ui 前缀挂载 | 主人 2026-09-21 |
