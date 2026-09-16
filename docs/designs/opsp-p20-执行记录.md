# OPSP-P20 执行记录 — read 档工具冒烟缺陷批（对端 18 项矩阵）

> 任务号：OPSP-P20 ｜ 分支：`feature/OPSP-P20`
> 来源：对端 `sec-agent-manager-172-26-5-121`（v0.9.2 官方件、无本地补丁）对 **18 项只读能力**做的端到端冒烟矩阵，报 3 个真缺陷 + 1 个体验缺陷
> 依据：其元结论——「这 3 个真缺陷全部是**参数拼接 / 输出解析**层面的，没有一个在加载层面；守卫应从『能加载』扩到『能跑对』，断言输出结构而非断言文件存在」

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| T1 | ps argv 形态正确 | `node --test packages/ops-core/test/process.test.ts`（argv 形态守卫） | 红：`-eo` 取值为 `…args--sort=-%cpu`（粘连）；绿：`…args,--sort=-%cpu` |
| T2 | 真实 ps 冒烟 | 同上（`PS_AVAILABLE` 时执行；本容器无 `/bin/ps` 故跳过，CI/真机真跑） | 红：`ps` 退出 1 → `list()` 抛 OpsError；绿：返回结构合法且非空 |
| T3 | grep 单路径无前缀不错位 | `node --test packages/ops-core/test/log.test.ts` | 红：`{file:"2:bin:x",line:1,text:"1:bin:/bin:/sbin/nologin"}`（对端原文）；绿：`{file:"/etc/passwd",line:2,text:"bin:x:1:1:bin:/bin:/sbin/nologin"}` |
| T4 | grep 多路径无前缀 → 丢弃 | 同上 | 绿：`matches.length === 0`（宁缺勿错） |
| T5 | 真实 grep 单路径结构 | 同上 | 绿：file/line/text 三者对齐 |
| T6 | docker_ps 失败不伪装 | `bun test packages/ops-extension/test/read-tier-structure.test.ts` | 红：daemon 不可达回显 `"(no containers)"`；绿：回显 `exit=1` + stderr |
| T7 | compose 缺件给诊断 | 同上 | 红：回显 docker 全量 usage；绿：`docker compose 不可用（exit=1）：…` 且不再执行 compose 本体 |
| T8 | 全量门 | `npm run test:ci` | 全绿（新结构测试已并入 test:l2） |

## 二、根因与落点

| 缺陷 | 根因 | 落点 |
|---|---|---|
| ① `ops_process_list` 恒定失败 | `${PS_FIELDS.join(",")}--sort=-%cpu` **漏逗号** → `args--sort=-%cpu` 被 ps 当字段描述符；**注意：补逗号后塞进 `-eo` 字段列表同样非法**（`--sort` 是选项而非字段）——见 §三 CI 证据 | `packages/ops-core/src/process.ts`：`["ps", "-eo", PS_FIELDS.join(","), "--no-headers", "--sort=-%cpu"]`（`--sort` **独立 argv**） |
| ② `ops_docker_ps` 吞 daemon 不可达 | `text: result.stdout \|\| "(no containers)"` 未判 exitCode/stderr（同文件另有 3 种口径） | 新增 `packages/ops-extension/src/tools/exec-output.ts` 的 `fmtExecResult()`；统一 **13 处**（docker-k8s 8 / read-only 3 / service 2） |
| ③ `ops_log_grep` 字段错位 | 单路径时部分 grep 实现不加文件名前缀，而解析用惰性正则 `/^(.+?):(\d+):(.+)$/` → 锚到行内容里的 `:数字:`，**静默产出貌似合理的错位数据** | `packages/ops-core/src/log.ts`：`-rnH` 强制前缀 + 已知路径锚定（file 必须落在给定 paths 之内）+ 无前缀时单路径显式分支；无法锚定则丢弃 |
| ④ `ops_docker_compose` 无诊断 | 直接执行 `docker compose -f …`；compose 缺件时回显 docker usage（约 60 行）；文件名硬编码 | `docker-k8s.ts`：预探测 `docker compose version` → 缺失直说；`file` 参数可选（缺省 `docker-compose.yml`） |

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 红①（argv） | `旧 -eo 取值: pid,user,%cpu,%mem,args--sort=-%cpu`；`含 args--sort（缺陷形态）: true` → 新：`pid,user,%cpu,%mem,args,--sort=-%cpu` |
| 红②（docker_ps 口径） | `旧口径回显: "(no containers)"`（exit=1 + stderr 被吞） |
| 红③（grep 解析） | 旧解析对同一条输入产出 `{"file":"2:bin:x","line":1,"text":"1:bin:/bin:/sbin/nologin"}` —— **与对端报告逐字一致** |
| 绿（单元/结构） | `node --test process.test.ts` → 5 pass / 2 skipped（本容器无 ps 二进制）；`node --test log.test.ts` → 7 pass / 1 skipped；`bun test read-tier-structure.test.ts` → 5 pass |
| 全量门 | `npm run test:ci`（L1 132 pass；L2 51 pass ×4 文件；typecheck；install 守卫；bootstrap 守卫）全绿 |
| 真机对照 | 对端 v0.9.2 冒烟：18 项中 11 ✅ / 3 ❌ / 2 ⚠️ / 3 ➖（环境缺件）；本批修复后其 ❌/⚠️ 四类应全部转 ✅ |
| **CI 真机守卫（关键）** | v0.9.3 首轮 CI `测试` job **failure**：`ps 退出码 1：error: improper AIX field descriptor` —— 证明「补逗号塞进 -eo 列表」那版修法**错误**（`--sort` 是选项不是字段）；`打包发布` 因此 **skipped（未发布）**。修正为独立 argv 后：`node --test process.test.ts` 5 pass/2 skip（本地无真实 ps）、`npm run test:ci` 全绿、CI run 35070274266 两 job success |
| 守卫价值实证 | 本容器无真实 `ps`（bash 侧 ps 为宿主内建）→ 本地必然跳过；**CI（ubuntu/procps）有真实 ps 才拦住错误修法**。这正是对端元结论「守卫从『能加载』扩到『能跑对』」的直接收益 |
| 发布修正 | 首轮 tag 未产出 Release（安全）；已删除并按修正后提交重打 `v0.9.3`（8460169），CI 复跑成功、Release 已发布（2026-09-16T07:47:47Z，三资产齐） |

## 四、未兑现项

- **真机复验**：需 v0.9.3 发布后由对端重跑 18 项矩阵（v0.9.3 已于 2026-09-16T07:47:47Z 发布，含本修正）（我方无 docker/kubectl 环境，docker/compose 分支用脚本化 Runner 断言，未真机跑）。
- **`PS_AVAILABLE` 跳过**：本容器无真实 `ps` 二进制（bash 侧 ps 为宿主内建），真实 ps 冒烟在 CI/真机执行；本地以 argv 形态守卫兜底。
- **未纳入本批**：对端另报的 2 条（SshPool host key 策略与文档不符、PathGuard 机密根漏真实 home `.ssh`）→ 单独立项 `OPSP-P21`，与本批一并发 v0.9.3。
- **已知未修**：启动时 7 条 `Custom tool load failed`（宿主扫描 `$EXT/ops-pi/tools/*.ts`）。
