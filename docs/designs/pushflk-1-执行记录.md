# PUSHFLK-1 执行记录 — 推送阻塞 flake 根因修复：kb-enroll 过期码断言确定性化（Windows 跨进程时钟偏差 160–262ms × --ttl 0 零边距）

> 任务号：PUSHFLK-1 ｜ 分支：`main` ｜ 动作级别：L1
> 依据：主人驱动指令「系统性修复这些构建的问题，确保任何设备都可以正确的 git push，打tag触发CI」
> 症状：`npm run test:l2`（⇒ pre-push 预跑 test:ci）在真机上**随机**红于 `kb-enroll.test.ts` 过期码断言；修复前同口径 25 次压力红 2 次。hook 红即 push 被拒 ⇒ **任何设备都可能随机踩中、无法推送**（v0.16.0 后的 main 推送即被此 flake 阻断过一次）。
> 注记：本任务为**事后补记**——修复（13b8f57）与发布（v0.16.1）先于台账立项完成；立项-认领-自报同会话补齐。

## 一、根因（机制，直接实证）

过期码 fixture 用 `issueCode(..., ["--ttl", "0"])` 构造：`expiresAt = 签发进程的「现在」 + 0ms`。判定发生在**另一进程**（enroll 服务侧 `checkCode`）：

```js
if (Date.parse(entry.expiresAt) <= Date.now()) return { ok: false, reason: "expired" };
```

「已过期」成立的条件是 `签发时的 now ≤ 判定时的 now`——即隐含假设**两个进程的 Date.now() 读数一致**。Windows 上实测两进程读数可差 **160–262ms**（签发进程读数偏晚时，0 毫秒码在随后的判定中「尚未到期」）⇒ 服务放行 ⇒ 测试期望的 `/已过期/` 拒绝未发生：

```
error:
Expected promise that rejects
Received promise that resolved: Promise { <resolved> }
      at <anonymous> (packages\ops-extension\test\kb-enroll.test.ts:163:113)
```

产品判定逻辑本身**非缺陷**：生产签发一律分钟级 TTL（`--ttl 30`），毫秒级跨进程偏差无实际影响；缺陷在**测试 fixture 的零边距假设**。

## 二、修复与防回归

| 改动 | 落点 |
|---|---|
| 过期 fixture 改为**回拨 60 秒**（边距 228× 于最大观测偏差 262ms），不再用 `--ttl 0` | `packages/ops-extension/test/kb-enroll.test.ts`（13b8f57，+12/-1） |
| 产品代码零改动（判定逻辑、服务、CLI 均未动） | — |

## 三、对照自检（实际输出）

### 3.1 红基线（修复前，25 次压力；日志 `E:/tmp/lgr/stress-code1.log`）

```
(run #13) 162 | const { code: c3 } = await issueCode(dir, ["--op", "enroll", "--device", "node-1", "--ttl", "0"]);
(run #13) 163 | await expect(enroll({ … })).rejects.toThrow(/已过期/);
error: Expected promise that rejects / Received promise that resolved: Promise { <resolved> }
 23 pass / 100 filtered out / 2 fail / 98 expect() calls / Ran 25 tests across 1 file. [59.94s]
```

### 3.2 变异负例自证（断言有区分力）

```
# 临时注释服务侧过期判定（kb-registry.mjs checkCode）⇒ 断言必须转红
$ bun test --timeout 60000 -t "码是一次性的" packages/ops-extension/test/kb-enroll.test.ts
Expected promise that rejects / Received promise that resolved（0 pass / 1 fail，exit=1）   ← 日志 E:/tmp/lgr/pushflk-1-mutation-red.log
# 复原（逐字节）⇒ git diff -- scripts/lib/kb-registry.mjs 空；复跑绿（1 pass / 4 expects / 0 fail）   ← 日志 E:/tmp/lgr/pushflk-1-revert-green.log
```

### 3.3 绿：修复后压力与全量 l2

```
$ bun test --timeout 60000 --rerun-each 40 -t "码是一次性的" packages/ops-extension/test/kb-enroll.test.ts
 40 pass / 0 fail / 160 expect() calls / Ran 40 tests across 1 file. [57.48s]   ← 日志 E:/tmp/lgr/pushflk-1-postfix-40.log
```

标定注记：该文件默认 5s 超时会被真实子进程冷启打破；压力口径须与 test:l2 一致加 `--timeout 60000`。误标定的一轮已留档 `pushflk-1-postfix-40-miscal-timeout5s.log`（其 2 个 fail 均为 `timed out after 5000ms`，**非缺陷**）。

全量 `test:l2`（链内）：两次全链各 `135 pass / 437 expect() calls / 0 fail / Ran 135 tests across 11 files`。

### 3.4 全链 ×2（冻结树 `9e855242b3741d558eac2cfeca3aadbc24f4f99e`）

| 上下文 | 结果 |
|---|---|
| main 推送门（pre-push 全量 test:ci 15 步） | **全绿** + `2a5fb4d..13b8f57 main -> main`（push-exit=0；日志 `E:/tmp/lgr/push-3.log`） |
| tag 推送门（v0.16.1，同树） | **全绿** + `* [new tag] v0.16.1 -> v0.16.1`（tag-push-exit=0；日志 `E:/tmp/lgr/tag-push-v0161.log`） |

### 3.5 端到端发布核验

- tag `v0.16.1` → Release CI run **36300979845 completed/success**（`测试` + `打包发布` 双 job 全绿，含 vendor 回归探针与两包打包断言）。
- Release「oh-my-ops v0.16.1」5 产物在档；`omo-kb-service-v0.16.1.tar.gz` sha256 与清单一致；`install.sh` 与仓库 `scripts/bootstrap.sh@v0.16.1` 逐字节一致；`oh-my-ops-v0.16.1.tar.gz` sha256 远端复核见 §四。

## 四、遗留与限制（不静默）

1. `oh-my-ops-v0.16.1.tar.gz`（127MB）远端 sha256 复核：本机 `github.com` 直连为 `http=000`，经 `api.github.com` 资产端点下载复核**进行中**（完成即补记；CI 打包步已对包内适配器指纹做断言）。
2. 同类站点审计：全仓 `--ttl` 站点（omo-kb-fleet 30 / provision selftest 30 / probe-install-enroll-service 30）均 30 分钟边距；`daysUntilExpiry` 测试显式传 `base` ⇒ 无其它零边距/时钟敏感断言。
3. 若未来产品需要秒级/零边距过期语义，须改为服务侧单一时钟源设计（本任务按「测试侧确定性化」收口，产品零改动）。
4. 本任务收口动作（confirm → 已落定）为主人专属，代理不代做。
