# CIPORT-2 执行记录 — sha256 读取「Windows 形态路径转义前缀」缺陷：三处哈希读取剥离 + 双探针形态自证

> 任务号：CIPORT-2 ｜ 分支：`main` ｜ 动作级别：L1
> 依据：OMOLEDGER-1 全链验证中 `test:install` [4c] **链内假红**（run#1/run#2 日志在案），根因不在台账改动
> 症状：同一适配器文件，**从 Windows 形态 cwd**（`E:\...`；如 PowerShell/资源管理器派生的 git 客户端、或本工具默认 cwd）运行 `test:install`，[4c] 的「落点 vs 仓库基准」断言**必红**；从 POSIX 形态 cwd（Git Bash 默认 `/e/...`）运行全绿。**文件本体无差异**（`cmp` 实证逐字节一致），红在**哈希字符串形态**。

## 一、根因（机制，直接实证）

GNU coreutils 规定：被哈希的**文件名参数含 `\` 或换行**时，输出行以 `\` 转义标记开头（文件名内 `\` 双写）。Windows 形态 REPO_ROOT 派生出的路径（`E:\Development/...`）恰含 `\` ⇒

```
$ sha256sum "$(cd "scripts/.." && pwd)/vendor/yuyi-omp-extension.js" | awk '{print $1}'   # Windows 形态 cwd
\ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751     ← 带转义前缀（红因）
$ sha256sum /e/Development/Code/nodejs/ops-pi/vendor/yuyi-omp-extension.js | awk '{print $1}'   # POSIX 形态
ec25ec8e929014ca209ab616b3b7cb8fc1c354f3b305014eda323815a82d3751      ← 干净
```

REPO_ROOT 由 `cd "$(dirname "$0")/.." && pwd` 派生，`pwd` 继承调用方的路径形态 ⇒ **同一台机器、同一份文件，仅因调用方 cwd 形态不同，哈希字符串即不同**；凡「跨形态来源比对」（仓库文件 vs /tmp 落点、仓库文件 vs 清单）在没有剥离前缀时**必然误判**。

受影响面（暴露判据 = 哈希输入是否含 `\`）：

| 站点 | 哈希输入 | 暴露 | 影响 |
|---|---|---|---|
| `scripts/probe-install-ops-core.sh` `sha_of` | `$REPO_ROOT/vendor/…`（cwd 形态派生） | **是**（链内假红已实证） | 从 **Windows 形态 PWD 的 shell** 直调 `test:install`/`test:ci` ⇒ [4c] 必红（工具/IDE/代理直调场景；本轮 run#1/#2 即现场）。**注**：本仓 pre-push 钩子内 `cd "$(git rev-parse --show-toplevel)"` 会归一到 `E:/…` 形态 ⇒ 钩子路径此前未触发（修复消除整类，不依赖调用形态巧合） |
| `scripts/install.sh` `sha256_of` | `$YUYI_SRC="$REPO_ROOT/vendor/…"`（cwd 形态派生） | **是** | 从 Windows 形态 PWD 的 shell 直跑 `bash scripts/install.sh`（如 PowerShell 内）⇒ 假「完整性校验失败」**拒装** |
| `scripts/probe-vendor-integrity.sh` `sha256_of`/`md5_of` | 现用相对路径（`vendor/…`，不含 `\`） | 潜在（改用绝对路径即暴露） | 同类闭口（防未来回归） |
| serve 自戳三处（`install.sh:299/322/364`）、`omo-kb-doctor.sh:89` | 启动器路径（PATH 解析，**非 cwd 派生**；同机形态稳定） | 否 | 仅警示性启发式（误报「升级前进程」，不阻断任何门）⇒ 本轮不改，以本表留审计记录 |

## 二、修复与防回归

| 改动 | 落点 |
|---|---|
| `sha_of` 剥离转义前缀（coreutils/shasum 两分支） | `scripts/probe-install-ops-core.sh:97-101` |
| `sha256_of` 剥离转义前缀 | `scripts/install.sh:56-61` |
| `sha256_of`/`md5_of` 剥离转义前缀 | `scripts/probe-vendor-integrity.sh:28-37` |
| [4c] 形态无关性自证（cygpath 强制 Windows 形态；同文件两形态必须同摘要） | `scripts/probe-install-ops-core.sh`（[4c] 落点断言之后） |
| [1] 形态无关性自证 | `scripts/probe-vendor-integrity.sh`（[1] 清单比对之后） |

**剥离恒安全的论据**：十六进制摘要字符集为 `[0-9a-f]`，不含 `\`；`sed 's/^\\//'` 只剥**行首**一个 `\`。sedcheck 实证：`lead-stripped: lead`（行首剥离生效）、`plain-intact: plain`（干净输入不动）、`mid-intact: mid\dle`（中途 `\` 不误伤）。

## 三、对照自检（实际输出）

### 3.1 红基线（修复前）

```
# 全链 run#1（Windows 形态 cwd）：链停在 test:install
[4c] Yuyi 适配器完整性闸门（OMOVENDOR-1）：安装前校验 + 篡改即中止
  ✓ 发布布局含完整性清单
  ✓ 发布布局含溯源件
  ✗ 适配器落点缺失或与基准不符（落点 /tmp/tmp.IDy32JkCM0/h1/.omo/extensions/yuyi-omp-extension.js）
  ✓ 指纹不符即中止并明确报错
  ✓ 校验失败不落盘适配器
  ✗ 复位失败，后续断言不可信
