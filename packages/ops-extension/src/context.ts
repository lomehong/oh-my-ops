import { FileOps, LogCollector, ProcessManager, ShellExec, loadTargetPolicy, loadTokenStore, StaticTokenStore } from "@ops-pi/core";
import type { PolicyRequest, TargetPolicy, TokenStore } from "@ops-pi/core";
import type { OpsConfig } from "./setup.ts";

/**
 * L2 运行上下文：装配 L1 能力 + Owner 预授权（方案 §7.4）。
 * 授权语义：目标导向 defaultDeny（§7.6）——允许对哪些主机/服务执行什么，与调用方身份解耦。
 */
export class OpsContext {
	readonly targetPolicy: TargetPolicy;
	readonly tokens: TokenStore;
	readonly #config: OpsConfig;
	readonly files: FileOps;
	readonly process: ProcessManager;
	readonly log: LogCollector;
	readonly shell: ShellExec;
	#lastAuthzSource = "unknown";

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
		this.targetPolicy = config.policyPath !== undefined
			? loadTargetPolicy(config.policyPath)
			: new NoPolicy();
		this.tokens = config.tokenPath !== undefined ? loadTokenStore(config.tokenPath) : new StaticTokenStore([]);
	}

	/** ①-b 兜底与 execute 复核共用的预授权判定（只读，可被求值多次） */
	preauthorized(request: PolicyRequest): boolean {
		return this.targetPolicy.allows(request) || this.tokens.find(request).valid;
	}

	/** 配置（供工具读取 vault 路径等运行时信息） */
	get config(): OpsConfig { return this.#config; }
	/** 授权判定视图（最小接口，guards 层依赖此形状） */
	get authzView(): {
		targetPolicy: Pick<TargetPolicy, "isProduction" | "allows" | "check">;
		preauthorized(request: PolicyRequest): boolean;
	} {
		return { targetPolicy: this.targetPolicy, preauthorized: (request) => this.preauthorized(request) };
	}

	/** 记录本次调用的授权来源（execute 设置，审计钩子读取） */
	markAuthzSource(source: string): void {
		this.#lastAuthzSource = source;
	}
	lastAuthzSource(): string {
		return this.#lastAuthzSource;
	}
}

class NoPolicy {
	readonly isConfigured = false;
	isProduction(): boolean { return false; }
	allows(): boolean { return false; } // 未配置策略 = 全拒（保守侧，§7.4.3）
	check(request: PolicyRequest): void {
		throw new Error(`[ERR_POLICY] 未配置目标策略（policy.json）：变更类操作一律拒绝。请求：${JSON.stringify(request)}`);
	}
}
