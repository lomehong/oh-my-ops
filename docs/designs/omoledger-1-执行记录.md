# OMOLEDGER-1 执行记录 — 台账工具「冒号字符串」改写缺陷：解析器修复 + 数据复原 + 校验闸门接线

> 任务号：OMOLEDGER-1 ｜ 分支：`main`（本次修复落点） ｜ 动作级别：L1
> 依据：主人指令「系统性修复这个问题」（2026-09-27 会话）；症状首次暴露于 CIPORT-1.yaml 落定后的台账核对
> 症状：任一 save（new/claim/report/reject/rescope/confirm/archive）都会全量重写台账文件；对含 **ASCII 冒号**的列表项字符串（`npm run test:ci`、`21:32:48`、URL、`node:test`、权限名 `ops:exec`），parse() 把字符串误判为 `- k: v` 映射，回写时改写成 `- '…X: 'Y…'''`——**语义被污染（字符串→映射）且文本逐次漂移**。全仓已有 46 项 / 22 文件受损，且该缺陷类自工具诞生起无任何闸门看守（`ledger:selftest`/`ledger:validate` 定义了但从未接入任何链）。

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令/夹具 | 预期观察（红 → 绿） |
|---|---|---|---|
| A1 | 解析器往返：含冒号字符串必须按字符串往返 | `node scripts/task-ledger.mjs --selftest`（用例 1b） | 红：`✗ 含冒号字符串往返（脚本名/时间/URL）`，`自检：10 通过 / 1 失败`（exit 1）；绿：`自检：11 通过 / 0 失败`（exit 0） |
| A2 | 数据复原：46 项逐项与 git 历史对账 | `scan/classify/gitcheck/repair/verify`（E:/tmp/lgr/ 草稿工件） | 红：24/44 文件命中 54 项（46 项已被 mangle，8 项本就规范）；绿：修复后 `规范性：44/44 全部规范（emit∘parse 恒等）`、`列表项字符串：426 规范 / 0 非规范` |
| A3 | 闸门负例：mangle 台账（结构可解析、文本非规范）必须被校验拒绝 | `--selftest`（用例 1c：BAD.yaml 夹具）+ `--validate` | 红：`✗ 非规范台账被校验拒绝（文本 mangle 但结构可解析）`，`自检：11 通过 / 1 失败`（当前 --validate 仅结构校验，放过 mangle）；绿：`自检：12 通过 / 0 失败`；仓库 `✓ 台账校验通过（结构 + 文本规范性，共 44 个）` |
| A4 | 端到端：真实 CLI 三次落盘（new→claim→report）文本不打回原形；旧解析器同文件必损坏 | `node e2e-check.mjs`（草稿根 E:/tmp/lgr/e2e） | 红=预期负例：旧解析器把 `accept[0]` 读成对象、重写文本 ≠ 原文、4 行损坏；绿：15/15，三次落盘逐行重编码恒等 + 值逐字不失真 + `--validate` 通过 |
| A5 | 接线：台账校验入 test:ci（13→15 步），全链实跑绿 | `npm run test:ci`；措辞点 `grep "15 步"` | 红（接线前）：`ledger:selftest`/`ledger:validate` 在链中缺席；绿：15 步全绿（§3.4 实测），措辞点 4 处同步 |

## 二、Do → 文件/行映射

| 改动 | 落点 |
|---|---|
| 解析器判定修复（以 `'` 开头一律按字符串） | `scripts/task-ledger.mjs:86-88` |
| selftest 用例 1b（冒号往返）+ 1c（闸门负例） | `scripts/task-ledger.mjs:327-329`、`:330-343` |
| `--validate` 并入文本规范性（emit∘parse 恒等）+ 输出计数 | `scripts/task-ledger.mjs:309`、`:314`；用法注释 `:27` |
| test:ci 接线（l2 之后、快速失败优先） | `package.json:15` |
| 步数措辞 13→15 | `.githooks/pre-push:2,14`；`README.md:337`（并补 `:340` ledger:validate 说明）；`.github/workflows/release.yml:29` |
| 数据复原：46 项列表项字符串 | `docs/tasks/*.yaml`（22 文件）；其中 OPSP-P0.yaml 顺带归一空行（文本级额外归一 1 处） |

## 三、对照自检（实际输出）

### 3.1 A1 解析器红 → 绿

```
# 红（修复前，selftest 已加用例 1b）
✗ 含冒号字符串往返（脚本名/时间/URL）
自检：10 通过 / 1 失败            （exit=1）

# 绿（修复 parse 列表项判定后）
自检：11 通过 / 0 失败            （exit=0）
```

