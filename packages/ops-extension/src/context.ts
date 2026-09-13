import { FileOps, LogCollector, ProcessManager, ShellExec, ReloadableTargetPolicy, loadTokenStore } from "@ops-pi/core";
import type { PolicyRequest } from "@ops-pi/core";
import type { AuthorizationView } from "./guards.ts";
import { standardAuthzView } from "./guards.ts";
import type { OpsConfig } from "./setup.ts";

/**
 * L2 运行上下文：装配 L1 能力 + Owner 预授权（方案 §7.4）。
 * 授权语义：目标导向 defaultDeny（§7.6）——允许对哪些主机/服务执行什么，与调用方身份解耦。
 * policy/token 均为 mtime 可重载存储：Owner 编辑文件后下次判定即生效（§7.4.3）。
 */
export class OpsContext {
	readonly targetPolicy: ReloadableTargetPolicy;
	readonly tokens: ReturnType<typeof loadTokenStore>;
	readonly #config: OpsConfig;
	readonly files: FileOps;
	readonly process: ProcessManager;
	readonly log: LogCollector;
	readonly shell: ShellExec;

	constructor(
		config: OpsConfig,
		paths: { policyPath: string; tokenPath: string },
		l1: { files: FileOps; process: ProcessManager; log: LogCollector; shell: ShellExec } = {
			files: new FileOps(),
			process: new ProcessManager(),
			log: new LogCollector(),
			shell: new ShellExec(),
		},
	) {
		this.files = l1.files;
		this.process = l1.process;
		this.log = l1.log;
		this.shell = l1.shell;
		this.#config = config;
		this.targetPolicy = new ReloadableTargetPolicy(paths.policyPath);
		this.tokens = loadTokenStore(paths.tokenPath);
	}

	/** 配置（供工具读取 vault 路径等运行时信息） */
	get config(): OpsConfig { return this.#config; }

	/**
	 * 授权判定视图（最小接口，guards 层依赖此形状）。
	 * evaluate / consume 走 core evaluateAuthorization 单一事实源：
	 * 与审批层（①-a）、兜底层（①-b）共享同一判定顺序：token → policy → production → none。
	 */
	get authzView(): AuthorizationView {
		return standardAuthzView(this.targetPolicy, this.tokens);
	}
}
