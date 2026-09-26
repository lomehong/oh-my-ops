# OMOVENDOR-1 执行记录 — adapter vendor 完整性防线

> 任务号：OMOVENDOR-1 ｜ 分支：`feature/OMOVENDOR-1` ｜ 动作级别：L1
> 依据：`docs/reports/yuyi-omp-adapter-reply-path-defects-2026-09-16.md`（缺陷与 D1-D5）、`docs/designs/omobridge-2-执行记录.md` §132（风险自陈：任何一次上游同步都会**静默回退**本修复）
> 症状：`vendor/yuyi-omp-extension.js` 是上游构建拷贝、以「整文件同步」更新；本仓回信修复（D1-D5）在被上游同步覆盖时**没有任何红灯**——安装、发布、本地测试全绿，生产跨设备回信再失败。

## 一、测试清单（先有验收后有代码；对应任务 accept 六条）

| # | 可执行验收 | 命令/夹具 | 预期观察（红 → 绿） |
|---|---|---|---|
| A1 | 回归探针入 test:ci + 直跑入口 | `npm run test:vendor`；`grep test:vendor package.json` | 红：`Missing script: "test:vendor"`；**且直呼脚本在 Windows 上 `ERR_MODULE_NOT_FOUND`（`file:///E:/E:/…`）**；绿：两次连跑 `15 通过 / 0 失败`（exit 0，32s/33s） |
| A2 | 负例自证（探针有区分力） | `node scripts/probe-yuyi-reply-frame.mjs --bundle <D1 回滚件>`（`probe-vendor-integrity.sh` §3 自动化同一负例） | 红=预期结果：`9 通过 / 6 失败`（exit 1），且红在 T2/T4/T6/T9/T10 + 桩 Hub 校验，复现生产原文；全绿反而判失败（探针失去区分力） |
| A3 | 安装前完整性校验 + 篡改负例 | `bash scripts/probe-install-ops-core.sh` → `[4c]` | 红：篡改件**装成功**（闸门失效）；绿：`指纹不符即中止并明确报错` + `校验失败不落盘适配器` + `清单缺失即拒` |
| A4 | 溯源件 + 清单为合并前置条件 | `bash scripts/probe-vendor-integrity.sh` → `[1][2]` | 红：清单/溯源件缺失；绿：`sha256 一致` + `溯源件记录当前 sha256/md5` + `登记上游基准 md5` + `含补丁清单 D1-D5` |
| A5 | 发布门（清单断言 + 打包前探针 + 包内指纹抽验） | `release.yml` 打包 job；本地模拟抽验命令 | 红：`release.yml 未见打包前探针闸门`；绿：`打包清单含适配器` + `打包前跑回归探针` + `校验发布包内适配器指纹`（本地模拟含篡改负例，见 §3.4） |
| A6 | 上游未修残留登记 | `vendor/yuyi-omp-extension.PROVENANCE.md` §四 | 红：无登记；绿：Hub 评论 id/URL + 对端 + 收口方式在位 |

## 二、Do → 文件/行映射

| 改动 | 落点 |
|---|---|
| 直跑入口 + 入 CI 链 | `package.json:15`（test:ci 追加）、`:30-31`（test:vendor / test:vendor-integrity） |
| 探针 Windows 路径缺陷修复 | `scripts/probe-yuyi-reply-frame.mjs:23,28`（`URL.pathname` → `fileURLToPath`） |
| 完整性清单（判据） | `vendor/yuyi-omp-extension.sha256`（新建，sha256sum 格式） |
| 溯源件（来源/补丁/规程/上游残留） | `vendor/yuyi-omp-extension.PROVENANCE.md`（新建） |
| 防线体检脚本 | `scripts/probe-vendor-integrity.sh`（新建，四段：清单/溯源/负例/闸门） |
| 安装前校验（落盘前中止） | `scripts/install.sh:50,54`（YUYI_SUM + sha256_of）、`:186-203`（闸门，含清单缺失拒装） |
| 安装探针断言 + 两条负例 | `scripts/probe-install-ops-core.sh:94-126`（`[4c]`） |
| 发布门：探针步骤 | `.github/workflows/release.yml:65-67`（直呼脚本，不随 package.json 漂移） |
| 发布门：打包清单断言 | `.github/workflows/release.yml:90`（适配器 + 清单 + 溯源件） |
| 发布门：包内指纹抽验 | `.github/workflows/release.yml:110-113`（tar -xzO | sha256sum 对清单） |

