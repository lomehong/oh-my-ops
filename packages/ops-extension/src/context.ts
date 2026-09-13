import { CredentialVault, FileOps, LogCollector, ProcessManager, ShellExec, ReloadableTargetPolicy, SshPool, loadTokenStore, normalizeTargetHost } from "@ops-pi/core";
import type { ExecOptions, ExecResult, PolicyRequest, Runner } from "@ops-pi/core";
import { SandboxedShell } from "./sandbox.ts";
import type { AuthorizationView } from "./guards.ts";
import { standardAuthzView } from "./guards.ts";
import type { OpsConfig } from "./setup.ts";

/**
 * 单主机的 L1 能力束：host=undefined 时即本机全局实例；远程主机为 SshRemoteRunner 绑定的新实例。
 */
export interface HostOps {
	/** undefined = 本机（@local）；否则为规范化后的目标主机名 */
	readonly host: string | undefined;
	readonly files: FileOps;
	readonly process: ProcessManager;
	readonly log: LogCollector;
	readonly shell: Runner;
}

/** 远程执行器：把 Runner.exec 委派给 SshPool 的对应目标主机 */
class SshRemoteRunner implements Runner {
	constructor(private readonly pool: SshPool, private readonly host: string) {}
	exec(cmd: string | readonly string[], options?: ExecOptions): Promise<ExecResult> {
		return this.pool.exec(this.host, cmd, options);
	}
}

/**
 * L2 运行上下文：装配 L1 能力 + Owner 预授权（方案 §7.4）。
 * 授权语义：目标导向 defaultDeny（§7.6）——允许对哪些主机/服务执行什么，与调用方身份解耦。
 * policy/token 均为 mtime 可重载存储：Owner 编辑文件后下次判定即生效（§7.4.3）。
 *
 * P7：forHost(host) 返回目标主机的能力束——本机复用全局实例；远程主机经 SshPool
 * （ControlMaster 复用，按主机缓存实例），policy.json 需有对应 host 的授权规则。
 */
export class OpsContext {
	readonly targetPolicy: ReloadableTargetPolicy;
	readonly tokens: ReturnType<typeof loadTokenStore>;
	readonly #config: OpsConfig;
	readonly files: FileOps;
	readonly process: ProcessManager;
	readonly log: LogCollector;
	readonly shell: ShellExec;
	readonly #pool: SshPool;
	readonly vault: CredentialVault | undefined;
	readonly #remote = new Map<string, HostOps>();

	constructor(
		config: OpsConfig,
		paths: { policyPath: string; tokenPath: string },
		l1: { files: FileOps; process: ProcessManager; log: LogCollector; shell: ShellExec } = {
			files: new FileOps(),
			process: new ProcessManager(),
			log: new LogCollector(),
			shell: new SandboxedShell(new ShellExec(), { enabled: process.env.OPS_PI_SANDBOX === "1", writableDir: process.cwd() }),
		},
	) {
		this.files = l1.files;
		this.process = l1.process;
		this.log = l1.log;
		this.shell = l1.shell;
		this.#config = config;
		this.targetPolicy = new ReloadableTargetPolicy(paths.policyPath);
		this.tokens = loadTokenStore(paths.tokenPath);
		this.#pool = new SshPool(config.ssh);
		this.vault = config.vault?.dbPath ? new CredentialVault(config.vault.dbPath) : undefined;
	}

	/** 配置（供工具读取 vault 路径等运行时信息） */
	get config(): OpsConfig { return this.#config; }

	/** ssh 池（供 status 面板/关闭连接使用） */
	get sshPool(): SshPool { return this.#pool; }

	/**
	 * 按目标主机取能力束（P7）。
	 * host 省略/空/@local → 本机全局实例；否则返回该主机的远程绑定实例（按主机缓存）。
	 * 非法主机名在此即抛 POLICY_DENIED。
	 */
	forHost(rawHost?: unknown): HostOps {
		const host = normalizeTargetHost(typeof rawHost === "string" ? rawHost : undefined);
		if (!host) {
			return { host: undefined, files: this.files, process: this.process, log: this.log, shell: this.shell };
		}
		const cached = this.#remote.get(host);
		if (cached) return cached;
		const runner = new SshRemoteRunner(this.#pool, host);
		const bundle: HostOps = {
			host,
			files: new FileOps(runner),
			process: new ProcessManager(runner),
			log: new LogCollector(runner),
			shell: runner,
		};
		this.#remote.set(host, bundle);
		return bundle;
	}

	/**
	 * 授权判定视图（最小接口，guards 层依赖此形状）。
	 * evaluate / consume 走 core evaluateAuthorization 单一事实源：
	 * 与审批层（①-a）、兜底层（①-b）共享同一判定顺序：token → policy → production → none。
	 */
	get authzView(): AuthorizationView {
		return standardAuthzView(this.targetPolicy, this.tokens);
	}
}
