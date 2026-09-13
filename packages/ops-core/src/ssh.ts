import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { ShellExec, type ExecOptions, type ExecResult } from "./exec.ts";
import type { Runner } from "./runner.ts";
import { OpsError } from "./errors.ts";

export type { ExecOptions, ExecResult, Runner };

/**
 * SSH 连接配置（来自 OpsConfig.ssh，§4.7）。
 * 认证仅支持密钥（BatchMode=yes，永不交互输密码）；host key 采用 accept-new（TOFU，首次信任并记录）。
 */
export interface SshConfig {
	/** 登录用户（缺省走 ssh 配置/当前用户） */
	user?: string;
	/** 端口（缺省 22） */
	port?: number;
	/** 私钥路径 */
	identityFile?: string;
	/** 连接超时秒（缺省 10） */
	connectTimeoutSec?: number;
	/** ControlMaster 复用保持秒数（缺省 600；0 = 关闭复用） */
	controlPersistSec?: number;
	/** 并发执行上限（缺省 4；超出排队等待） */
	maxSessions?: number;
	/** 额外 ssh -o 选项（原样透传，如 ["StrictHostKeyChecking=yes"]） */
	options?: string[];
}

const DEFAULTS = {
	connectTimeoutSec: 10,
	controlPersistSec: 600,
	maxSessions: 4,
};

/**
 * 目标主机规范化：trim → 空值归 undefined → 安全校验。
 * 拒绝：前导 "-"（防 ssh 选项注入）、空白、非法字符（仅允许 [A-Za-z0-9._-] 与 user@ 形式）。
 * 返回 undefined 表示本机（@local）。
 */
export function normalizeTargetHost(raw: unknown): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "" || value === "@local") return undefined;
	if (value.startsWith("-")) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法主机名（不能以 '-' 开头，防选项注入）：'${value}'`);
	}
	if (/\s/.test(value)) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法主机名（含空白）：'${value}'`);
	}
	if (!/^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/.test(value)) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法主机名字符：'${value}'（仅允许 [A-Za-z0-9._-] 与 user@host 形式）`);
	}
	return value;
}

/**
 * SshPool —— 基于 OpenSSH ControlMaster 的远程执行通道（P7，§3.2）。
 *
 * 设计：
 *  - 零 npm 依赖：spawn 系统 ssh（argv 数组，无 shell 注入面）。
 *  - 连接复用：ControlMaster=auto + ControlPersist，同目标后续执行走多路复用_socket。
 *  - 并发上限：maxSessions 信号量，超出排队（防打爆目标机）。
 *  - 认证：仅密钥（BatchMode），交互式密码永不出现（无人值守安全）。
 */
export class SshPool {
	private readonly cfg: Required<Pick<SshConfig, "connectTimeoutSec" | "controlPersistSec" | "maxSessions">> & SshConfig;
	private readonly runner: Runner;
	private readonly controlDir: string;
	private readonly destinations = new Set<string>();
	private inFlight = 0;
	private readonly queue: Array<() => void> = [];

	constructor(config: SshConfig = {}, runner: Runner = new ShellExec(), controlDir?: string) {
		this.cfg = {
			...config,
			connectTimeoutSec: config.connectTimeoutSec ?? DEFAULTS.connectTimeoutSec,
			controlPersistSec: config.controlPersistSec ?? DEFAULTS.controlPersistSec,
			maxSessions: Math.max(1, config.maxSessions ?? DEFAULTS.maxSessions),
		};
		this.runner = runner;
		this.controlDir = controlDir ?? path.join(process.env.HOME ?? "/tmp", ".ops-pi", "ssh");
		mkdirSync(this.controlDir, { recursive: true });
	}

	/** ssh 目标地址（支持 user@host） */
	destination(host: string): string {
		return this.cfg.user ? `${this.cfg.user}@${host}` : host;
	}

	/** 基础 -o 选项（复用 + 超时 + 认证策略） */
	private baseOptions(): string[] {
		const opts = [
			"BatchMode=yes",
			`ConnectTimeout=${this.cfg.connectTimeoutSec}`,
			`ControlMaster=auto`,
			`ControlPath=${path.join(this.controlDir, "%r@%h:%p")}`,
			`ControlPersist=${this.cfg.controlPersistSec}`,
		];
		if (this.cfg.identityFile) opts.push(`IdentityFile=${this.cfg.identityFile}`);
		if (this.cfg.port) opts.push(`Port=${this.cfg.port}`);
		for (const extra of this.cfg.options ?? []) opts.push(extra);
		return opts;
	}

	/** 把本地 argv 包装为经 ssh 在目标主机执行的 argv（无 shell 注入面：全程 argv 数组） */
	wrap(host: string, argv: string | readonly string[]): string[] {
		const dest = this.destination(host);
		const args = typeof argv === "string" ? argv.trim().split(/\s+/) : [...argv];
		return ["ssh", ...this.baseOptions().flatMap((o) => ["-o", o]), dest, "--", ...args];
	}

	/** 在目标主机执行 argv（并发受 maxSessions 限制） */
	async exec(host: string, argv: string | readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		if (this.inFlight >= this.cfg.maxSessions) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.inFlight += 1;
		this.destinations.add(this.destination(host));
		try {
			return await this.runner.exec(this.wrap(host, argv), options);
		} finally {
			this.inFlight -= 1;
			const next = this.queue.shift();
			if (next) next();
		}
	}

	/** 主动关闭所有 ControlMaster 连接（best-effort） */
	async closeAll(): Promise<void> {
		for (const dest of this.destinations) {
			try {
				await this.runner.exec(["ssh", ...this.baseOptions().flatMap((o) => ["-o", o]), "-O", "exit", dest], {
					timeoutMs: 5_000,
				});
			} catch {
				// 连接可能已死，忽略
			}
		}
		this.destinations.clear();
	}

	stats(): { destinations: number; inFlight: number; maxSessions: number } {
		return { destinations: this.destinations.size, inFlight: this.inFlight, maxSessions: this.cfg.maxSessions };
	}
}
