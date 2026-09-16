# OMOINSTALL-5 执行记录 — bootstrap 版本解析修复

> 任务号：OMOINSTALL-5 ｜ 分支：`feature/OMOINSTALL-5` ｜ 改动件：`scripts/bootstrap.sh`、新增 `scripts/probe-bootstrap-version.sh`、`package.json`
> 触发：对端 `sec-agent-manager-172-26-5-121` 执行 README 一行安装（bootstrap）时三源全落 `latest` → `版本「latest」非 semver——拒绝下载`（2026-09-16）

## 一、测试清单（先有验收后有代码）

| # | 可执行验收 | 命令 | 预期（红 → 绿） |
|---|---|---|---|
| B1 | 「200 直返页面、无重定向」也能解析出版本（策略②） | `bash scripts/probe-bootstrap-version.sh` 场景 1（本地假代理） | 红：`返回非 semver 版本「latest」` ×3 源后拒绝（复刻对端原文）；绿：解析出 `v0.9.1` |
| B2 | 资产 302 重定向优先（策略①） | 同上场景 2 | 绿：`Location: …/download/v0.9.2/install.sh` → 解析出 `v0.9.2` |
| B3 | `--resolve-only` 与 `OMO_VERSION` 协同 | 同上场景 3 | 绿：指定版本时不做解析，仅打印版本 |
| B4 | 语法门 | `bash -n scripts/bootstrap.sh` | PASS |
| B5 | 全量门 | `npm run test:ci`（已纳入 test:bootstrap） | 全绿 |

## 二、根因与落点

| 缺陷 | 根因 | 落点 |
|---|---|---|
| 三源全落 `latest` | 解析只认 `releases/latest` 的 **302 重定向**（取 `url_effective` 的 basename）。直连被代理/镜像以 **200 直返页面**应答时 basename 恒为 `latest` | `scripts/bootstrap.sh` `[1/4] 解析版本`：新增 `resolve_version()` 三策略（① 资产 `Location` 头 → `/download/vX.Y.Z`；② 页面内 `/releases/tag/vX.Y.Z`；③ 原 `url_effective`），并加 GitHub API `tag_name` 末位回退 |
| 无法定位解析行为 | 无观测入口 | 新增 `--resolve-only`（仅解析并打印版本后退出；其余参数原样透传 `install.sh`） |

## 三、对照自检（实际输出）

| 项 | 证据 |
|---|---|
| 红（旧解析逻辑，v0.9.1 `HEAD` 段） | 取 `git show HEAD:scripts/bootstrap.sh` 的解析段，在本地假代理（200 直返、页面含 tag 链接）下运行 → 输出与对端一字不差：`源 direct 返回非 semver 版本「latest」，跳过` ×3 + `✗ 版本「latest」非 semver——拒绝下载` |
| 绿（修复后） | `bash scripts/probe-bootstrap-version.sh` → **全绿 3/3**（0.6s，纯离线确定性；假代理 `HTTP/1.0` + 线程化，pid 落盘避免管道占用） |
| 真机直连（本容器） | `curl -w '%{url_effective}' …/releases/latest` → `/releases/tag/v0.9.1`；API `tag_name` → `v0.9.1`；资产 `latest/download/install.sh` → `Location: …/download/v0.9.1/install.sh`（三条路径均可用，故三层策略冗余合理） |
| 全量门 | `npm run test:ci`（含 test:install + test:bootstrap）全绿 |
| 语法 | `bash -n scripts/bootstrap.sh` PASS |

## 四、未兑现项

- **v0.9.2 发布**：需主人授权打 tag——发布后对端 README 一行命令可直接安装（无需 `OMO_VERSION` 手工指定）。
- **对端验收**：对端以「一行安装成功 + `omo status` 正常」为验收；本记录提交时对端未执行（其变更需 Owner 预授权）。
- **未修（已登记，跨任务）**：启动时 7 条 `Custom tool load failed` 噪音（宿主扫描 `$EXT/ops-pi/tools/*.ts`，见 OMOINSTALL-4 记录）。
