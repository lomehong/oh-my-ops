import { execFile, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { ShellExec, type ExecOptions, type ExecResult } from "./exec.ts";
import type { Runner } from "./runner.ts";
import { OpsError } from "./errors.ts";

export type { ExecOptions, ExecResult, Runner };

/**
 * SSH 连接配置（来自 OpsConfig.ssh，§4.7）。
 *
 * 认证仅支持密钥（BatchMode=yes，永不交互输密码）。
 *
 * host key 策略（TOFU，首次信任并记录）**由运行期能力探测决定**（2026-09-16 修正：此前注释承诺 accept-new
 * 但实现未带任何 host key 选项，el7 默认 `ask` + BatchMode=yes 直接失败）：
 *  - 本机 OpenSSH ≥7.6（支持 `accept-new`）→ `StrictHostKeyChecking=accept-new`；
 *  - 否则（如 CentOS/RHEL 7 的 7.4）→ `StrictHostKeyChecking=no`；
 *  两种情形都配 **受管** `UserKnownHostsFile=<controlDir>/known_hosts`，首次连接即记录指纹，
 *  保住宿主「首次信任并记录」的语义（`options` 里若自带 StrictHostKeyChecking，因 OpenSSH「首值生效」
 *  而优先于本处默认，属有意让调用方覆盖）。
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

/** 探测本机 OpenSSH 是否支持 `StrictHostKeyChecking=accept-new`（7.6+；el7 仅 7.4）。结果缓存。 */
let acceptNewSupported: boolean | undefined;
export function sshSupportsAcceptNew(): boolean {
	if (acceptNewSupported !== undefined) return acceptNewSupported;
	try {
		// ssh -G 只做配置解析、不建连；选项不被支持时以非 0 退出（el7 实测：unsupported option "accept-new"）
		execFileSync("ssh", ["-G", "-o", "StrictHostKeyChecking=accept-new", "localhost"], { stdio: "ignore", timeout: 5_000 });
		acceptNewSupported = true;
	} catch {
		acceptNewSupported = false;
	}
	return acceptNewSupported;
}

/** 测试/运维用：覆写探测结果（undefined = 恢复自动探测） */
export function setSshAcceptNewSupport(value: boolean | undefined): void {
	acceptNewSupported = value;
}

/** 降级告警只发一次（进程级）：StrictHostKeyChecking=no 首连不校验指纹，必须让 Owner 知道 */
let weakHostKeyWarned = false;
function warnWeakHostKeyOnce(): void {
	if (weakHostKeyWarned) return;
	weakHostKeyWarned = true;
	console.error(
		"[omo][ssh] 警告：本机 OpenSSH 不支持 StrictHostKeyChecking=accept-new（需 ≥7.6），已回退为 no + 受管 known_hosts ——" +
			"首次连接不校验主机指纹（存在 MITM 风险，known_hosts 仅记录不校验）。建议升级 OpenSSH 或由 Owner 预置指纹后设 StrictHostKeyChecking=yes。",
	);
}

/**
 * POSIX 单引号引述：把单个 argv 元素转为「远端登录 shell 解析后仍还原为同一参数」的形态。
 *
 * 为什么必须：ssh 把 `--` 之后的 argv 用空格拼接成**单一字符串**交给远端登录 shell 重新解析——
 * 含空格/引号/`;`/`$()`/反引号的元素若不引述，会被远端二次解释（等价命令注入）。
 * 安全字符集（不含 shell 元字符）外的参数一律包裹单引号，`'` 编码为 `'\''`。
 */
export function posixShellQuote(arg: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'\\''`)}'`;
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
 *  - 零 npm 依赖：spawn 系统 ssh（本地侧 argv 数组；远端侧经 posixShellQuote 逐元素引述，
 *    保证远端 shell 解析后逐字还原为原 argv——ssh 的 `--` 后参数会被远端登录 shell 重新解析，见 wrap()）。
 *  - 连接复用：ControlMaster=auto + ControlPersist，同目标后续执行走多路复用_socket。
 *  - 并发上限：maxSessions 信号量，超出排队（防打爆目标机）。
 *  - 认证：仅密钥（BatchMode），交互式密码永不出现（无人值守安全）。
 *  - host key：探测 OpenSSH 能力后选 accept-new（≥7.6）或 no（el7 等），两者均配受管 known_hosts
 *    （见 SshConfig 注释；2026-09-16 修正：此前无任何 host key 选项，el7 首连必失败）。
 */
export class SshPool {
	private readonly cfg: Required<Pick<SshConfig, "connectTimeoutSec" | "controlPersistSec" | "maxSessions">> & SshConfig;
	private readonly runner: Runner;
	private readonly controlDir: string;
	private readonly destinations = new Set<string>();
	private readonly hostKeySupport: boolean | undefined;
	private inFlight = 0;
	private readonly queue: Array<() => void> = [];

	private hostKeyOptions?: string[];
	private hostKeyMode?: "accept-new" | "no+managed-known-hosts";

	constructor(config: SshConfig = {}, runner: Runner = new ShellExec(), controlDir?: string, hostKeySupport?: boolean) {
		this.cfg = {
			...config,
			connectTimeoutSec: config.connectTimeoutSec ?? DEFAULTS.connectTimeoutSec,
			controlPersistSec: config.controlPersistSec ?? DEFAULTS.controlPersistSec,
			maxSessions: Math.max(1, config.maxSessions ?? DEFAULTS.maxSessions),
		};
		this.runner = runner;
		this.controlDir = controlDir ?? path.join(process.env.HOME ?? "/tmp", ".ops-pi", "ssh");
		mkdirSync(this.controlDir, { recursive: true });
		this.hostKeySupport = hostKeySupport;
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
		opts.push(...this.hostKeyOptionList());
		return opts;
	}

	/** host key 选项（探测 + 退化）：受管 known_hosts 保证「首次信任并记录」 */
	private hostKeyOptionList(): string[] {
		if (this.hostKeyOptions !== undefined) return this.hostKeyOptions;
		const knownHosts = path.join(this.controlDir, "known_hosts");
		const supported = this.hostKeySupport ?? sshSupportsAcceptNew();
		this.hostKeyMode = supported ? "accept-new" : "no+managed-known-hosts";
		if (!supported) warnWeakHostKeyOnce();
		this.hostKeyOptions = supported
			? [`StrictHostKeyChecking=accept-new`, `UserKnownHostsFile=${knownHosts}`]
			: [`StrictHostKeyChecking=no`, `UserKnownHostsFile=${knownHosts}`];
		return this.hostKeyOptions;
	}

	/** 当前 host key 策略（可观测：审计/日志用） */
	hostKeyPolicy(): { mode: "accept-new" | "no+managed-known-hosts"; options: string[] } {
		const options = this.hostKeyOptionList();
		return { mode: this.hostKeyMode!, options };
	}

	/**
	 * 把本地 argv 包装为经 ssh 在目标主机执行的 argv。
	 *
	 * 数组形式（推荐）：逐元素 POSIX 引述后合并为**单一**远端命令字符串——远端 shell 解析后
	 * 逐字还原为原 argv，含空格/引号/`;`/`$()` 的参数不再被二次解释。
	 * 字符串形式：视为**远端 shell 命令行**原样传递（管道/`&&` 等 shell 语法按调用方书写生效）；
	 * ssh 通道远端恒经登录 shell，字符串形式没有「无 shell」语义，安全边界在 exec 档位授权。
	 */
	wrap(host: string, argv: string | readonly string[]): string[] {
		normalizeTargetHost(host); // core 层自防：不依赖扩展层纪律（防 "-oProxyCommand=…" 形态选项注入）
		const dest = this.destination(host);
		const remote = typeof argv === "string" ? argv : argv.map(posixShellQuote).join(" ");
		return ["ssh", ...this.baseOptions().flatMap((o) => ["-o", o]), dest, "--", remote];
	}

	/** 在目标主机执行 argv（并发受 maxSessions 限制） */
	async exec(host: string, argv: string | readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		if (this.inFlight >= this.cfg.maxSessions) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
			// 槽位由释放者直接移交（唤醒前已递增），此处不再自增：
			// 否则「唤醒 → 等待者恢复执行」的微任务窗口内新调用者看到已递减的计数，可越过 maxSessions
		} else {
			this.inFlight += 1;
		}
		this.destinations.add(this.destination(host));
		try {
			return await this.runner.exec(this.wrap(host, argv), options);
		} finally {
			this.inFlight -= 1;
			if (this.queue.length > 0 && this.inFlight < this.cfg.maxSessions) {
				this.inFlight += 1; // 移交槽位给下一个等待者（同步完成，无竞态窗口）
				this.queue.shift()!();
			}
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
