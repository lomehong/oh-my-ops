import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectGitCaps, GitCompat } from "@ops-pi/core";
import type { Runner } from "@ops-pi/core";
import { redactUrl, saveKbState } from "./kb-credential.ts";
import type { KbCredential } from "./kb-credential.ts";

/**
 * KB git 同步（OMO-KB-SYNC P1）：ext 工具与 `omo kb` CLI 共用同一实现。
 *
 * 分支纪律（主人 2026-09-17 决策）：
 *   - **只 pull `main`**（共享主线）；
 *   - 提交只推 **`instance/<device>`**（首次 push 自动建分支），**永不推 main** → 由中心 PR 合流，
 *     保留知识库「待审核」评审门。
 *
 * 全程 best-effort：失败不抛错、不阻塞本地知识库可用（离线优先），结果写 `kb/state.json` 供 `omo kb status`。
 */
export interface KbSyncOptions {
	/** 私有域根（$OMO_DIR） */
	omoDir: string;
	/** 知识库工作目录 */
	kbDir: string;
	/** 远端（优先取凭据内 URL；缺省则本地模式） */
	repo?: string;
	/** 主线分支（缺省 main） */
	branch?: string;
	/** 设备名（缺省 YUYI_DEVICE / hostname） */
	device?: string;
	credential?: KbCredential;
	/** 仅用于「凭据已配置」判定：true 时注入 `credential.helper=store` 与私有 HOME（秘密仍在 0600 文件里，不进 argv） */
	gitCredentialFile?: string;
	/** omo 私有 HOME（store 读 $HOME/.git-credentials 的基准；缺省 <omoDir>/home） */
	omoHome?: string;
	runner: Runner;
	/** true = 提交并推实例分支；false = 仅拉取 */
	push?: boolean;
	now?: () => Date;
}

export interface KbSyncReport {
	ok: boolean;
	actions: string[];
	mainBranch: string;
	instanceBranch: string;
	pushed: boolean;
	error?: string;
}

/** git 分支名安全化（ref 允许 [A-Za-z0-9._/-]，且不得以 - 开头/含 ..） */
export function instanceBranchFor(device: string): string {
	const safe = device
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 60);
	return `instance/${safe === "" ? "unknown" : safe}`;
}

/** 设备名：与 yuyi 插件同口径（YUYI_DEVICE → hostname） */
export function deviceName(): string {
	return process.env.YUYI_DEVICE ?? os.hostname();
}

/**
 * 本地忽略：把「状态/凭据」文件名写进 `<kbDir>/.git/info/exclude`（仅本仓库、不入库、不改 KB 内容）。
 * 即便 kbDir 被误配成与 `$OMO_DIR/kb` 重叠，凭据也不会被 commit 进知识库。
 */
export async function ensureLocalExcludes(kbDir: string, patterns: readonly string[]): Promise<void> {
	const file = path.join(kbDir, ".git", "info", "exclude");
	try {
		const current = await fs.readFile(file, "utf8").catch(() => "");
		const have = new Set(current.split("\n").map((l) => l.trim()));
		const missing = patterns.filter((p) => !have.has(p));
		if (missing.length === 0) return;
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${current.trimEnd()}\n${missing.map((p) => `${p}\n`).join("")}`, "utf8");
	} catch {
		/* 忽略写入失败：不影响同步主流程（凭据默认不在工作树内） */
	}
}

export async function syncKb(opts: KbSyncOptions): Promise<KbSyncReport> {
	const now = opts.now ?? (() => new Date());
	const mainBranch = opts.branch ?? "main";
	const instanceBranch = instanceBranchFor(opts.device ?? deviceName());
	const repo = opts.credential?.repo ?? opts.repo;
	const actions: string[] = [];
	const report = (ok: boolean, error?: string, pushed = false): KbSyncReport => ({
		ok,
		actions,
		mainBranch,
		instanceBranch,
		pushed,
		error,
	});
	const finish = async (r: KbSyncReport): Promise<KbSyncReport> => {
		try {
			await saveKbState(opts.omoDir, {
				lastSyncAt: now().toISOString(),
				ok: r.ok,
				mainBranch,
				instanceBranch,
				actions: r.actions,
				error: r.error,
			});
		} catch {
			/* 状态落盘失败不影响同步语义 */
		}
		return r;
	};

	if (instanceBranch === mainBranch) {
		return await finish(report(false, "实例分支不得等于主线分支（分支纪律）"));
	}
	if (repo === undefined || repo === "") {
		actions.push("未配置远端 → 本地模式（不同步）");
		return await finish(report(true));
	}
	actions.push(`远端：${redactUrl(repo)}｜主线 ${mainBranch}｜实例分支 ${instanceBranch}`);

	// 首跑时 kbDir 可能不存在：spawn 的 cwd 不存在会直接 ENOENT（真机首验踩到）
	await fs.mkdir(opts.kbDir, { recursive: true }).catch(() => undefined);
	const caps = await detectGitCaps(opts.runner);
	if (caps === undefined) {
		return await finish(report(false, "git 不可用（未找到可执行的 git）"));
	}
	actions.push(`git ${caps.version}（cwd 模式${caps.supportsAutostash ? "" : "；stash/pop 替代 --autostash"}${caps.supportsInitB ? "" : "；symbolic-ref 替代 init -b"}）`);

	const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
	// 凭据注入：`-c credential.helper=store` + **私有 HOME**（store 读 $HOME/.git-credentials，0600）。
	// 实测反例：`store --file=<path>` 形态不被本版 git 采纳；且秘密绝不进 argv/远端 URL（远端 URL 存在 .git/config，Agent 可读）。
	const prefix: string[] = [];
	if (opts.gitCredentialFile !== undefined) {
		prefix.push("-c", "credential.helper=store");
		env.HOME = opts.omoHome ?? path.join(opts.omoDir, "home");
	}
	const g = new GitCompat(opts.runner, opts.kbDir, caps, env, prefix);

	try {
		if (!(await g.isRepo())) {
			actions.push(await g.initOn(mainBranch));
		}
		const added = await g.ensureRemote(repo);
		if (added !== undefined) actions.push(added);
		// 状态/凭据文件绝不入库（含 kbDir 与 $OMO_DIR/kb 重叠的误配场景）
		await ensureLocalExcludes(opts.kbDir, ["credential.json", "git-credentials", "state.json", "kb/"]);

		// 拉取始终作用于主线（只读共享主线）
		let failed = false;
		const pullMsg = await g.pullRebase("origin", mainBranch);
		actions.push(pullMsg);
		if (pullMsg.startsWith("pull 失败")) {
			failed = true;
			if (/authenticate|Authentication failed/i.test(pullMsg)) {
				actions.push("提示：远端拒绝凭据——可能已轮换/吊销；请刷新 kb/credential.json（ops-kb-provision rotate 后重新投递）");
			}
		}

		let pushed = false;
		if (opts.push === true) {
			const commit = await g.commitAll(`kb: sync ${now().toISOString()}@${opts.device ?? deviceName()}`);
			if (commit === undefined) actions.push("无本地改动，无需提交");
			else {
				actions.push(commit);
				const pushMsg = await g.push("origin", instanceBranch);
				actions.push(pushMsg);
				pushed = pushMsg.includes("✓");
				if (pushMsg.startsWith("push 失败")) failed = true;
			}
		}
		return await finish(report(!failed, failed ? "同步未完成（详见 actions；本地知识库保持可用）" : undefined, pushed));
	} catch (err) {
		return await finish(report(false, String((err as Error)?.message ?? err)));
	}
}
