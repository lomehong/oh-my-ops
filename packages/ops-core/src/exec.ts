import { spawn } from "node:child_process";
import { OpsError } from "./errors.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	/** stdout/stderr 任一触到 maxOutputBytes 上限被截断；上游据此分支（如 FileOps 拒绝返回不完整文件） */
	truncated?: boolean;
}

export interface ExecOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	cwd?: string;
	env?: Record<string, string>;
	maxOutputBytes?: number;
	/** 通过 stdin 管道传给子进程的内容（P13：远程文件写入；ssh 会把本地 stdin 转发给远端命令） */
	stdin?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * 本地命令执行：execFile + 参数数组，从源头杜绝 shell 注入（方案 §7.1）。
 * 仅在 L1 内部使用；工具层不得透传 shell 字符串。
 */
export class ShellExec {
	async exec(cmd: string | readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		// 字符串形式按空白拆分为 argv（仍不经 shell；不支持引号分组——含特殊字符请用数组形式）
		const argv: string[] = typeof cmd === "string" ? cmd.trim().split(/\s+/) : [...cmd];
		if (argv.length === 0) throw new OpsError("EXEC_FAILED", "命令为空");
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const startedAt = Date.now();

		return await new Promise<ExecResult>((resolve, reject) => {
			const child = spawn(argv[0]!, argv.slice(1), {
				cwd: options.cwd,
				env: options.env === undefined ? undefined : { ...process.env, ...options.env },
				signal: options.signal,
			});

			// 增量字节计数封顶：旧实现每个 chunk 对累计串做全量 Buffer.byteLength（10 MiB 上限下 O(n²)）
			let truncated = false;
			const makeSink = () => {
				let text = "";
				let bytes = 0;
				return {
					get text(): string {
						return text;
					},
					push(chunk: Buffer): void {
						if (bytes >= maxOutputBytes) {
							truncated = true;
							return;
						}
						if (bytes + chunk.length <= maxOutputBytes) {
							text += chunk.toString("utf8");
							bytes += chunk.length;
							return;
						}
						text += chunk.subarray(0, maxOutputBytes - bytes).toString("utf8");
						bytes = maxOutputBytes;
						truncated = true;
					},
				};
			};
			const out = makeSink();
			const errOut = makeSink();
			child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => errOut.push(chunk));

			// stdin 管道：内容一次性写入后关闭；子进程提前退出时的 EPIPE 属预期，交由 exitCode 判定
			if (options.stdin !== undefined) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(options.stdin, "utf8");
			}

			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, timeoutMs);

			const onAbort = () => child.kill("SIGKILL");
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				const code = options.signal?.aborted ? "TIMEOUT" : "EXEC_FAILED";
				reject(new OpsError(code, `命令执行失败：${argv[0]}`, { cause: error }));
			});
			child.on("close", (code, signalName) => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				const durationMs = Date.now() - startedAt;
				if (signalName === "SIGKILL" && options.signal?.aborted) {
					reject(new OpsError("TIMEOUT", `命令被取消或超时（${timeoutMs}ms）：${argv[0]}`));
					return;
				}
				if (signalName === "SIGKILL" && code === null) {
					reject(new OpsError("TIMEOUT", `命令超时被终止（${timeoutMs}ms）：${argv[0]}`, {
						cause: new Error(errOut.text || "no stderr"),
					}));
					return;
				}
				let stdoutText = out.text;
				if (truncated) {
					stdoutText += `\n…[输出超过 ${maxOutputBytes} 字节上限，已截断]`;
				}
				resolve({ stdout: stdoutText, stderr: errOut.text, exitCode: code ?? -1, durationMs, truncated });
			});
		});
	}
}
