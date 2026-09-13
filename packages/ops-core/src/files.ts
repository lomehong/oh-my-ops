import * as fs from "node:fs/promises";
import { OpsError } from "./errors.ts";
import type { Runner } from "./runner.ts";

export interface FileReadOptions {
	/** 读取上限（字节）；默认 2 MiB。超限抛 OpsError，提示用分段读取获取全文。 */
	maxBytes?: number;
	/** 取消信号（对接宿主 ctx.signal / 工具 signal） */
	signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 文件读取（只读）。路径边界由 §7.1 沙箱约束；L1 不做路径白名单（与方案一致）。 */
export class FileOps {
	private readonly runner: Runner | undefined;

	/** runner 提供时走命令读取（远程目标 P7）；缺省本地 fs。 */
	constructor(runner?: Runner) {
		this.runner = runner;
	}

	/** 读取文本文件。目录或超限抛 OpsError；调用方可据 code 分支处理。 */
	async read(path: string, options: FileReadOptions = {}): Promise<string> {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		if (this.runner) return await this.readViaRunner(path, maxBytes);
		const stat = await fs.stat(path).catch((cause: unknown) => {
			const code = (cause as NodeJS.ErrnoException)?.code === "ENOENT" ? "NOT_FOUND" : "INTERNAL";
			throw new OpsError(code, `读取失败：${path}`, { cause });
		});
		if (stat.isDirectory()) throw new OpsError("NOT_FOUND", `路径是目录而非文件：${path}`);
		if (stat.size > maxBytes) {
			throw new OpsError(
				"POLICY_DENIED",
				`文件过大（${stat.size} 字节 > 上限 ${maxBytes}）：${path}。请改用分段读取或外部命令。`,
			);
		}
		return await fs.readFile(path, { encoding: "utf8", signal: options.signal }).catch((cause: unknown) => {
			const errno = (cause as NodeJS.ErrnoException)?.code;
			throw new OpsError(errno === "EACCES" ? "PERMISSION_DENIED" : "INTERNAL", `读取失败：${path}`, { cause });
		});
	}

	/**
	 * 写入文本文件（write 档，P8）。父目录须已存在（不静默 mkdir）；
	 * mode 为八进制权限（如 0o600）。远程写入未实现（诚实约束）。
	 */
	async write(path: string, content: string, options: { mode?: number; signal?: AbortSignal } = {}): Promise<void> {
		if (this.runner) throw new OpsError("POLICY_DENIED", "远程写入尚未实现：write 档当前仅支持本机目标");
		await fs.writeFile(path, content, { encoding: "utf8", mode: options.mode ?? 0o644, signal: options.signal })
			.catch((cause: unknown) => {
				const errno = (cause as NodeJS.ErrnoException)?.code;
				throw new OpsError(errno === "EACCES" ? "PERMISSION_DENIED" : "INTERNAL", `写入失败：${path}`, { cause });
			});
	}

	/** 远程读取：stat 取大小 → cat 取内容（上限内），复用同一错误语义 */
	private async readViaRunner(path: string, maxBytes: number): Promise<string> {
		const runner = this.runner;
		if (!runner) throw new OpsError("INTERNAL", "readViaRunner 在无 runner 时被调用");
		const stat = await runner.exec(["stat", "-c", "%s", "--", path], { timeoutMs: 10_000 });
		if (stat.exitCode !== 0) {
			const notFound = stat.stderr.includes("No such file");
			throw new OpsError(notFound ? "NOT_FOUND" : "EXEC_FAILED", `读取失败：${path}：${stat.stderr.slice(0, 200)}`);
		}
		const size = Number(stat.stdout.trim());
		if (!Number.isFinite(size)) throw new OpsError("EXEC_FAILED", `stat 输出异常：${stat.stdout.slice(0, 100)}`);
		if (size > maxBytes) {
			throw new OpsError("POLICY_DENIED", `文件过大（${size} 字节 > 上限 ${maxBytes}）：${path}。请改用分段读取或外部命令。`);
		}
		const cat = await runner.exec(["cat", "--", path], { timeoutMs: 15_000, maxOutputBytes: maxBytes });
		if (cat.exitCode !== 0) {
			const errno = cat.stderr.includes("Permission denied") ? "PERMISSION_DENIED" : "EXEC_FAILED";
			throw new OpsError(errno, `读取失败：${path}：${cat.stderr.slice(0, 200)}`);
		}
		return cat.stdout;
	}
}
