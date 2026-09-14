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
| runtime 探针（T5） | `packages/ops-extension/test/runtime/12-ops-audit.sh`（新建） |
| 文档（B1 可发现） | `README.md`「斜杠命令（只读）」表 +1 行 |

## 三、步骤留痕（随实现追加）

- [x] S0 分支 `feature/OPSAUDIT-3-impl` 建立，工作区干净；本记录落盘
- [ ] S1 红灯：`test/audit-view.test.ts` 先行（模块未建，bun test 红）
- [ ] S2 绿灯：`src/audit-view.ts` 实现，T1–T3 全绿后提交
- [ ] S3 装配：`commands.ts` 注册 `ops-audit`，typecheck 绿后提交
- [ ] S4 探针 + README，npm test 全绿后提交
- [ ] S5 对照自检三表 + ledger report 自报
