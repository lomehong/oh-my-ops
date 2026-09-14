# `/ops-audit` 实现执行记录（OPSAUDIT-3）

> 方案：`docs/designs/ops-audit-command-design.md`（已落定，review 60/通过）
> 分支：`feature/OPSAUDIT-3-impl`（自 `feature/OPSAUDIT-2-design` 顶端切出）
> 纪律：先有验收后有代码；红灯不提交；每步真实输出留痕。

## 一、可执行测试清单（方案 §5 逐条转写）

| # | 清单项 | 可执行入口 | 预期观察 |
|---|---|---|---|
| T1 | `parseAuditLimit` 参数语义（B4/T1） | `bun test test/audit-view.test.ts` | 空→`{ok,n:20}`；`5`→5；`0/−3/2.5/abc`→`{ok:false}`；`201`→`{ok,n:200,truncated}`；`200`→不 truncated |
| T2 | `toAuditViews` 收窄（B2/B3） | 同上 | 非 custom / 非 ops_audit 剔除；`data` 字段缺失→`undefined`（不补默认）；输入保序 |
| T3 | `formatAuditReport` 格式化（B3/B7/T1） | 同上 | 空态文案；`ts` 倒序切片；缺字段 `-`；reason 单行化 + 160 字符截断 `…`；头部范围声明 + 截断提示；非法 ts 排尾 |
| T4 | 装配正确性（B1/B5/B6，fail-soft） | `npm run typecheck` + runtime 探针 | handler 编译通过；getBranch 抛错→notify error + 自审计 `isError:true`，不崩 |
| T5 | runtime 数据面探针（B8） | `bash packages/ops-extension/test/runtime/12-ops-audit.sh` | 持久会话分支经 `toAuditViews` 收窄 ≥1 条且 `tool/ts/authz` 可辨 |
| T6 | 回归 | `npm test` + `npm run typecheck` | 既有 167 用例 + 新增全绿；写入侧（hooks.ts）diff 为零 |
| T7 | 交互冒烟（U2，人工） | 交互会话输入 `/ops-audit`、`/ops-audit 2`、`/ops-audit abc` | UI 输出条目/错误提示；二次调用可见首次自审计条目（B6 闭环） |

## 二、Do → 文件映射（方案 §1 → 改动面）

| Do | 文件 |
|---|---|
| 收窄/解析/格式化纯函数（Do10） | `packages/ops-extension/src/audit-view.ts`（新建） |
| 命令注册装配（Do1–Do7、B6 先读后写、fail-soft） | `packages/ops-extension/src/commands.ts`（`registerOpsCommands` 内追加 `ops-audit` 块） |
| 单测（T1–T3） | `packages/ops-extension/test/audit-view.test.ts`（新建） |
| runtime 探针（T5） | `packages/ops-extension/test/runtime/12-ops-audit.sh` + `probes/ops-audit-dataplane-probe.ts`（新建） |
| 文档（B1 可发现） | `README.md`「斜杠命令（只读）」表 +1 行 |

## 三、步骤留痕

- [x] S0 分支 `feature/OPSAUDIT-3-impl` 建立，工作区干净；本记录落盘
- [x] S1 红灯：`test/audit-view.test.ts` 先行（模块未建，bun test 红：1 error）
- [x] S2 绿灯：`src/audit-view.ts` 实现，T1–T3 全绿（15 pass / 0 fail）后提交 87af224
- [x] S3 装配：`commands.ts` 注册 `ops-audit`，typecheck 0 错（b29e5a1）
- [x] S4 探针 + README（runtime 2/2 过；bd98643），npm test 全量 181 pass/1 skip/0 fail
- [x] S5 对照自检三表（下）+ ledger report 自报

## 四、对照自检三表（S5）

### 4.1 方案对齐度

| Do 项 | 落地点 | 与方案一致 |
|---|---|---|
| 收窄/解析/格式化纯函数（Do10） | `src/audit-view.ts`（新建 112 行，三导出函数 + 类型） | ✓ |
| 命令注册装配（Do1–Do7） | `src/commands.ts:106-131`（解析→getBranch→收窄→格式化→notify→自审计；先读后写；fail-soft） | ✓ |
| B7 空态 + 范围声明 / B4+T1 截断 | `audit-view.ts` `formatAuditReport` / `parseAuditLimit` | ✓ |
| B8 写入侧零改 | `git diff 9142a43..HEAD -- src/hooks.ts` = 空（实测） | ✓ |
| B9/D2 不注入 | 无 `registerTool`、`buildomoSystemPrompt` 未动（diff 证明） | ✓ |
| B1 可发现 | `README.md:179` 命令表 +1 行 | ✓ |

偏离说明：仅一处实现内部措辞统一——`parseAuditLimit` 两类错误合并为单条规则文案「参数须为正整数（1–200）」（B4 语义不变）；另修正测试自身错误两处（t() 助手生成非法 ISO、`[bad-ts]` 子串断言），提交信息已注明。

### 4.2 测试证据（真实输出）

| 验证手段 | 命令 | 结果 |
|---|---|---|
| 单测 T1–T3 | `bun test packages/ops-extension/test/audit-view.test.ts` | **15 pass / 0 fail**（53 expect，151ms） |
| 全量回归 T6 | `npm test` | **182 tests：181 pass / 1 skip（bwrap 不可用，环境性）/ 0 fail**（14 文件） |
| 类型契约 T4 | `npm run typecheck` | 双包 tsc --noEmit **0 错** |
| runtime 数据面 T5 | `bash test/runtime/12-ops-audit.sh`（真实 omp 会话） | **2 过 / 0 败**（count=2；字段可辨；报告头/单行化 ✓） |
| 写入侧零改 T6 | `git diff 9142a43..HEAD -- src/hooks.ts` | 空 |

### 4.3 未兑现项（显式登记）

| # | 项 | 状态 |
|---|---|---|
| 1 | U2 交互端到端人工冒烟（TUI 输入 `/ops-audit`、`/ops-audit 2`、`/ops-audit abc`） | 待执行——需交互会话，本会话无法驱动 TUI；数据面+格式化面已由探针与单测覆盖 |
| 2 | 试点收口后 `dsh-suite-architecture-map` 补录 oh-my-ops | 知识任务，不阻断（评审备注 c） |
