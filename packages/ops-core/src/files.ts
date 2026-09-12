import * as fs from "node:fs/promises";
import { OpsError } from "./errors.ts";

export interface FileReadOptions {
	/** 读取上限（字节）；默认 2 MiB。超限抛 OpsError，提示用分段读取获取全文。 */
	maxBytes?: number;
	/** 取消信号（对接宿主 ctx.signal / 工具 signal） */
	signal?: AbortSignal;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 文件读取（只读）。路径边界由 §7.1 沙箱约束；L1 不做路径白名单（与方案一致）。 */
export class FileOps {
	/** 读取文本文件。目录或超限抛 OpsError；调用方可据 code 分支处理。 */
	async read(path: string, options: FileReadOptions = {}): Promise<string> {
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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
}
