# KBUI-1 执行记录：kb 服务 Web 配置前端（一期）

> 方案：`docs/designs/omo-kb-web-ui-design.md`（主人 2026-09-21 落定）· 分支：`feature/kbui-1-web-ui` · 台账：KBUI-1

## 一、测试清单先行（方案 §5 验证覆盖逐条转写，先有验收后有代码）

| # | 验证项 | 可执行观察 | 状态 |
|---|---|---|---|
| V0 | 配置库单测：白名单校验/原子写/掩码 | `bun -e` 直调 `scripts/lib/kb-ui-config.mjs`：坏 repo/port/非白名单键被拒；写后 0600+.bak；掩码不漏 secret | ☐ |
| V1 | UI 默认关：升级零变化 | 无 `--ui` 时 `GET /ui`→404、`GET /ui/api/state`→404；`/healthz` 200 | ☐ |
| V2 | 身份头门禁 | UI on：无头 `GET /ui`→401（正文提示经 yufu）；带头放行 | ☐ |
| V3 | state 脱敏 | `/ui/api/state` 含 health(pid/repo/tls)+config(脱敏)+registry(条目/未用码 sha)+审计尾部；**断言响应不含 admin 令牌值** | ☐ |
| V4 | 页面签码闭环 | `POST /ui/api/code`→32 位码一次性返回；registry 落码(sha)；审计 `ui.code.issued` actor=身份头值；**该码真实 enroll 一台"实例"成功**（全链） | ☐ |
| V5 | 配置校验失败硬停 | 坏 repo `POST /ui/api/config`→400；PID 不变；config.env 未被改写 | ☐ |
| V6 | 合法改配→预检→重启 | 改 TEAM 保存→新 PID、新值回读生效、healthz 恢复 200 | ☐ |
| V7 | 预检失败不重启 | 把 API 改成不可达地址保存→400+原因；PID 不变；config.env 回滚为改前内容（.bak 恢复） | ☐ |
| V8 | 非白名单键拒绝 | `values` 混入 `OMO_KB_ADMIN_TOKEN_FILE`→400 | ☐ |
| V9 | 回归 | 既有 `npm run test:ci` 全绿 | ☐ |
| V10 | 发布完整性 | 服务包清单含 `ui/index.html`（断言红测：删文件 CI 必红） | ☐ |

## 二、Do → 文件映射

| Do | 文件 |
|---|---|
| 页面 | `scripts/ui/index.html`（新增，相对路径，零外部资源） |
| state/签码/配置路由 + `--check` 预检 + re-exec 重启 | `scripts/ops-kb-enroll-server.mjs` |
| 配置解析/校验/原子写/掩码（纯函数，可单测） | `scripts/lib/kb-ui-config.mjs`（新增） |
| 身份头门禁 | `scripts/lib/kb-auth.mjs`（新增） |
| config.env 新键 + 启动器 `--config`/UI 参数 + 完成提示 | `scripts/install-enroll-service.sh` |
| 契约探针 | `scripts/probe-kb-ui.sh`（新增）→ `package.json test:ci` |
| 服务包 `ui/` + 清单断言 | `.github/workflows/release.yml` |

## 三、设计偏离登记

| 偏离 | 理由 |
|---|---|
| 方案 §4 写"Origin 校验"→ 实现为**写操作强制携带身份头**（替代） | 反代下 Origin 与 Host 必然不一致，Origin 白名单会误杀；而浏览器跨站无法伪造自定义头 ⇒ 身份头必带即 CSRF 免疫，且更适配 yufu 任意前缀挂载 |
| 无会话 cookie（方案原写"会话快照 cookie"） | 网关信任模式下每请求都带身份头，服务端无状态更简单；cookie 反而多余 |
| 新增 `--pid-file` | 重启切换后启动器 `omo-kb stop` 依赖 pid 文件指向新进程（原设计遗漏） |

## 四、执行日志

- 2026-09-21 立项 KBUI-1；建分支；本清单落盘。
