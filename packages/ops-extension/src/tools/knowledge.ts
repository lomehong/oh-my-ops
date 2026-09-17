import * as fs from "node:fs/promises";
import * as path from "node:path";
import { READ, WRITE, normalizeTargetHost } from "@ops-pi/core";
import type { ExecResult, Runner } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { KnowledgeStore } from "../knowledge.ts";
import { syncKb } from "../kb-sync.ts";
import { credentialAgeDays, kbGitCredentialsPath, loadKbCredential, loadKbState, redactUrl, rotationHint } from "../kb-credential.ts";
import type { OpsContext } from "../context.ts";

export interface KbSyncConfig {
	/** git 远端（如 https://github.com/lomehong/omo-knowledge.git）；缺省 = 本地模式（不同步） */
	repo?: string;
	branch?: string;
}

/**
 * git 同步（P15；OMO-KB-SYNC P1 起改为复用 `kb-sync.ts` 的共享实现）。
 *
 * 行为升级点：
 *  - **git 兼容层**：按 `git --version` 退化（cwd 替代 `-C`、symbolic-ref 替代 `init -b`、stash/pop 替代 `--autostash`）→ el7（git 1.8.3.1）可用；
 *  - **分支纪律**：只 pull 主线；提交只推 `instance/<device>`，永不推 main（中心 PR 合流）；
 *  - 凭据：存在 `$OMO_DIR/kb/credential.json` 时自动注入 git 凭据（argv 只含路径），缺省无凭据仍按本地模式降级。
 * 全程 best-effort：失败不抛错，收集进 actions（本地知识库永远可用）。
 */
export async function gitSync(
	omoDir: string,
	kbDir: string,
	repo: string | undefined,
	branch: string,
	runner: Runner,
): Promise<{ actions: string[] }> {
	let credential;
	try {
		credential = await loadKbCredential(omoDir);
	} catch (err) {
		// 凭据文件存在但不可用：跳过远端同步并醒目上报（工具层 best-effort，不抛错）
		return { actions: [`凭据不可用（${(err as Error).message}）：已跳过远端同步；请用 ops-kb-provision 重新签发凭据`] };
	}
	const report = await syncKb({
		omoDir,
		kbDir,
		repo,
		branch,
		credential,
		gitCredentialFile: credential === undefined ? undefined : kbGitCredentialsPath(omoDir),
		runner,
		push: true,
	});
	const actions = [...report.actions];
	if (report.error !== undefined) actions.push(`同步未完成（保留本地）：${report.error}`);
	return { actions };
}

