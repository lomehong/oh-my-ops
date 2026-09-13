import { spawnSync } from "node:child_process";
import type { ExecOptions, ExecResult, Runner } from "@ops-pi/core";
import { OpsError } from "@ops-pi/core";

/**
 * 沙箱（§7.1，P9）：本地 shell 类命令的 bubblewrap 隔离执行。
 *
 * 决策记录（二选一）：选择 **bubblewrap 用户态命名空间**，不选容器化执行——
 *  - 无守护进程/镜像依赖（bwrap 单二进制，unprivileged userns 即可）；
 *  - 与 `curl|bash` 一行安装的零依赖原则一致；
 *  - 容器化执行需要目标机常驻 docker-in-docker，威胁面反而扩大。
 *
 * 隔离档位：/ 整体只读绑定；仅 cwd（项目目录）与 /tmp（tmpfs）可写；
 * unshare ipc；/dev /proc 最小化重建。
 *
 * 语义：enabled 且 bwrap 不可用 → fail-closed（拒绝执行并明示），绝不静默放行。
 */

export interface SandboxOptions {
	/** true = 启用沙箱（OPS_PI_SANDBOX=1） */
	enabled: boolean;
	/** 可写目录（缺省：进程 cwd） */
	writableDir?: string;
}

let bwrapProbe: boolean | undefined;

/** 探测 bwrap 可用性（进程内缓存一次） */
export function probeBwrap(): boolean {
	if (bwrapProbe === undefined) {
		try {
			const r = spawnSync("bwrap", ["--version"], { timeout: 5_000 });
			bwrapProbe = !r.error;
		} catch {
			bwrapProbe = false;
		}
	}
	return bwrapProbe;
}

/** 生成 bwrap argv：/ 只读 + /dev /proc 最小化 + /tmp tmpfs + cwd 可写 */
export function wrapBwrap(argv: readonly string[], writableDir: string): string[] {
	return [
		"bwrap",
		"--ro-bind", "/", "/",
		"--bind", writableDir, writableDir,
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		"--unshare-ipc",
		"--die-with-parent",
		"--",
		...argv,
	];
}

/** Runner 装饰器：启用时把本地命令包进 bwrap；不可用 → fail-closed 拒绝 */
export class SandboxedShell implements Runner {
	private readonly inner: Runner;
	private readonly enabled: boolean;
	private readonly cwd: string;
	private readonly available: boolean;

	constructor(inner: Runner, options: SandboxOptions, available?: boolean) {
		this.inner = inner;
		this.enabled = options.enabled;
		this.cwd = options.writableDir ?? process.cwd();
		this.available = available ?? probeBwrap();
	}

	get isActive(): boolean {
		return this.enabled && this.available;
	}

	exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		const argv = typeof cmd === "string" ? cmd.trim().split(/\s+/) : [...cmd];
		if (!this.enabled) {
			return this.inner.exec(argv, options);
		}
		if (!this.available) {
			return Promise.reject(new OpsError(
				"SANDBOX_UNAVAILABLE",
				"沙箱已启用（OPS_PI_SANDBOX=1）但 bwrap 不可用——fail-closed 拒绝执行。安装 bubblewrap 或取消 OPS_PI_SANDBOX。",
			));
		}
		return this.inner.exec(wrapBwrap(argv, this.cwd), options);
	}
}