根因：列表项分支 `const kv = rest.match(/^([^:]+):\s*(.*)$/)` 对**任意**含 ASCII 冒号的项生效——引号串首字符 `'` 满足 `[^:]+`，`- '全量枚举：test:ci …'` 被解析为映射 `{'全量枚举：test': "ci …'"}`；save() 全量 emit 后成 `- '全量枚举：test: 'ci …'''`。修复：`rest.startsWith("'") ? null : …`（emit 契约：字符串必带引号、映射键为裸标识符）。mangle 后是旧解析器的**不动点**（旧 parse∘emit 恒等），故漂移只发生一次但永不自愈。

### 3.2 A2 数据复原（46 项 / 22 文件）

- 扫描：44 台账中 24 文件命中 54 项「含 ASCII 冒号的列表字符串」；分类 8 项本就规范、46 项已被 mangle。
- 复原公式：`原值 = kv1.slice(1) + ":" + parseScalar(kv2).slice(0,-1)`（kv1/kv2 为旧解析器捕获）。**盲区**：首个 ASCII 冒号后若原有空格（`: `）被 `\s*` 吞掉、无法从文本恢复——逐项与 git 历史交叉核对（`gitcheck`），命中 2 例真空格形态：`系统: X`（KBORG-1，依据 bd4dea2）、`TIER_TABLE: WRITE`（OPSP-P8，依据 f2a1bc6）。
- 证据分级：TIER1 = git 历史存在完全一致的干净原值（29 项）；TIER2 = 无 git 干净版（17 项），判据 = token 性质（npm 脚本名 `test:ci`、`node:test`、时间 `12:42`、URL、权限名 `ops:exec` 均无空格惯例）+ 同作者惯例（OMOBRIDGE-2 的 `device:from.device`）。
- 复核（脚本化）：`规范性：44/44 全部规范（emit∘parse 恒等）`；`列表项字符串：426 规范 / 0 非规范`；`node scripts/task-ledger.mjs --validate` → `✓ 台账校验通过（结构 + 文本规范性，共 44 个）`（exit 0）。
- 备份：复原前全量快照在 `E:/tmp/lgr/backup/`（本机草稿，不入库）；逐条审计报告 `E:/tmp/lgr/repair-report.txt`、git 对账 `gitcheck.txt`。

（修复后分类器的 2 处「DIRTY」残留为假阳性——复原公式无法表达空格形态，非真差异；权威判据 = 规范性恒等 + git 原始值，均通过。）

### 3.3 A4 端到端（真实 CLI，15/15）

```
✓ new/claim/report：逐行重编码恒等（无 mangle 行）      ×3
✓ new/claim/report：accept 值逐字不失真                ×3
✓ new/claim/report：文本规范（emit∘parse 恒等）        ×3
✓ report：summary/evidence 值不失真；状态机推进到 待确认
✓ validate：草稿根校验通过 — exit=0
✓ 负例：旧解析器把字符串误读为映射（accept[0] 为对象）
✓ 负例：旧解析器重写文本 ≠ 原文本（mangle 复现）
✓ 负例：mangle 行在旧输出中出现 — 损坏 4 行
E2E：全部通过
```

### 3.4 A5 接线 + 全链实跑

```
# 闸门负例红 → 绿（用例外壳化验证「闸门有牙齿」）
✗ 非规范台账被校验拒绝（文本 mangle 但结构可解析）    自检：11 通过 / 1 失败（exit=1）
（实现 --validate 规范性检查后）                     自检：12 通过 / 0 失败（exit=0）
✓ 台账校验通过（结构 + 文本规范性，共 44 个）
```

test:ci 链（15 步）实跑：首轮/次轮（Windows 形态 cwd）在 `test:install` [4c] 处 2 项假红（`✗ 适配器落点缺失或与基准不符` + `✗ 复位失败，后续断言不可信`，`TESTCI_EXIT=1`）——**与台账改动无关**：根因定位为 CIPORT-2（coreutils 对 Windows 形态路径的哈希转义前缀），单独修复后补跑。本任务相关链段（l1/l2/ledger:selftest/ledger:validate）在含 CIPORT-2 修复的两次全链实跑（Windows 形态 + POSIX 形态各一次）中均绿；全链结果见 `docs/designs/ciport-2-执行记录.md` §3.4。

## 四、遗留与限制（不静默）

1. **老设备风险**：未同步本次修复的 checkout 保存台账仍会写脏；接入的 pre-push 闸门（ledger:validate）会在其推送时**红灯阻断**——这正是不静默设计：设备需拉取修复后再保存。修复前入库的既有脏数据已全量复原（本次）。
2. **TIER2 17 项**无 git 干净版，按 token 性质/同作者惯例判定；若主人逐条复核有异议，可按 `repair-report.txt` 条目回改。
3. 台账工具为「文件台账 + 受限 YAML 子集」；`--validate` 现含文本规范性，手工编辑（空行/注释/引号风格）会被拒绝——这是刻意收严：台账为工具托管物，需经工具落盘。
4. `E:/tmp/lgr/` 全部为本机草稿（备份/报告/探针），不入库。
5. 本任务收口动作（confirm → 已落定）为主人专属，代理不代做。
