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
}

/** loadConfig 的返回：路径字段已保证有值（缺省 → cwd/.ops-pi/），供 OpsContext 直接使用 */
export interface LoadedOpsConfig extends OpsConfig {
	policyPath: string;
	tokenPath: string;
}

const DEFAULT_POLICY_PATH = ".ops-pi/policy.json";
const DEFAULT_TOKEN_PATH = ".ops-pi/approval-token.json";

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
		policyPath: typeof raw.policyPath === "string" ? raw.policyPath : path.join(cwd, DEFAULT_POLICY_PATH),
		tokenPath: typeof raw.tokenPath === "string" ? raw.tokenPath : path.join(cwd, DEFAULT_TOKEN_PATH),
		vault: isVaultConfig(raw.vault) ? raw.vault : undefined,
		health: isHealthConfig(raw.health) ? raw.health : undefined,
		ssh: isSshConfig(raw.ssh) ? raw.ssh : undefined,
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
