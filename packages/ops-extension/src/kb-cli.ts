import * as os from "node:os";
import * as path from "node:path";
import { rm, stat } from "node:fs/promises";
import { ShellExec } from "@ops-pi/core";
import { loadConfig } from "./setup.ts";
import { syncKb } from "./kb-sync.ts";
import {
	daysUntilExpiry,
	omoHomeDir,
	kbCredentialPath,
	kbGitCredentialsPath,
	loadKbCredential,
	loadKbState,
	redactUrl,
	saveGitCredentialsFile,
	tokenPrefix,
} from "./kb-credential.ts";

/**
 * `omo kb` 子命令实现（OMO-KB-SYNC P1）——由启动器以 bun 执行：`omo kb <sync|status|disable>`。
 *
 * 与扩展内 `ops_kb_sync` 工具**共用同一同步实现**（`kb-sync.ts`），避免两套逻辑漂移。
 * 纪律：输出只显示 token 前缀；凭据文件缺失时按本地模式降级；任何失败都不影响本地知识库可用。
 */
export interface KbCliEnv {
	omoDir: string;
	kbDir: string;
	repo?: string;
	branch: string;
	credentialFile: string;
	gitCredentialFile: string;
	stateFile: string;
}

/** 解析运行环境：HOME（launcher 已重定向）→ 配置路径 → 私有域根 */
export function resolveKbEnv(home: string = process.env.HOME ?? os.homedir()): KbCliEnv {
	const cfg = loadConfig(home);
	const omoDir = path.dirname(cfg.policyPath);
	return {
		omoDir,
		kbDir: cfg.knowledge?.dir ?? path.join(omoDir, "knowledge"),
		repo: cfg.knowledge?.repo,
		branch: cfg.knowledge?.branch ?? "main",
		credentialFile: kbCredentialPath(omoDir),
		gitCredentialFile: kbGitCredentialsPath(omoDir),
		stateFile: path.join(omoDir, "kb", "state.json"),
	};
}

async function fileExists(p: string): Promise<boolean> {
	return await stat(p).then(() => true).catch(() => false);
}

async function runSync(env: KbCliEnv, opts: { push: boolean; quiet: boolean }): Promise<number> {
	const credential = await loadKbCredential(env.omoDir);
	// 凭据存在但 git 凭据文件缺失（如手工删过）→ 重新生成，保证 git 能取到
	if (credential !== undefined && !(await fileExists(env.gitCredentialFile))) {
		await saveGitCredentialsFile(env.omoDir, credential);
		if (!opts.quiet) console.log(`↻ 已重建 git 凭据文件：${env.gitCredentialFile}`);
	}
	const report = await syncKb({
		omoDir: env.omoDir,
		kbDir: env.kbDir,
		repo: env.repo,
		branch: env.branch,
		credential,
		gitCredentialFile: credential === undefined ? undefined : env.gitCredentialFile,
		// 私有 HOME 一律由 omoDir 推导：调用方 HOME 可能是别的（真机实测：传 process.env.HOME 会让 store 找错目录）
		omoHome: omoHomeDir(env.omoDir),
		runner: new ShellExec(),
		push: opts.push,
	});
	if (!opts.quiet) {
		for (const a of report.actions) console.log(`  · ${a}`);
		if (report.error !== undefined) console.error(`  ✗ ${report.error}`);
		else console.log(report.pushed ? "  ✓ 同步完成（已推实例分支）" : "  ✓ 同步完成");
	}
	return report.ok ? 0 : 1;
}

async function runStatus(env: KbCliEnv): Promise<number> {
	const credential = await loadKbCredential(env.omoDir);
	const state = await loadKbState(env.omoDir);
	const repo = credential?.repo ?? env.repo;
	console.log(`远端：${repo === undefined ? "（未配置 → 本地模式）" : redactUrl(repo)}`);
	console.log(`分支：主线 ${env.branch}｜实例分支 instance/<device>（device=${process.env.YUYI_DEVICE ?? os.hostname()}）`);
	console.log(`知识库目录：${env.kbDir}`);
	if (credential === undefined) console.log("凭据：未配置（本地模式；`omo kb enroll` 属 P3）");
	else {
		const days = daysUntilExpiry(credential.expiresAt);
		console.log(
			`凭据：${credential.username} token=${tokenPrefix(credential.token)}${days === undefined ? "（无过期）" : `（${days} 天后过期${days <= 30 ? " ⚠ 建议轮换" : ""}）`}`,
		);
	}
	console.log(state === undefined ? "最后同步：（无记录）" : `最后同步：${state.lastSyncAt} ${state.ok ? "✓" : `✗ ${state.error ?? ""}`}`);
	return 0;
}

async function runDisable(env: KbCliEnv): Promise<number> {
	for (const f of [env.credentialFile, env.gitCredentialFile]) {
		await rm(f, { force: true });
	}
	console.log("已停用远端同步（凭据已删除；本地知识库保留）。重新启用需 Owner 重新发放凭据。");
	return 0;
}

/** 定时模式：sync → sleep → 循环（启动器 `omo serve` 拉起，日志落 /tmp/omo-kb-sync.log） */
async function runLoop(env: KbCliEnv, intervalSec: number): Promise<number> {
	const iv = Number.isFinite(intervalSec) && intervalSec >= 60 ? intervalSec : 900;
	console.log(`[kb-sync] 定时同步启动：每 ${iv}s 一次（push=false；只拉主线）`);
	for (;;) {
		const code = await runSync(env, { push: false, quiet: true });
		console.log(`[kb-sync] ${new Date().toISOString()} exit=${code}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, iv * 1000);
		await promise;
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const cmd = argv.find((a) => !a.startsWith("--")) ?? "status";
	const env = resolveKbEnv();
	switch (cmd) {
		case "sync":
			return await runSync(env, { push: argv.includes("--push"), quiet: argv.includes("--quiet") });
		case "loop": {
			const i = argv.indexOf("--interval");
			const sec = i >= 0 ? Number(argv[i + 1]) : Number(process.env.OMO_KB_INTERVAL ?? 900);
			return await runLoop(env, sec);
		}
		case "status":
			return await runStatus(env);
		case "disable":
			return await runDisable(env);
		case "enroll":
			console.error("enroll 属 P3（供给服务部署决策后启用）；当前请 Owner 发放凭据并写入 kb/credential.json");
			return 2;
		default:
			console.log("用法：omo kb <sync [--push] [--quiet] | status | disable | loop [--interval 秒]>");
			return 2;
	}
}

if (import.meta.main === true || process.env.OMO_KB_CLI_FORCE_RUN === "1") {
	main().then((code) => process.exit(code)).catch((err) => {
		console.error(`[kb] 异常：${String((err as Error)?.message ?? err)}`);
		process.exit(1);
	});
}
