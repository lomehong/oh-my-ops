import type { ExecOptions, ExecResult } from "./exec.ts";
export type { ExecOptions, ExecResult };

/**
 * 执行通道抽象：本地（ShellExec）与远程（SshPool 的 per-host 绑定）共用同一签名。
 * L1 能力类（Process/Log/File…）依赖此接口而非具体实现，即可透明支持远程目标（P7）。
 */
export interface Runner {
	exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult>;
}