/** P15：Runbook 知识库工具——kb_list / kb_search（read 档）+ kb_save / kb_sync（write 档） */
export function registerKnowledgeTools(pi: ExtensionAPI, ctx: OpsContext, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_kb_list",
		label: "KB List",
		loadMode: "essential",
		approval: READ,
		description: "列出知识库条目（Runbook/处置案例/偏好）。只回标题与标签，不含正文。",
		parameters: z.object({}),
		async execute(_toolCallId, params, _signal) {
			const authz = assertAuthorized("ops_kb_list", params, ctx.authzView);
			const items = await ctx.kb.list();
			return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }], details: { authz } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_kb_search",
		label: "KB Search",
		loadMode: "essential",
		approval: READ,
		description: "检索知识库（大小写不敏感，命中标题/标签/正文行）。处置事件前先检索：'这类告警上次怎么修的'。",
		parameters: z.object({
			query: z.string().describe("检索关键词（如 '磁盘 100%'、'nginx 502'）"),
			limit: z.number().optional().describe("返回上限（缺省 20）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_kb_search", p, ctx.authzView);
			const hits = await ctx.kb.search(String(p.query ?? ""), p.limit !== undefined ? Number(p.limit) : 20);
			return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }], details: { authz, hits: hits.length } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_kb_save",
		label: "KB Save",
		loadMode: "essential",
		approval: approval("ops_kb_save"),
		description:
			"沉淀知识条目（write 档，须 Owner 预授权：policy.json 的 @local 规则 actions 须显式包含 'kb-write'，或批准令牌）。" +
			"处置完事件后调用：存 Runbook/根因/修复步骤。slug 为短横线小写标识（如 'nginx-502-upstream'）。",
		parameters: z.object({
			slug: z.string().describe("条目标识（短横线小写，如 'disk-full-log-rotate'）"),
			title: z.string().describe("标题（一句话说明问题/处置）"),
			content: z.string().describe("正文 markdown：现象/根因/处置步骤/验证方式"),
			tags: z.array(z.string()).optional().describe("标签（如 ['disk','nginx']）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			const slug = String(p.slug ?? "");
			const title = String(p.title ?? slug);
			const content = String(p.content ?? "");
			const tags = Array.isArray(p.tags) ? (p.tags as string[]).map(String) : [];
			if (slug === "" || title === "") throw new Error("[INTERNAL] 缺少 slug/title");
			const authz = assertAuthorized("ops_kb_save", { slug, title }, ctx.authzView);
			const meta = await ctx.kb.save(slug, title, content, tags);
			return {
				content: [{ type: "text", text: `已沉淀 '${meta.title}'（${meta.file}）` }],
				details: { authz, file: meta.file },
			};
		},
	});

	registerOpsTool(pi, {
		name: "ops_kb_status",
		label: "KB Status",
		loadMode: "essential",
		approval: READ,
		description:
			"知识库同步状态（read 档）：远端/分支/凭据（只显示前缀与已用天数）/最后同步时间与结果/轮换建议。" +
			"排障与巡检时调用；不发起同步、不改动任何状态。",
		parameters: z.object({}),
		async execute(_toolCallId, _params, _signal) {
			const authz = assertAuthorized("ops_kb_status", {}, ctx.authzView);
			let credential;
			let credentialError: string | undefined;
			try {
				credential = await loadKbCredential(ctx.omoDir);
			} catch (err) {
				credentialError = String((err as Error)?.message ?? err);
			}
			const state = await loadKbState(ctx.omoDir);
			const ctxLines: string[] = [`远端：${ctx.kbRepo === undefined ? "（未配置 → 本地模式）" : redactUrl(String(ctx.kbRepo))}`, `主线分支：${ctx.kbBranch}`];
			if (credentialError !== undefined) ctxLines.push(`凭据：不可用 —— ${credentialError}`);
			else if (credential === undefined) ctxLines.push("凭据：未配置（本地模式；可用 `omo kb enroll` 兑换）");
			else {
				const age = credentialAgeDays(credential.createdAt);
				ctxLines.push(`凭据：${credential.username}（${credential.kind}，前缀 ${credential.secret.slice(0, 8)}…${age === undefined ? "" : `，已用 ${age} 天`}）`);
				const hint = rotationHint(credential);
				if (hint !== undefined) ctxLines.push(`⚠ ${hint}`);
			}
			ctxLines.push(state === undefined ? "最后同步：（无记录）" : `最后同步：${state.lastSyncAt} ${state.ok ? "✓" : `✗ ${state.error ?? ""}`}`);
			if (state !== undefined && state.actions.length > 0) ctxLines.push(`最近动作：
${state.actions.slice(-6).map((a) => `  · ${a}`).join("\n")}`);
			return { content: [{ type: "text", text: ctxLines.join("\n") }], details: { authz, credentialError, lastSyncOk: state?.ok } };
		},
	});

	registerOpsTool(pi, {
		name: "ops_kb_sync",
		label: "KB Sync",
		loadMode: "essential",
		approval: approval("ops_kb_sync"),
		description:
			"知识库 git 同步（pull --rebase + commit + push；write 档，须 Owner 预授权：@local 规则 actions 须显式包含 'kb-sync'，或批准令牌）。" +
			"全程 best-effort：失败不阻塞本地使用。未配置远端 = 本地模式。host 参数仅做格式一致性校验（同步本身只操作知识仓 git，不涉及 ops 目标主机）。",
		parameters: z.object({
			host: z.string().optional().describe("保留参数（同步仅操作知识仓 git，不涉及 ops 目标主机）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			normalizeTargetHost(typeof p.host === "string" ? p.host : undefined);
			const authz = assertAuthorized("ops_kb_sync", { sync: true }, ctx.authzView);
			const { actions } = await gitSync(ctx.omoDir, ctx.kb.kbDir, ctx.kbRepo, ctx.kbBranch, ctx.shell);
			return {
				content: [{ type: "text", text: actions.length > 0 ? actions.join("\n") : "已是最新，无同步动作" }],
				details: { authz, actions },
			};
		},
	});
}
