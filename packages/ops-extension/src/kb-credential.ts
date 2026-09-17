import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * KB 凭据与同步状态（OMO-KB-SYNC P1）。
 *
 * 纪律：
 * - 凭据只落 `$OMO_DIR/kb/`（0600）+ git 凭据文件（0600，`store` 格式）；**不入知识库、不入日志**；
 * - 该目录已加入 PathGuard 机密根（Agent 经 ops_file_* 读不到）；
 * - 任何面向用户的输出只暴露 **秘密前缀**，不打印全量秘密。
 * - 凭据形态两种（都已在 Gitea 1.27.3 验证可用）：`kind: "password"`（API 全自动可签发/轮换/吊销）
 *   与 `kind: "token"`（人工/CLI 签发）。git 侧两者同构：都是 HTTP 基本认证的密码位。
 */
export interface KbCredential {
	/** 远端 URL（形如 https://twin.hzins.com/git/hzins-ops/ops-kb） */
	repo: string;
	/** Gitea bot 账号名 */
	username: string;
	/** 秘密本体（密码或 access token；明文仅存本机 0600） */
	secret: string;
	/** 凭据形态：password=可 API 自动签发/轮换/吊销；token=人工/CLI 签发 */
	kind: "password" | "token";
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
/**
 * git `store` 凭据文件路径。
 *
 * 实测（2026-09-17，真机 Gitea + git 2.39）：`-c credential.helper="store --file=<p>"` **不被 git 采纳**
 * （三种写法均 "Failed to authenticate user"），而 store 的 **canonical 路径** `$HOME/.git-credentials`
 * + `-c credential.helper=store` 可用。故此处直接落在 omo 私有 HOME 下（该目录整体已在 PathGuard 机密根内）。
 */
export function kbGitCredentialsPath(omoDir: string): string {
	return path.join(omoHomeDir(omoDir), ".git-credentials");
}

/** omo 私有 HOME（launcher 重定向目标；git store 与凭据文件都落这里，受机密根保护） */
export function omoHomeDir(omoDir: string): string {
	return path.join(omoDir, "home");
}
export function kbStatePath(omoDir: string): string {
	return path.join(kbStateDir(omoDir), "state.json");
}

/** 凭据文件存在但不可用（格式错误/字段缺失/旧格式）——必须**大声失败**，不得静默降级为「本地模式」 */
export class KbCredentialError extends Error {}

/**
 * 读凭据。
 * - 文件**不存在** → `undefined`（调用方按「本地模式」降级，合法）；
 * - 文件**存在但不可用** → 抛 `KbCredentialError`（真机教训：曾因 schema 变更后静默忽略，
 *   实例表面「本地模式」、实际有凭据却不生效 —— 静默降级比报错危险得多）。
 */
export async function loadKbCredential(omoDir: string): Promise<KbCredential | undefined> {
	const file = kbCredentialPath(omoDir);
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new KbCredentialError(`凭据文件不可读：${file}（${(err as Error).message}）`);
	}
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new KbCredentialError(`凭据文件不是合法 JSON：${file}`);
	}
	if (typeof raw["token"] === "string") {
		throw new KbCredentialError(`凭据文件是旧格式（字段 token）：${file} —— 请用 ops-kb-provision 重新签发（新格式 {repo,username,secret,kind}）`);
	}
	const { repo, username, secret, kind, expiresAt, createdAt } = raw as Partial<KbCredential>;
	if (typeof repo !== "string" || typeof username !== "string" || typeof secret !== "string" || (kind !== "password" && kind !== "token")) {
		throw new KbCredentialError(`凭据文件字段不完整/不合法：${file}（需要 repo/username/secret/kind）`);
	}
	if (repo === "" || username === "" || secret === "") throw new KbCredentialError(`凭据文件存在空值：${file}`);
	return { repo, username, secret, kind, expiresAt, createdAt: createdAt ?? new Date().toISOString() };
}

/** 写凭据（目录 0700、文件 0600）；覆盖前不保留旧值 */
export async function saveKbCredential(omoDir: string, cred: KbCredential): Promise<string> {
	const dir = kbStateDir(omoDir);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = kbCredentialPath(omoDir);
	await fs.writeFile(file, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
	return file;
}

/** 写 git `store` 格式凭据文件（0600）：`<scheme>://<user>:<secret>@<host>`（密码/令牌同构） */
export async function saveGitCredentialsFile(omoDir: string, cred: KbCredential): Promise<string> {
	const u = new URL(cred.repo);
	const encodedUser = encodeURIComponent(cred.username);
	const encodedSecret = encodeURIComponent(cred.secret);
	const line = `${u.protocol}//${encodedUser}:${encodedSecret}@${u.host}\n`;
	const file = kbGitCredentialsPath(omoDir);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, line, { mode: 0o600 });
	return file;
}

/**
 * 按需刷新 git store 凭据文件：内容与期望不同才写（幂等 + 修复轮换后陈旧凭据）。
 * 真机教训：轮换后仅当文件「不存在」才写 ⇒ 实例继续用旧密码同步失败。
 * @returns true=本次发生写入
 */
export async function ensureGitCredentialsFile(omoDir: string, cred: KbCredential): Promise<boolean> {
	const u = new URL(cred.repo);
	const line = `${u.protocol}//${encodeURIComponent(cred.username)}:${encodeURIComponent(cred.secret)}@${u.host}\n`;
	const file = kbGitCredentialsPath(omoDir);
	const current = await fs.readFile(file, "utf8").catch(() => undefined);
	if (current === line) return false;
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, line, { mode: 0o600 });
	return true;
}

/** 供展示的秘密前缀（永不打印全量） */
export function secretPrefix(secret: string): string {
	return secret.length <= 8 ? `${secret.slice(0, 2)}…` : `${secret.slice(0, 8)}…`;
}

/** 凭据已用天数（createdAt 解析失败 → undefined） */
export function credentialAgeDays(createdAt?: string, nowMs: number = Date.now()): number | undefined {
	if (createdAt === undefined) return undefined;
	const t = Date.parse(createdAt);
	if (Number.isNaN(t)) return undefined;
	return Math.floor((nowMs - t) / 86_400_000);
}

/** 轮换建议：密码形态凭据没有自带过期 ⇒ 按**已用天数**提醒（默认 180 天） */
export function rotationHint(credential: KbCredential, nowMs: number = Date.now(), thresholdDays = 180): string | undefined {
	if (credential.expiresAt !== undefined) {
		const days = daysUntilExpiry(credential.expiresAt, nowMs);
		if (days !== undefined && days <= 30) return `凭据 ${days} 天后过期，建议轮换（ops-kb-provision rotate / omo kb enroll --op rotate）`;
		return undefined;
	}
	const age = credentialAgeDays(credential.createdAt, nowMs);
	if (age === undefined) return undefined;
	return age >= thresholdDays ? `凭据已使用 ${age} 天（阈值 ${thresholdDays} 天），建议轮换：Owner 签发 rotate 码后本机执行 omo kb enroll` : undefined;
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
