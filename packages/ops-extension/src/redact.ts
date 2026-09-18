/**
 * redact 的 omo 侧装配（宿主事件 → 引擎）
 *
 * 语义与 `omp-redact-extension.js` 一致（移植自 dsh-redact）：
 *   出站 `before_provider_request`：payload 深遍历掩码后**返回替换 payload**；
 *   入站 `tool_call`：参数里占位符还原（工具以真实值执行），无占位符时 no-op（返回 undefined 零干预）。
 *
 * omo 与裸 omp 的差异（移植点）：
 *   - 目录改用 **omo 私有 HOME**（`$OMO_DIR/home/.omp/redact`）——该目录整体已在 PathGuard 机密根内，
 *     Agent 经 `ops_file_*` 读不到映射账本（账本含真实敏感值）；
 *   - 可用 `OMO_REDACT_HOME` 覆盖基址（测试/多实例）；调试开关 `OMO_REDACT_DEBUG=1`；
 *   - 全程 be­st-effort：任何异常都不得阻断宿主加载或工具执行（含台账）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BeforeProviderRequestEvent, ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import {
	configFromRaw,
	extractAliasEntries,
	finalizeConfig,
	loadStateSync,
	maskDeep,
	MappingStore,
	restoreDeep,
	saveStateSync,
	type PersistedState,
	type RedactConfig,
} from "@ops-pi/core";
import type { OpsContext } from "./context.ts";
import { omoHomeDir } from "./kb-credential.ts";

/**
 * 当前会话的**入站还原器**（由 setupRedact 装配；未启用时 undefined ⇒ no-op）。
 *
 * 为什么工具层也要还原：宿主 `tool_call` 的结果契约里 `input` 是「**原始执行入参**」，
 * 而事件里的 `event.input` 是**归一化视图** ⇒ 在事件层返回还原结果对部分工具不生效
 * （真机实测：`13889332920` 原样到达 bash）。因此在 omo 自己的工具入口（registerOpsTool）
 * 再做一次还原，保证「工具以真实值执行」这一功能性方向确实成立。
 */
let activeRestorer: ((value: unknown) => unknown) | undefined;

/** 工具层调用：还原参数中的占位符（未启用脱敏时原样返回） */
export function restoreToolInput<T>(value: T): T {
	if (activeRestorer === undefined) return value;
	try {
		return activeRestorer(value) as T;
	} catch {
		return value;
	}
}

/** 脱敏私有目录（omo 私有 HOME 下；已在 PathGuard 机密根内） */
export function redactDir(omoDir: string, env: NodeJS.ProcessEnv = process.env): string {
	const base = env.OMO_REDACT_HOME ?? omoHomeDir(omoDir);
	return path.join(base, ".omp", "redact");
}

export function redactPaths(omoDir: string, env: NodeJS.ProcessEnv = process.env): { dir: string; config: string; state: string; debug: string } {
	const dir = redactDir(omoDir, env);
	return { dir, config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), debug: path.join(dir, "debug.log") };
}

/** 读配置：文件缺失/损坏 ⇒ 缺省配置（全内置启用 + 还原开） */
export function loadRedactConfig(configPath: string): RedactConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch {
		return finalizeConfig(
			{ enabled: true, restore: true, categories: { secret: true, id: true, bank: true, phone: true, email: true }, customRules: [], aliases: [] },
			[],
		);
	}
	return configFromRaw(raw);
}

/**
 * 装配脱敏钩子。返回值仅供测试/诊断（命中计数不改语义）。
 * @returns {{ config: RedactConfig; dir: string }}
 */
