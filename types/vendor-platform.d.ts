/**
 * OpsPi 依赖的 omp 扩展契约 —— 最小自持声明。
 *
 * 为什么仓库内声明而非依赖 `@oh-my-pi/pi-coding-agent` 类型：
 *   该包不在本仓依赖内（omp 宿主在加载期重映射并注入真实实现，见方案 §7.2/矩阵 O13）。
 *   本文件即「我们依赖的平台面」的单一事实文档——升级 omp 时按
 *   `docs/reports/pi-vs-omp-host-capability-matrix.md` 逐条复核并同步本文件。
 *
 * 语义均经 omp 18.1.18 实测（证据编号见方案 §3，O#/X#）。
 */
declare module "@oh-my-pi/pi-coding-agent" {
	/** 注入式 Zod 门面（omptype 支撑，O14；官方示例同款用法） */
	export interface ZodLikeSchema<Out = unknown> {
		optional(): ZodLikeSchema<Out | undefined>;
		default(value: Out): ZodLikeSchema<Exclude<Out, undefined>>;
		describe(description: string): ZodLikeSchema<Out>;
	}
	export interface ZodFacade {
		string(): ZodLikeSchema<string>;
		number(): ZodLikeSchema<number>;
		boolean(): ZodLikeSchema<boolean>;
		enum<const Values extends readonly [string, ...string[]]>(values: Values): ZodLikeSchema<Values[number]>;
		default(value: unknown): ZodLikeSchema<unknown>;
		array<T>(inner: ZodLikeSchema<T>): ZodLikeSchema<T[]>;
		object<const Shape extends Record<string, unknown>>(shape: Shape): ZodLikeSchema<{ [K in keyof Shape]: Shape[K] }>;
	}

	/** 工具注册定义（omp ToolDefinition 的 ops-pi 依赖子集，O2/O16） */
	export interface ToolDefinition {
		name: string;
		label?: string;
		description: string;
		parameters?: unknown;
		/** 审批档位；省略默认最严 "exec"（O2/O3） */
		approval?: ToolApproval;
		/** ★ 必须显式 "essential"：默认 discoverable 会使 approval 声明失效（O8/X4–X6） */
		loadMode?: "essential" | "discoverable";
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: ((payload: unknown) => void) | undefined,
			ctx: ExtensionContext,
		) => Promise<AgentToolResult>;
		[key: string]: unknown;
	}

	/** 审批决策：档位或结构化决策（policy 在解析顺序中最优先，O3） */
	export type ToolApproval =
		| "read"
		| "write"
		| "exec"
		| {
				tier: "read" | "write" | "exec";
				reason?: string;
				override?: boolean;
				policy?: "allow" | "deny" | "prompt";
				policyKey?: string;
		  };

	export interface AgentToolResult {
		content: Array<{ type: "text"; text: string } | { type: "image"; data?: unknown }>;
		details?: unknown;
	}

	/** 事件处理上下文（O5/O16/O17） */
	export interface ExtensionContext {
		hasUI: boolean;
		ui: {
			notify(message: string, type?: "info" | "warning" | "error"): void;
			select(title: string, options: readonly string[]): Promise<string | undefined>;
			confirm(title: string, message: string): Promise<boolean>;
			input(title: string, placeholder?: string): Promise<string | undefined>;
		};
		setInterval(callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]): unknown;
		sessionManager: { getBranch(fromId?: string): unknown[] };
	}

	/** 平台工具清单条目（O11：last-wins 静默覆盖的检测依据是 sourceInfo.path） */
	export interface ToolInfo {
		name: string;
		description: string;
		parameters?: unknown;
		sourceInfo?: { path?: string; source?: string };
	}

	export interface ToolCallEvent {
		type: "tool_call";
		toolName: string;
		toolCallId: string;
		/** 共享可变对象：多 handler 按注册顺序传播（X16/X17，方案 §7.4.4） */
		input: Record<string, unknown>;
	}
	export interface ToolCallEventResult {
		block?: boolean;
		reason?: string;
		/** omp 18.1.18 无 terminate 字段（v4.0 评审 R-1 勘误） */
		input?: Record<string, unknown>;
	}
	export interface ToolExecutionEndEvent {
		type: "tool_execution_end";
		toolName: string;
		toolCallId: string;
		/** 被阻断调用为 `{ content:[{text:<reason>}], isError:true }`（X23：拒绝原因提取依据） */
		result: unknown;
		isError: boolean;
	}
	export interface SessionStartEvent {
		type: "session_start";
		reason?: string;
	}
	export interface BeforeAgentStartEvent {
		type: "before_agent_start";
		/** ★ omp 为 string[]（X12）；返回值接受 string（O10，runner 归一化） */
		systemPrompt: string[];
	}
	export interface BeforeAgentStartEventResult {
		systemPrompt?: string;
	}

	export interface ExtensionAPI {
		/** 事件名以字面量联合约束；handler 返回值语义随事件不同（见各 Event/Result 类型） */
		on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void): void;
		on(
			event: "session_shutdown",
			handler: (event: { type: "session_shutdown" }, ctx: ExtensionContext) => Promise<void> | void,
		): void;
		on(
			event: "before_agent_start",
			handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void,
		): void;
		on(
			event: "tool_call",
			handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void,
		): void;
		on(
			event: "tool_execution_end",
			handler: (event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void> | void,
		): void;
		on(
			event: "input",
			handler: (event: { type: "input"; text: string; source?: string }, ctx: ExtensionContext) => Promise<unknown> | unknown,
		): void;
		registerTool(definition: ToolDefinition): void;
		registerCommand(
			name: string,
			options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void },
		): void;
		appendEntry<T = unknown>(customType: string, data?: T): void;
		getAllTools(): ToolInfo[];
		setActiveTools(toolNames: readonly string[]): Promise<void>;
		getActiveTools(): string[];
		sendUserMessage(
			content: string | Array<{ type: "text"; text: string }>,
			options?: { deliverAs?: "steer" | "followUp" },
		): void;
		/** 注入面：zod/arktype/typebox 三选一（本方案用 zod，O14） */
		readonly zod: ZodFacade;
		readonly arktype: unknown;
		readonly typebox: unknown;
		readonly logger: unknown;
	}

	const pi: ExtensionAPI;
	export default pi;
}

/** bun 运行时测试面（仅 ops-extension 的 bun test 使用；L1 用 node --test，不依赖本节） */
declare module "bun:test" {
	export interface Matchers<T> {
		not: Matchers<T>;
		toBe(expected: T): void;
		toEqual(expected: unknown): void;
		toMatchObject(expected: Partial<T>): void;
		toBeUndefined(): void;
		toBeNull(): void;
		toBeGreaterThan(expected: number): void;
		toContain(expected: unknown): void;
		toThrow(expected?: string | RegExp | (new (...args: never[]) => Error)): void;
	}
	export function describe(name: string, factory: () => void): void;
	export function test(name: string, factory: () => void | Promise<void>): void;
	export const expect: {
		(value: unknown): Matchers<unknown> & {
			rejects: { toThrow(expected?: string | RegExp | (new (...args: never[]) => Error)): Promise<void> };
		};
		stringContaining(expected: string): unknown;
	};
}
