import * as fs from "node:fs";
import * as path from "node:path";
import type { SshConfig } from "@ops-pi/core";

export interface OpsConfig {
	/** 部署环境显式指定；缺省 auto（§7.4.4 探针边界：无法自检 approvalMode） */
	hostMode?: "pi" | "omp";
	policyPath?: string;
	tokenPath?: string;
	vault?: { dbPath?: string };
	health?: { autoPollIntervalMs?: number };
	ssh?: SshConfig;
	knowledge?: { dir?: string; repo?: string; branch?: string };
}

/** loadConfig 的返回：路径字段已保证有值（缺省 → cwd/.ops-pi/），供 OpsContext 直接使用 */
export interface LoadedOpsConfig extends OpsConfig {
	policyPath: string;
	tokenPath: string;
}

const DEFAULT_POLICY_PATH = ".ops-pi/policy.json";
const DEFAULT_TOKEN_PATH = ".ops-pi/approval-token.json";

/**
 * 路径解析（优先级：config.json 显式值 > 环境变量 > cwd 缺省）。
 * 环境变量用于「部署态固定私有域」（自包含安装器由启动器注入，
 * 如 OMO_POLICY_PATH=~/.omo/policy.json）——避免有效配置随启动目录漂移。
 */
function resolvePath(rawValue: unknown, envKey: string, cwd: string, fallback: string): string {
	if (typeof rawValue === "string" && rawValue !== "") return rawValue;
	const env = process.env[envKey];
	if (typeof env === "string" && env !== "") return env;
	return path.join(cwd, fallback);
}

/** 配置加载（方案 §7.3）：扩展加载时同步读取（早于 session_start）。 */
export function loadConfig(cwd: string): LoadedOpsConfig {
	const configPath = path.join(cwd, ".ops-pi", "config.json");
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		raw = {}; // 无配置文件 → 使用缺省 + 全拒策略（保守侧）
	}
	return {
		hostMode: raw.hostMode === "pi" || raw.hostMode === "omp" ? raw.hostMode : "omp",
		policyPath: resolvePath(raw.policyPath, "OMO_POLICY_PATH", cwd, DEFAULT_POLICY_PATH),
		tokenPath: resolvePath(raw.tokenPath, "OMO_TOKEN_PATH", cwd, DEFAULT_TOKEN_PATH),
		vault: isVaultConfig(raw.vault) ? raw.vault : undefined,
		health: isHealthConfig(raw.health) ? raw.health : undefined,
		ssh: isSshConfig(raw.ssh) ? raw.ssh : undefined,
		knowledge: isKnowledgeConfig(raw.knowledge) ? raw.knowledge : undefined,
	};
}

function isHealthConfig(value: unknown): value is NonNullable<OpsConfig["health"]> {
	if (value === null || typeof value !== "object") return false;
	const interval = (value as Record<string, unknown>).autoPollIntervalMs;
	return typeof interval === "number" && Number.isFinite(interval) && interval > 0;
}


function isVaultConfig(value: unknown): value is NonNullable<OpsConfig["vault"]> {
	if (value === null || typeof value !== "object") return false;
	const dbPath = (value as Record<string, unknown>).dbPath;
	return typeof dbPath === "string" && dbPath !== "";
}

function isSshConfig(value: unknown): value is NonNullable<OpsConfig["ssh"]> {
	if (value === null || typeof value !== "object") return false;
	const rec = value as Record<string, unknown>;
	const numOk = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	const strOk = (v: unknown) => typeof v === "string" && v !== "";
	return (
		(rec.user === undefined || strOk(rec.user)) &&
		(rec.port === undefined || numOk(rec.port)) &&
		(rec.identityFile === undefined || strOk(rec.identityFile)) &&
		(rec.connectTimeoutSec === undefined || numOk(rec.connectTimeoutSec)) &&
		(rec.controlPersistSec === undefined || numOk(rec.controlPersistSec)) &&
		(rec.maxSessions === undefined || numOk(rec.maxSessions))
	);
}

function isKnowledgeConfig(value: unknown): value is NonNullable<OpsConfig["knowledge"]> {
	if (value === null || typeof value !== "object") return false;
	const rec = value as Record<string, unknown>;
	const strOk = (v: unknown) => typeof v === "string" && v !== "";
	return (
		(rec.dir === undefined || strOk(rec.dir)) &&
		(rec.repo === undefined || strOk(rec.repo)) &&
		(rec.branch === undefined || strOk(rec.branch))
	);
}