export function setupRedact(pi: ExtensionAPI, ctx: OpsContext, env: NodeJS.ProcessEnv = process.env): { config: RedactConfig; dir: string } {
	const { dir, config: configPath, state: statePath, debug: debugPath } = redactPaths(ctx.omoDir, env);
	const cfg = loadRedactConfig(configPath);
	for (const warning of cfg.warnings) process.stderr.write(`[omo-redact] ${warning}\n`);

	const debug = env.OMO_REDACT_DEBUG === "1";
	const debugLog = (line: string): void => {
		if (!debug) return;
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.appendFileSync(debugPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
		} catch {
			/* 调试日志失败不影响主流程 */
		}
	};
	if (debug) process.stderr.write(`[omo-redact] 已加载（enabled=${cfg.enabled} restore=${cfg.restore} rules=${cfg.rules.length} dir=${dir}）\n`);

	const store = new MappingStore();
	const persisted = loadStateSync(statePath);
	if (persisted !== undefined) store.loadPersistable((persisted as PersistedState).maps, Date.now());

	let sessionId = "default";
	let dirty = false;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	const scheduleSave = (): void => {
		dirty = true;
		if (saveTimer !== null) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			if (!dirty) return;
			dirty = false;
			const saved = saveStateSync(statePath, { version: 1, maps: store.toPersistable() });
			if (!saved.ok) process.stderr.write(`[omo-redact] 状态落盘失败：${saved.error ?? "未知"}\n`);
		}, 500);
		if (typeof saveTimer.unref === "function") saveTimer.unref();
	};

	try {
		pi.on("session_start", (_event, sessionCtx) => {
			try {
				const candidate =
					(sessionCtx as unknown as { sessionManager?: { sessionId?: unknown; id?: unknown } })?.sessionManager?.sessionId ??
					(sessionCtx as unknown as { sessionId?: unknown })?.sessionId ??
					(() => {
						const id = (sessionCtx as unknown as { sessionManager?: { id?: unknown } })?.sessionManager?.id;
						return typeof id === "string" ? id : undefined;
					})();
				if (typeof candidate === "string" && candidate !== "") sessionId = candidate;
			} catch {
				sessionId = "default";
			}
			store.sessionMap(sessionId, Date.now());
			scheduleSave();
		});
	} catch {
		/* 宿主无该事件：跳过 */
	}

	try {
		// 出站：payload 深遍历掩码，返回替换 payload（no-op 时返回 undefined 零干预）
		pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
			if (!cfg.enabled) return undefined;
			try {
				const payload = event.payload;
				if (payload === undefined) return undefined;
				const map = store.sessionMap(sessionId, Date.now());
				const { value, changed, hits } = maskDeep(payload, cfg.rules, map);
				if (!changed) return undefined;
				const byCategory: Record<string, number> = {};
				for (const hit of hits) byCategory[hit.code] = (byCategory[hit.code] ?? 0) + 1;
				debugLog(`MASK session=${sessionId} ${JSON.stringify(byCategory)}`);
				scheduleSave();
				return value;
			} catch (err) {
				process.stderr.write(`[omo-redact] 出站掩码异常（已放行原文）：${String((err as Error)?.message ?? err)}\n`);
				return undefined;
			}
		});
	} catch {
		/* 宿主无该事件：跳过（安全性退化为不掩码，须在 README 标注） */
	}

	try {
		// 入站（功能性）：工具参数占位符还原；无占位符时 no-op（工具以原始参数执行）
		pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | undefined => {
			if (!cfg.enabled || !cfg.restore) return undefined;
			try {
				const input: unknown = event.input;
				if (input === undefined) return undefined;
				const map = store.sessionMap(sessionId, Date.now());
				const aliasEntries = extractAliasEntries(map.reverse);
				if (map.reverse.size === 0 && aliasEntries.length === 0) return undefined;
				const { value, changed } = restoreDeep(input, map.reverse, aliasEntries);
				if (!changed) return undefined;
				debugLog(`RESTORE session=${sessionId} tool=${event.toolName}`);
				scheduleSave();
				return { input: value as Record<string, unknown> };
			} catch (err) {
				process.stderr.write(`[omo-redact] 入站还原异常（工具按占位符原文执行）：${String((err as Error)?.message ?? err)}\n`);
				return undefined;
			}
		});
	} catch {
		/* 宿主无该事件：跳过 */
	}

	// 工具层还原器：以会话账本为准（含别名），未开启 enabled/restore 时保持 no-op
	activeRestorer = cfg.enabled && cfg.restore
		? (value: unknown): unknown => {
				const map2 = store.sessionMap(sessionId, Date.now());
				const alias = extractAliasEntries(map2.reverse);
				if (map2.reverse.size === 0 && alias.length === 0) return value;
				const r = restoreDeep(value, map2.reverse, alias as ReadonlyArray<{ key: string; value: string }>);
				return r.changed ? r.value : value;
			}
		: undefined;

	// 周期清理 + 落盘（unref：不因该定时器阻止进程退出）
	const timer = setInterval(() => {
		store.prune(Date.now());
		if (dirty) {
			dirty = false;
			const saved = saveStateSync(statePath, { version: 1, maps: store.toPersistable() });
			if (!saved.ok) process.stderr.write(`[omo-redact] 状态落盘失败：${saved.error ?? "未知"}\n`);
		}
	}, 60_000);
	if (typeof timer.unref === "function") timer.unref();

	return { config: cfg, dir };
}