## 三、对照自检（实际输出）

### 3.1 A1 直跑入口（红 → 绿）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 红 | `npm run test:vendor` | `npm error Missing script: "test:vendor"` |
| 红（顺带发现） | `node scripts/probe-yuyi-reply-frame.mjs` | Windows：`ERR_MODULE_NOT_FOUND … file:///E:/E:/Development/…`（`URL.pathname` 得 `/E:/…`，再经 `pathToFileURL` 拼成 `E:\E:\…`）；历史证据（OMOBRIDGE-2）均在 Linux 产出，故此前未暴露 |
| 绿 | `npm run test:vendor` ×2 | 两次均 `exit=0`、`结果：15 通过 / 0 失败`，耗时 **32s / 33s**（成本已计入 test:ci） |

### 3.2 A2 负例自证（D1 回滚 = 上游整文件同步回退）

变异式：`to: { device: origMsg.from.device, target: origMsg.from.sessionID ?? origMsg.from.name },`
→ `to: { target: origMsg.from.name ?? origMsg.from.sessionID },`（命中 **2 处**：finalizeTurn L1562 / sendFailureReply L1620；命中数为 0 即判红，防「变异失效导致假绿」）

```
✗ T2 回信目标为 agent 级（device + sessionID） — to={"target":"PEER-DEV-omp"}
✗ 桩 Hub 回信校验接受（agent 级解析） — ok=false 回信去向与原请求发送方不符：目标 "PEER-DEV-omp" 归属 agent (未解析)，原请求发送方为 peer-agent-id
✗ T4 成功投递有日志（可观测） — 日志无成功明细
✗ T6 别名寻址的手工回信：自动补 replyTo 且目标归一到 agent 级 — replyTo=msg_peer_1 to={"device":"PEER-DEV","target":"omp_peer1"} ack=ok
✗ T9 sendFailureReply 覆盖：失败回信帧发出且形态合规 — from.device="HARNESS-DEV" to={"target":"PEER-DEV-omp"} text="[御驿] 注入失败：Erro"
✗ T10 首投拒 → 重试成功（日志双段） — acks=false,false
结果：9 通过 / 6 失败            （exit=1）
```

桩 Hub 裁决复现生产原文（与 OMOBRIDGE-2 红基线同源现象）——**探针能抓住的正是「同步回退」这一动作**。
（对齐：OMOBRIDGE-2 红基线为 `3 通过 / 11 失败`，那次是把 D1+D2+D3+D5 全套回滚；本次只回滚 D1，故红面更小但方向一致。）

### 3.3 A3 安装闸门（`probe-install-ops-core.sh [4c]`）

| 断言 | 结果 |
|---|---|
| 发布布局含完整性清单 / 溯源件 | ✓ / ✓ |
| 适配器落点存在且与仓库基准一致 | ✓ |
| 篡改负例（追加 1 行 → 安装） | ✓ `指纹不符即中止并明确报错` + `校验失败不落盘适配器`（红灯曾为「适配器指纹不符竟安装成功（闸门失效）」） |
| 篡改负例后复位 | ✓ |
| 清单缺失负例（删清单 → 安装） | ✓ `清单缺失即拒并说明原因`（fail-closed：不允许「无基准就放行」） |

### 3.4 A5 发布门（本地模拟，避免只在打 tag 时才首次执行）

