# OMOINSTALL-3 实现执行记录（自包含安装器）

> 方案：`docs/designs/omo-install-selfcontained-design.md`（已落定；C1=双 variant 全嵌 471MB）
> 分支：`feature/OMOINSTALL-3-impl`（自 `feature/OMOINSTALL-2-design` 顶端切出）
> 纪律：小步提交；真实输出留痕；超范围即停。

## 一、测试清单（方案 §5 转写）

| # | 清单项 | 入口 | 预期 |
|---|---|---|---|
| T1 | 构建管线可复跑 | `bash scripts/build-omp-runtime.sh` | 产出 `dist/omp-single`，`--version`=omp/18.1.18；sha256 pin 不符即失败 |
| T2 | bootstrap semver 校验（A6） | 内联用例（10 例）+ 真机 vlatest 场景 | `latest/vlatest/空/1.2/v1.2.3.4/abc` 拒；`v0.6.1` 过 |
| T3 | 安装契约（A1/A2/A3/A5） | 隔离 HOME 冒烟（staged 发布包结构） | 一条命令装成；宿主 HOME 无 `.omp`；状态全在 `~/.omo/home/.omp`；卸载干净；`omo status` ✓ |
| T4 | 回归 | `npm test` + `npm run typecheck` + `12-ops-audit.sh` | 全绿（产品零改动） |
| T5 | CI 打包/门禁 | push tag → release.yml | 构建 omp-single 岗 + 打包含 omp-single + L2 门含 audit-view |
| T6 | 真实环境 A7（主人） | logstash-124 安装 v0.7 + D-1 S1–S7 | 手册判据全过 |

## 二、Do → 文件映射

| Do | 文件 |
|---|---|
| 构建管线（Do1/A4） | `scripts/build-omp-runtime.sh`、`scripts/embed-pi-natives.mjs`（新） |
| semver 校验（Do8/A6） | `scripts/bootstrap.sh`（semver_ok + 解析循环改造） |
| 安装器（Do3–Do7/A1–A3/A5） | `scripts/install.sh`（v4 全量重写） |
| CI 打包/门禁（A4/T5） | `.github/workflows/release.yml` |
| 文档 | `README.md` 安装/升级/卸载段重写 |

## 三、步骤留痕

- [x] S0 分支 + 本记录
- [x] S1 管线脚本 + 本地出 `dist/omp-single`（471MB，`--version`=omp/18.1.18）→ 0d2d6e6
- [x] S2 bootstrap semver 校验 + 10 用例全过 → 130373c（S2/S3 合并提交序列见 git log）
- [x] S3 install.sh v4 + 隔离 HOME 冒烟 7/7 → 130373c
- [x] S4 release.yml（构建岗/打包 omp-single/L2 门含 audit-view）+ README
- [x] S5 对照自检三表（下）+ ledger report

## 四、对照自检三表

### 4.1 方案对齐度

| Do 项 | 落地点 | 一致 |
|---|---|---|
| 构建管线（Do1/A4） | `scripts/build-omp-runtime.sh`（pin 18.1.18 + sha256 edb4fec4… → bun install → embed-pi-natives 生成 embedded-addon.js → 品牌 patch → bun compile） | ✓ 实测出 471MB omp-single |
| bun 自动装（Do4/T3） | `install.sh` ensure_bun：官方脚本直连 → npmmirror zip 回退（zip_extract 多后端 unzip/python3/bsdtar/7z）；锁 1.4.2 | ✓ 冒烟实证（本容器官方通道失败，镜像通道成功——正是 CN 场景） |
| `~/.omo` 布局 + HOME 重定向（Do3–Do5） | `install.sh` 布局 + 启动器 `export HOME=$OMO_DIR/home` | ✓ 冒烟：宿主 HOME 无 `.omp` |
| semver 校验（Do8） | `bootstrap.sh` `semver_ok()` + 解析循环拒非 semver 源 | ✓ 10 用例 |
| 升级/卸载（A5） | `omo upgrade`（拉 latest install.sh）/ `install.sh --uninstall`（确认 + marker 校验防误删） | ✓ 冒烟 |
| CI（A4/T5） | release.yml：构建岗 + 打包含 `dist/omp-single` + L2 门含 audit-view | ✓ 已改（待下个 tag 实证） |
| 产品扩展语义零改动（D5） | `git diff`：packages/ops-extension/src 仅探针类型标注；hooks.ts 零改 | ✓ |

偏离说明：① 探针 dump 时机收敛为 session_start（原 turn_end 兜底删除——turn_end 未在平台类型面声明，且 session_start dump 实证充分）；② pi-natives 嵌入描述由管线脚本生成（上游 embed-native.ts 不随 npm 分发）——两者均为实现细节，方案语义不变。

### 4.2 测试证据（真实输出）

| 验证手段 | 命令 | 结果 |
|---|---|---|
| 构建管线 T1 | `bash scripts/build-omp-runtime.sh` | `omp-single` 471MB；`--version` → `omp/18.1.18`；品牌 7 面 ✓ |
| semver T2 | 内联 10 用例（4 过集 + 6 拒集） | 10 过 / 0 败 |
| 安装契约 T3 | `HOME=/tmp/omo-smoke bash <staged>/scripts/install.sh` + 断言 | **7 过 / 0 败**（A1/A2/A3/A5） |
| 回归 T4 | `npm test`；`npm run typecheck`；`12-ops-audit.sh` | 182 tests：181 pass/1 skip(bwrap)/0 fail；typecheck 0 错；探针 2 过/0 败 |
| CI T5 | push tag 后 release.yml 实证 | 待下个 tag（本提交链已含全部要素） |

### 4.3 未兑现项（显式登记）

| # | 项 | 状态 |
|---|---|---|
| 1 | T5 CI 实证：需 push tag 触发（等实现评审 + 主人确认后随发布 tag 一并验证） | 待发布 |
| 2 | T6 真实环境 D-1（A7）：主人在 logstash-124 以新安装器部署后执行 | 待主人 |
| 3 | suite-map 补录 oh-my-ops（知识任务，承前） | 不阻断 |
