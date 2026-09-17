import { AuditLog, CredentialVault, FileOps, LogCollector, PathGuard, ProcessManager, ShellExec, ReloadableTargetPolicy, SshPool, loadTokenStore, normalizeTargetHost } from "@ops-pi/core";
import { KnowledgeStore } from "./knowledge.ts";
import * as os from "node:os";
import * as path from "node:path";
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
/** 真实用户 home（不随 $HOME 漂移）：POSIX 取 getpwuid；极端环境（无 passwd 条目）退回 $HOME */
export function realUserHome(): string {
	try {
		const h = os.userInfo().homedir;
		if (typeof h === "string" && h !== "") return h;
	} catch {
		/* os.userInfo 在无 passwd 条目的环境下会抛 → 退回 */
	}
	return process.env.HOME ?? os.homedir();
}

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
	readonly kb: KnowledgeStore;
	/** 私有域根（= dirname(policyPath)，omo 部署下即 ~/.omo）——KB 凭据/状态目录的基准 */
	readonly omoDir: string;
	readonly kbRepo: string | undefined;
	readonly kbBranch: string;
	/** 独立审计存储（与会话解耦；--no-session 下仍落盘） */
	readonly audit: AuditLog;
	/** 本机路径守卫：机密根不可读写、信任根不可写（仅 @local） */
	readonly pathGuard: PathGuard;
	readonly #remote = new Map<string, HostOps>();

	constructor(
		config: OpsConfig,
		paths: { policyPath: string; tokenPath: string; auditPath?: string; configPath?: string },
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
		this.omoDir = path.dirname(paths.policyPath);
		this.targetPolicy = new ReloadableTargetPolicy(paths.policyPath);
		this.tokens = loadTokenStore(paths.tokenPath);
		this.#pool = new SshPool(config.ssh);
		this.vault = config.vault?.dbPath ? new CredentialVault(config.vault.dbPath) : undefined;
		this.kb = new KnowledgeStore(config.knowledge?.dir ?? path.join(paths.policyPath, "..", "knowledge"));
		this.kbRepo = config.knowledge?.repo;
		this.kbBranch = config.knowledge?.branch ?? "main";

		const privateDir = path.dirname(paths.policyPath);
		const auditPath = paths.auditPath ?? path.join(privateDir, "audit", "ops-audit.jsonl");
		this.audit = new AuditLog(auditPath);
		const home = process.env.HOME ?? os.homedir();
		// 真实用户 home：omo 启动器把 HOME 重定向到私有域，而 Node 的 os.homedir() 在 POSIX 下**优先 $HOME**
		// → `join(home, ".ssh")` 与 `join(os.homedir(), ".ssh")` 会塌缩成同一路径（~/.omo/home/.ssh），
		// 真实用户家目录的 `.ssh` 反而落在 secret/trust 之外（对端 2026-09-16 实测：ops_file_ls 可列它）。
		// 改用 getpwuid 口径（os.userInfo().homedir）取真实 home，不随 $HOME 漂移。
		const realHome = realUserHome();
		// KB 同步凭据（OMO-KB-SYNC）：bot token 与 git 凭据文件均属机密根——Agent 读不到，防被 LLM 外泄
		const kbSecretFiles = [path.join(privateDir, "kb", "credential.json"), path.join(privateDir, "kb", "git-credentials")];
		this.pathGuard = new PathGuard({
			// 机密根：读写皆拒——模型凭据/会话（$HOME/.omp）、SSH 私钥（真实 home 与私有 home 两处）、
			// vault 密文、批准令牌、omo 私有 HOME
			secret: [
				paths.tokenPath,
				config.vault?.dbPath ?? "",
				path.join(home, ".omp"),
				path.join(home, ".ssh"),
				path.join(realHome, ".ssh"),
				path.join(privateDir, "home"),
				...kbSecretFiles,
			],
			// 信任根：写拒——策略/令牌/配置/审计/运行时与扩展安装域（omo 部署下 privateDir = ~/.omo）
			trust: [
				privateDir,
				paths.policyPath,
				auditPath,
				paths.configPath === undefined ? "" : path.dirname(paths.configPath),
			],
		});
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
