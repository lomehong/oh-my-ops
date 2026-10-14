#!/usr/bin/env bun
/**
 * L2 测试入口（跨平台超时，规避 shell 差异）。
 *
 * 背景：Windows 上**任何**新进程创建都需 1.3–2.5 秒（Defender 实时扫描 + DLL 加载；
 * 实测 `node -e "0"` 同等耗时 ⇒ 开销在 OS 进程创建，与 bun / git 内部实现无关，
 * `GIT_OPTIONAL_LOCKS`、隔离 HOME、core.fsmonitor 等开关均无效，最多省 10%）。
 * git 相关用例单例要 spawn 20–30 次进程，固定 60s 在 Windows 上必然超时——
 * 表现为「用例超时失败」而**断言其实全绿**，属纯环境性假红（真机实测：
 * 6 次 git 操作耗时 51 秒）。
 *
 * 为什么不在 package.json 里内联 `$(...)`：Windows 上 npm 用 cmd.exe 执行脚本，
 * `$(...)` 不会被替换而是原样透传，bun 会把 `$(bun ...)` 当成非法超时值
 * （已实测确认）。故由本脚本按平台拼命令并执行，跨平台行为一致。
 *
 * 取值策略（★ bun 的 `--timeout` 单位是**毫秒**，help 明示"in milliseconds"）：
 *   POSIX    60_000ms (60s) —— 保持原值。快环境下的真实挂死仍能被及时发现（不放宽守护能力）。
 *   Windows 600_000ms (600s) —— 覆盖 spawn 开销 × 用例进程数；远低于 CI job 默认 6h 上限。
 *
 * 只放宽超时，不放宽任何断言：真实失败（分支纪律被破坏、凭据入库）在两平台同样被抓。
 */
const MILLIS = process.platform === "win32" ? 600_000 : 60_000;
const proc = Bun.spawn(["bun", "test", "--timeout", String(MILLIS), "packages/ops-extension/test/"], {
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await proc.exited);
