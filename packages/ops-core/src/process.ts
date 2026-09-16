import { OpsError } from "./errors.ts";
import { ShellExec, type ExecOptions } from "./exec.ts";
import type { Runner } from "./runner.ts";

export interface ProcessInfo {
	pid: number;
	user: string;
	cpuPercent: string;
	memPercent: string;
	command: string;
}

export interface ProcessListOptions {
	user?: string;
	name?: string;
	limit?: number;
}

const PS_FIELDS = ["pid", "user", "%cpu", "%mem", "args"] as const;
const DEFAULT_LIMIT = 50;

/** 进程列表（只读）：ps 一次性快照，按 CPU 降序。P0 仅本地；远程经 SshPool 于 P1 引入。 */
export class ProcessManager {
	private readonly shell: Runner;
	constructor(shell: Runner = new ShellExec()) {
		this.shell = shell;
	}

	async list(options: ProcessListOptions = {}, execOptions: ExecOptions = {}): Promise<ProcessInfo[]> {
		// `--sort` 是**选项**不是字段：必须作为独立 argv 元素（2026-09-16 两轮实测）——
		// 旧写法 `${PS_FIELDS.join(",")}--sort=-%cpu` 漏逗号 → `args--sort=-%cpu` 当字段描述符；
		// 而「补逗号后塞进 -eo 列表」同样非法（CI 实测 `improper AIX field descriptor`）。
		const argv = ["ps", "-eo", PS_FIELDS.join(","), "--no-headers", "--sort=-%cpu"];
		const result = await this.shell.exec(argv, { timeoutMs: 15_000, ...execOptions });
		if (result.exitCode !== 0) {
			throw new OpsError("EXEC_FAILED", `ps 退出码 ${result.exitCode}：${result.stderr.slice(0, 400)}`);
		}
		return parsePsOutput(result.stdout, options).slice(0, options.limit ?? DEFAULT_LIMIT);
	}
}

export function parsePsOutput(stdout: string, options: ProcessListOptions = {}): ProcessInfo[] {
	const rows: ProcessInfo[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		// args 是最后一个字段且可含空格：先按前 4 个空格切出 pid/user/cpu/mem
		const fields = trimmed.split(/\s+/);
		const pid = Number.parseInt(fields[0] ?? "", 10);
		if (!Number.isFinite(pid)) continue;
		const [user, cpu, mem] = [fields[1] ?? "", fields[2] ?? "", fields[3] ?? ""];
		const command = fields.slice(4).join(" ").trim();
		if (command === "") continue;
		if (options.user !== undefined && user !== options.user) continue;
		if (options.name !== undefined && !command.includes(options.name)) continue;
		rows.push({ pid, user, cpuPercent: cpu, memPercent: mem, command });
	}
	return rows;
}
