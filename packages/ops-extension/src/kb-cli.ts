import * as os from "node:os";
import * as path from "node:path";
import { rm, stat } from "node:fs/promises";
import { ShellExec } from "@ops-pi/core";
import { loadConfig } from "./setup.ts";
import { syncKb, deviceName } from "./kb-sync.ts";
import { enroll, parseEnrollArgs } from "./kb-enroll.ts";
import {
	daysUntilExpiry,
	omoHomeDir,
	kbCredentialPath,
	kbGitCredentialsPath,
	loadKbCredential,
	loadKbState,
	redactUrl,
	rotationHint,
	credentialAgeDays,
	ensureGitCredentialsFile,
	secretPrefix,
	KbCredentialError,
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

/**
 * 读凭据：文件不存在 → undefined（本地模式，合法）；文件存在但不可用 → 明确报错退出。
 * 真机教训：schema 变更后曾被静默忽略 → 实例表面「本地模式」却实际有凭据不生效；静默降级必须禁止。
 */
async function loadCredentialOrExit(omoDir: string) {
	try {
		return await loadKbCredential(omoDir);
	} catch (err) {
		console.error(`✗ 凭据不可用：${(err as Error).message}`);
		console.error("  · 重新签发：node scripts/ops-kb-provision.mjs create|rotate …（P3 enroll 部署后可用 omo kb enroll）");
		process.exit(1);
	}
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

async function runSync(env: KbCliEnv, opts: { push: boolean; quiet: boolean }): Promise<number> {
	const credential = await loadCredentialOrExit(env.omoDir);
	// git store 凭据文件按需刷新（缺失 **或** 与当前凭据不一致——轮换后必须刷新，否则实例继续拿旧密码同步失败）
	if (credential !== undefined && (await ensureGitCredentialsFile(env.omoDir, credential)) && !opts.quiet) {
		console.log(`↻ 已刷新 git 凭据文件：${env.gitCredentialFile}`);
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

export async function runStatus(env: KbCliEnv): Promise<number> {
	const credential = await loadCredentialOrExit(env.omoDir);
	const state = await loadKbState(env.omoDir);
	const repo = credential?.repo ?? env.repo;
	console.log(`远端：${repo === undefined ? "（未配置 → 本地模式）" : redactUrl(repo)}`);
	console.log(`分支：主线 ${env.branch}｜实例分支 instance/<device>（device=${process.env.YUYI_DEVICE ?? os.hostname()}）`);
	console.log(`知识库目录：${env.kbDir}`);
	if (credential === undefined) {
		console.log("凭据：未配置（本地模式）");
		// 曾同步过却丢了凭据 ⇒ 必须显式告警（今日多次踩到「静默降级比报错危险」）
		if (state !== undefined) {
			console.log(`⚠ 本机此前同步过（${state.lastSyncAt}）但凭据已缺失：远端同步处于停用状态；`);
			console.log("  · 重新接入：Owner 签发 enroll（或 rotate）码后执行 omo kb enroll --server <url> --code-file <0600>");
		}
	}
	else {
		const days = daysUntilExpiry(credential.expiresAt);
		const age = credentialAgeDays(credential.createdAt);
		console.log(
			`凭据：${credential.username} ${credential.kind}=${secretPrefix(credential.secret)}${days === undefined ? `（无过期${age === undefined ? "" : `，已用 ${age} 天`}）` : `（${days} 天后过期）`}`,
		);
		const hint = rotationHint(credential);
		if (hint !== undefined) console.log(`⚠ ${hint}`);
	}
	console.log(state === undefined ? "最后同步：（无记录）" : `最后同步：${state.lastSyncAt} ${state.ok ? "✓" : `✗ ${state.error ?? ""}`}`);
	return 0;
}

export async function runDisable(env: KbCliEnv): Promise<number> {
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

/**
 * `omo kb enroll`：向自注册服务兑换一次性码 → 落盘凭据（0600）→ **就地自证**（拉一次主线）。
 * 秘密只经 HTTPS 响应进入；失败给出可操作原因（码无效/过期/已用/设备不匹配）。
 */
async function runEnroll(env: KbCliEnv, argv: string[]): Promise<number> {
	const opts = await parseEnrollArgs(argv);
	opts.device = opts.device === "" ? deviceName() : opts.device;
	let r;
	try {
		r = await enroll(opts, env.omoDir);
	} catch (err) {
		console.error(`✗ ${String((err as Error)?.message ?? err)}`);
		return 1;
	}
	console.log(`✓ ${r.message}`);
	if (r.revoked === true) return 0;
	// 自证：立刻拉一次主线（pull-only），确证「凭据 + 授权 + 网络」同时可用
	env.repo = env.repo ?? r.credential?.repo;
	const code = await runSync(env, { push: false, quiet: false });
	if (code !== 0) {
		console.error("✗ 凭据已落盘，但自证同步失败：请检查网络/服务端授权（凭据保留，可重试 `omo kb sync`）");
		return code;
	}
	console.log("✓ 自证通过：知识库已可同步");
	return 0;
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
			return await runEnroll(env, argv);
		default:
			console.log("用法：omo kb <sync [--push] [--quiet] | status | disable | loop [--interval 秒] | enroll --server <url> --code-file <0600> [--device 名]>");
			return 2;
	}
}

if (import.meta.main === true || process.env.OMO_KB_CLI_FORCE_RUN === "1") {
	main().then((code) => process.exit(code)).catch((err) => {
		console.error(`[kb] 异常：${String((err as Error)?.message ?? err)}`);
		process.exit(1);
	});
}
