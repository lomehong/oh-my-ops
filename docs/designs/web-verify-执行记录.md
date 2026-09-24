# WEBVERIFY-1 执行记录：ops_web_verify（部署后真实浏览器验证）

> 方案来源：会话内设计（Owner 2026-09-24 拍板「让 omo 具备像人一样用浏览器验证 web 页面的能力」）
> 目标项目：oh-my-ops · 分支：main · 台账：WEBVERIFY-1 · 版本：v0.15.0

## 一、测试清单先行（先有验收后有代码）

| # | 验证项 | 可执行观察 | 状态 |
|---|---|---|---|
| V0 | 纯逻辑：噪音过滤（favicon/data: 等）与失败请求挑选 | 单测：噪音计数正确、真实失败保留 | ✅ |
| V1 | 纯逻辑：断言评估矩阵（标题/文本/选择器 通过/不通过） | 单测逐类断言 | ✅ |
| V2 | 纯逻辑：裁决组装（ok 语义 + failOnErrors 叠加 + 备注） | 单测 | ✅ |
| V3 | 编排全链（假会话）：waitFor → 断言 → 截图 → 证据 | 单测：断言序列与截图路径、噪音忽略数 | ✅ |
| V4 | 编排失败链（假会话）：断言不过 + 控制台错误 + 带 URL 的失败请求 | 单测 | ✅ |
| V5 | **端点不可达 = 可执行结论**（ok=false + docker 指引 + endpoint 断言置败） | 单测 + 真机探针 | ✅ |
| V6 | 真浏览器全链（起 Chromium + CDP）：断言全过 + 截图落盘 + 404/控制台证据齐 | `scripts/probe-web-verify.sh` | ✅ |
| V7 | 无浏览器环境**显式 SKIP**（不得静默通过） | 探针 skip 分支 | ✅ |
| V8 | 回归 | `npm run test:ci` 退出码 0（含新探针） | ✅ |
| V9 | 注册适配层：名称/read 档/描述/execute 委派 | 单测（假 pi + 可链式假 zod） | ✅ |
| V10 | 档位表全覆盖（既有守卫）：真实注册的每个 ops_ 工具都在 TIER_TABLE | `guards.test.ts` 守卫 | ✅ |

## 二、Do → 文件映射

| Do | 文件 |
|---|---|
| 零依赖 CDP 客户端（连接就绪握手/命令超时/事件按 session 路由/端点指引） | `packages/ops-extension/src/web/cdp.ts` |
| 验证编排（cookie 注入→导航→等渲染→等网络空闲→断言→截图→证据） | `packages/ops-extension/src/web/verify.ts` |
| 工具注册（read 档） | `packages/ops-extension/src/tools/web-verify.ts` + `extension.ts` |
| 单测 | `packages/ops-extension/test/web-verify.test.ts`（入 test:l2） |
| 真浏览器契约探针 | `scripts/probe-web-verify.sh`（入 test:ci） |
| 能力登记 | `README.md` 智能体侧工具节 |

## 三、真机教训（已固化为回归）

| # | 现象 | 真因 | 固化 |
|---|---|---|---|
| 1 | 真浏览器探针"404 证据缺失"，而同轮控制台错误采集正常 | **读取窗口早于异步证据结算**（固定 250ms 静默窗口不足）；同页面纯 CDP + 3s 等待可见 `title=status:404` 与两条 404 | 改为**等网络空闲**（在途=0 持续 N ms，上限 3s 容忍长轮询）+ 页面侧 Resource Timing 互补 |
| 2 | 端点不可达却被判 **ok=true** | 断言集合为空时 `[].every()` 恒真 ⇒ "什么都没验证"伪装成"验证通过" | 失败路径**显式记一条失败断言**（kind=endpoint, pass=false） |

## 四、设计偏离登记

| 偏离 | 理由 |
|---|---|
| 不用 playwright 驱动，改零依赖 CDP | agent 包是自包含发布物，引入 playwright（含浏览器与数十 MB 依赖）膨胀包体与攻击面；CDP 为浏览器自带协议，Bun 原生 WebSocket 即可 |
| 浏览器接入以 CDP 端点而非内置启动 | 实例多为 el7（glibc 2.17 跑不了现代 Chromium）⇒ 交付"端点可配 + 不可达给可执行指引"，把部署形态留给环境（本机容器/远程集中式） |

### 3.1 v0.15.1 补丁（v0.15.0 的发布缺陷）

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| 3 | v0.15.0 中该工具**一执行即抛 INTERNAL**（`ops_web_verify 为非 read 档工具但未在 policyRequestFor 登记显式 action`） | 新工具未登记进 `TIER_TABLE`；而既有的"档位表全覆盖"守卫**抓不到**，因为它的测试夹具是**手工复刻** extension.ts 的注册序列（新工具不在夹具里） | ① 档位表登记 `ops_web_verify: READ`；② **消除漂移源**：把工具面注册序列抽为 `registerAllOpsTools`（唯一事实源），扩展入口与守卫测试共用；守卫现能拦截此类缺陷 |

> 教训：**复刻式夹具会随上游漂移**——守卫与被守卫对象必须共用同一份实现，否则"有守卫"不等于"被覆盖"。

## 五、验证记录

| 项 | 结果 |
|---|---|
| `bun test web-verify.test.ts` | 7/7 通过（27 断言） |
| `bash scripts/probe-web-verify.sh` | 0 项失败（真浏览器全链 + 不可达路径；本机有浏览器时实跑） |
| `npm run test:ci` | 退出码 0 |
| `npm run typecheck` | 0 错误 |
| 发布 | v0.15.0（含缺陷）→ **v0.15.1**（档位登记 + 夹具漂移消除） |
| 知识回灌 | `architect-knowledge/practice/evidence-collection-convergence-discipline.md`（lint PASS，已登记 practice/index.md） |
