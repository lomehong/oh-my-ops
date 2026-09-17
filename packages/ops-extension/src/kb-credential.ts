import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * KB 凭据与同步状态（OMO-KB-SYNC P1）。
 *
 * 纪律：
 * - 凭据只落 `$OMO_DIR/kb/`（0600）+ git 凭据文件（0600，`store` 格式）；**不入知识库、不入日志**；
 * - 该目录已加入 PathGuard 机密根（Agent 经 ops_file_* 读不到）；
 * - 任何面向用户的输出只暴露 **token 前缀**，不打印全量 token。
 */
export interface KbCredential {
	/** 远端 URL（形如 https://twin.hzins.com/git/hzins-ops/ops-kb） */
	repo: string;
	/** Gitea bot 账号名 */
	username: string;
	/** 作用域 access token（明文仅存本机 0600） */
	token: string;
	/** 过期时间（ISO）；缺省 = 无过期 */
	expiresAt?: string;
	createdAt: string;
}

export interface KbSyncState {
	lastSyncAt: string;
	ok: boolean;
	mainBranch: string;
	instanceBranch: string;
	actions: string[];
	error?: string;
}

export function kbStateDir(omoDir: string): string {
	return path.join(omoDir, "kb");
}
export function kbCredentialPath(omoDir: string): string {
	return path.join(kbStateDir(omoDir), "credential.json");
}
export function kbGitCredentialsPath(omoDir: string): string {
	return path.join(kbStateDir(omoDir), "git-credentials");
}
export function kbStatePath(omoDir: string): string {
	return path.join(kbStateDir(omoDir), "state.json");
}

/** 读凭据；缺失/损坏 → undefined（调用方按「本地模式」降级） */
export async function loadKbCredential(omoDir: string): Promise<KbCredential | undefined> {
	try {
		const raw = JSON.parse(await fs.readFile(kbCredentialPath(omoDir), "utf8")) as Partial<KbCredential>;
		if (typeof raw.repo !== "string" || typeof raw.username !== "string" || typeof raw.token !== "string") return undefined;
		if (raw.repo === "" || raw.username === "" || raw.token === "") return undefined;
		return { repo: raw.repo, username: raw.username, token: raw.token, expiresAt: raw.expiresAt, createdAt: raw.createdAt ?? new Date().toISOString() };
	} catch {
		return undefined;
	}
}

/** 写凭据（目录 0700、文件 0600）；覆盖前不保留旧值 */
export async function saveKbCredential(omoDir: string, cred: KbCredential): Promise<string> {
	const dir = kbStateDir(omoDir);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = kbCredentialPath(omoDir);
	await fs.writeFile(file, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
	return file;
}

/** 写 git `store` 格式凭据文件（0600）：`<scheme>://<user>:<token>@<host>` */
export async function saveGitCredentialsFile(omoDir: string, cred: KbCredential): Promise<string> {
	const dir = kbStateDir(omoDir);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const u = new URL(cred.repo);
	const encodedUser = encodeURIComponent(cred.username);
	const encodedToken = encodeURIComponent(cred.token);
	const line = `${u.protocol}//${encodedUser}:${encodedToken}@${u.host}\n`;
	const file = kbGitCredentialsPath(omoDir);
	await fs.writeFile(file, line, { mode: 0o600 });
	return file;
}

/** `-c credential.helper=` 的取值（只含**文件路径**，不含秘密） */
export function gitCredentialHelperArg(credFile: string): string {
	return `store --file=${credFile}`;
}

/** 供展示的 token 前缀 */
export function tokenPrefix(token: string): string {
	return token.length <= 8 ? `${token.slice(0, 2)}…` : `${token.slice(0, 8)}…`;
}

/** 距过期天数（无 expiresAt → undefined；已过期 → 负数） */
export function daysUntilExpiry(expiresAt?: string, nowMs: number = Date.now()): number | undefined {
	if (expiresAt === undefined) return undefined;
	const t = Date.parse(expiresAt);
	if (Number.isNaN(t)) return undefined;
	return Math.floor((t - nowMs) / 86_400_000);
}

/** 脱敏 URL（去掉可能内嵌的 user:token@），用于任何输出 */
export function redactUrl(url: string): string {
	return url.replace(/\/\/[^/@]*@/, "//");
}

export async function loadKbState(omoDir: string): Promise<KbSyncState | undefined> {
	try {
		const raw = JSON.parse(await fs.readFile(kbStatePath(omoDir), "utf8")) as Partial<KbSyncState>;
		if (typeof raw.lastSyncAt !== "string") return undefined;
		return {
			lastSyncAt: raw.lastSyncAt,
			ok: raw.ok === true,
			mainBranch: raw.mainBranch ?? "main",
			instanceBranch: raw.instanceBranch ?? "",
			actions: Array.isArray(raw.actions) ? raw.actions : [],
			error: raw.error,
		};
	} catch {
		return undefined;
	}
}

export async function saveKbState(omoDir: string, state: KbSyncState): Promise<void> {
	const dir = kbStateDir(omoDir);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.writeFile(kbStatePath(omoDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