# run#2 同两行 ✗ + TESTCI_EXIT=1（确定性复现）

# 形态对照（同一命令、仅 cwd 形态不同）：
run#1/#2 与修复前复现：installer: E:\Development/Code/nodejs/ops-pi/scripts/install.sh   → [4c] 红
rerun1（独立重跑，forward-slash 形态）：installer: E:/Development/Code/nodejs/ops-pi/scripts/install.sh → 结果：全绿
```

### 3.2 变异负例自证（新增断言有区分力）

```
$ bash /e/tmp/lgr/guardcheck.sh
[old] FAIL 形态相关（W=\ec25ec8e929014c… ≠ U=ec25ec8e929014ca…）   ← 未修复实现必被抓住
[new] PASS 形态无关（ec25ec8e929014ca…）                            ← 修复实现通过
```

### 3.3 绿：此前假红上下文 `test:install` 全绿（52 项 ✓，exit=0）

```
$ npm run test:install        # Windows 形态 cwd（原假红上下文）
installer: E:\Development/Code/nodejs/ops-pi/scripts/install.sh
[4c] …
  ✓ 适配器落点存在且与仓库基准一致                      ← 原红行
  ✓ 哈希读取与路径形态无关（Windows 形态 ≡ POSIX 形态）   ← 新增自证
  ✓ 指纹不符即中止并明确报错 / ✓ 校验失败不落盘适配器 / ✓ 篡改负例后已复位 / ✓ 清单缺失即拒并说明原因
结果：全绿
```

### 3.4 全链（test:ci 15 步 ×2：两种 cwd 形态）

| 上下文 | 命令 | 结果 |
|---|---|---|
| Windows 形态 cwd（工具默认；原假红上下文） | `npm run test:ci` | **`A_EXIT=0` 全绿**（`✗` 计数 0；[4c] 原红行 + 形态自证均 ✓；日志 `E:/tmp/lgr/testci-win-postfix.log`） |
| POSIX 形态 cwd（Git Bash 推送门实际上下文） | `npm run test:ci` | **`B_EXIT=0` 全绿**（`✗` 计数 0；链内 `ledger:selftest` 12/0、`ledger:validate` 46/46；日志 `E:/tmp/lgr/testci-posix-postfix.log`） |

两次链内：`✓ 哈希读取与路径形态无关` 各出现 2 次（probe-install [4c] + probe-vendor [1]）；负例自证各 1 次（回退版探针 `结果：9 通过 / 6 失败`、红在预期项 T2/T9/T10）。

## 四、遗留与限制（不静默）

1. 同类站点审计结论见 §一 表：serve 自戳三处与 doctor 不改动（非 cwd 派生、警示性启发式）；若未来其输入改为 cwd 派生的绝对路径，须同样剥离。
2. `sed` 依赖：install.sh 目标机为 Linux/macOS（sed 为 POSIX 必备）；Windows 经 Git Bash 亦具备。
3. 新增形态自证仅在 MSYS（`cygpath` 可得）下生效；Linux/macOS 路径不含 `\` ⇒ 该类不可能发生，静默跳过符合预期。
4. 本任务收口动作（confirm → 已落定）为主人专属，代理不代做。
