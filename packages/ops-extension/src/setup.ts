import * as fs from "node:fs";
import * as path from "node:path";

export interface OpsConfig {
	/** 部署环境显式指定；缺省 auto（§7.4.4 探针边界：无法自检 approvalMode） */
	hostMode?: "pi" | "omp";
	policyPath?: string;
	tokenPath?: string;
	vault?: { dbPath?: string };
	health?: { autoPollIntervalMs?: number };
}

const DEFAULT_POLICY_PATH = ".ops-pi/policy.json";
const DEFAULT_TOKEN_PATH = ".ops-pi/approval-token.json";

/** 配置加载（方案 §7.3）：扩展加载时同步读取（早于 session_start）。 */
export function loadConfig(cwd: string): OpsConfig {
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