- 逐字照抄 release.yml 抽验两行做模拟：清单 `ec25ec8e929014ca…` == 包内件 `ec25ec8e929014ca…` → ✓；
- 负例：包内件追加 1 行后重打包 → `bc68b6c521df74e7…` ≠ 清单 → ✓ 被识别（**抽验有区分力，发布将中止**）；
- `npm run test:workflow` 全绿（工作流结构 + 各 `run:` 块 `bash -n`）。

### 3.5 清单值与「提交/CI 检出的字节」一致性（防 `text=auto eol=lf` 误伤）

`.gitattributes` 为 `* text=auto eol=lf` ⇒ 检出时会做行尾规范化。若不核对，可能出现「本机工作树哈希 == 清单，CI 检出后 != 清单 ⇒ 安装闸门在 Linux 侧误拒」的隐患。实测：

```
sha256sum vendor/yuyi-omp-extension.js                      → ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751
git cat-file blob $(git hash-object --path=vendor/… vendor/…)  → ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751
```

两者一致（vendor 件本就是 LF）⇒ CI 检出件指纹 == 清单值，安装闸门不会误拒。

### 3.6 环境限定红项（预存在，非本次引入；已逐条取证）
| 红项 | 取证 | 结论 |
|---|---|---|
| `probe-install-ops-core.sh [6]` 0600 令牌文件 | Git Bash 实跑 `chmod 600 && stat -c %a` → `644`；对 **HEAD 版安装器**跑同一探针 → 同样红 | Windows 文件系统不表达 POSIX 0600；Linux/CI 不受影响 |
| L1 `ssh.test.ts` 2 项 | `git worktree add --detach HEAD` 纯净树上复跑 → 同样 `pass 8 / fail 2` | 断言依赖 `/tmp/...known_hosts` 语义 |
| L2 14 项（kb 凭据 0600 / 真 git `file://` / HTTP TLS） | `packages/ops-extension/test/*` 对本次改动件**零引用**（grep 证实） | 结构上不可能受本次改动影响 |

> 即：本机（Windows）`npm run test:ci` 无法整体转绿（上述三项预存在）；本次改动的**新段 A1/A2/A3/A4/A5 在 Linux 与本机均绿**（A3 的 0600 段落除外）。

## 四、未兑现项 / 待真机

- **发布门只在打 tag 时真跑**：release.yml 的三处闸门需下一个 `v*` tag 才能在 GitHub 侧实证（本地已做逐字模拟 + 结构守卫，见 §3.4）；
- **安装闸门未在真机（Linux/el7）跑过**：本机 [4c] 全绿，但 0600 类断言按 §3.6 只能在 Linux 实证；
- **上游未修残留（显式登记）**：D1/D2/D3 上游 0.1.0/0.2.0 共有（缺陷报告 §三）；已提交 Hub 文档评论登记——id `2026-09-16T00-05-14-5d5dx2`，URL `http://172.20.10.91:7377/docs/hub-plugin/comments/2026-09-16T00-05-14-5d5dx2`（GET 校验 200），对端 `omo-172-26-5-121` 已知会；同步登记于溯源件 §四。上游若修复并分发，以「上游件 md5 一致 + 探针绿」双证收口（参考 OPSP-P10 先例）。

## 五、可回源性

| 基准 | 来源 | 说明 |
|---|---|---|
| 上游实现 | `/dist/omp.js` v0.1.0，md5 `393e21ba0700a4d5e3008fc80cc65b1b` | ⚠️ 需网络、**未入库**；引用见缺陷报告 §八 |
| 当前 vendor 件 | md5 `5f4df5896c596509c3e2e880afc12cda` / sha256 `ec25ec8e…`（3544 行） | 与 `vendor/yuyi-omp-extension.sha256` 一致（体检 §1 每次核对） |
| 桩 Hub 裁决 | 按生产实测**手写复刻**（非 Hub 源码回源） | 快照说明见 `probe-yuyi-reply-frame.mjs` 头注 |
