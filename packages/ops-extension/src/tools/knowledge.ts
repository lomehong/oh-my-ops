import * as fs from "node:fs/promises";
import { READ, WRITE, normalizeTargetHost } from "@ops-pi/core";
import type { ExecResult, Runner } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { KnowledgeStore } from "../knowledge.ts";
import type { OpsContext } from "../context.ts";

export interface KbSyncConfig {
	/** git 远端（如 https://github.com/lomehong/omo-knowledge.git）；缺省 = 本地模式（不同步） */
	repo?: string;
	branch?: string;
}

/**
 * git 同步（P15）：knowledge 目录 ↔ git 真源。
 * 全程 best-effort：任一步失败不抛错，收集进报告——本地知识库永远可用（离线优先）。
 * 冲突策略：pull --rebase autostash；rebase 失败 → 保留本地、报告提示人工处理。
 */
export async function gitSync(kbDir: string, repo: string | undefined, branch: string, runner: Runner): Promise<{ actions: string[] }> {
	const actions: string[] = [];
	const g = async (args: string[], allowFail = false): Promise<ExecResult> => {
		const r = await runner.exec(["git", "-C", kbDir, ...args], { timeoutMs: 60_000 });
		if (r.exitCode !== 0 && !allowFail) throw new Error(r.stderr.slice(0, 300) || `git ${args[0]} 失败`);
		return r;
	};

	await fs.mkdir(kbDir, { recursive: true });
	const gitDir = await fs.stat(`${kbDir}/.git`).then(() => true).catch(() => false);
	if (!gitDir) {
		await g(["init", "-b", branch]);
		actions.push(`git init（${branch}）`);
	}
	if (repo !== undefined && repo !== "") {
		const remotes = await g(["remote"], true);
		if (!remotes.stdout.includes("origin")) {
			await g(["remote", "add", "origin", repo]);
			actions.push(`remote add origin ${repo}`);
		}
		const fetch = await g(["fetch", "origin"], true);
		if (fetch.exitCode === 0) {
			const pull = await g(["pull", "--rebase", "--autostash", "origin", branch], true);
			if (pull.exitCode === 0) actions.push("pull --rebase ✓");
			else if (pull.stderr.includes("couldn't find remote ref")) actions.push("远端为空（首次推送前），跳过 pull");
			else actions.push(`pull 失败（保留本地）：${pull.stderr.slice(0, 120)}`);
		}
	}
	// commit 身份兜底（新仓无 global user.* 时 commit 必败）
	const who = await g(["config", "user.email"], true);
	if (who.exitCode !== 0 || who.stdout.trim() === "") {
		await g(["config", "user.email", "omo-agent@local"]);
		await g(["config", "user.name", "omo-agent"]);
		actions.push("git identity 兜底（omo-agent@local）");
	}
	await g(["add", "-A"]);
	const status = await g(["status", "--porcelain"]);
	if (status.stdout.trim() !== "") {
		const commit = await g(["commit", "-m", `kb: sync ${new Date().toISOString()}`], true);
		if (commit.exitCode === 0) actions.push("commit ✓");
	}
	if (repo !== undefined && repo !== "") {
		const push = await g(["push", "-u", "origin", branch], true);
		if (push.exitCode === 0) actions.push("push ✓");
		else actions.push(`push 失败（保留本地，稍后重试）：${push.stderr.slice(0, 120)}`);
	}
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
			"沉淀知识条目（write 档，须 Owner 预授权）。处置完事件后调用：存 Runbook/根因/修复步骤。slug 为短横线小写标识（如 'nginx-502-upstream'）。",
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
		name: "ops_kb_sync",
		label: "KB Sync",
		loadMode: "essential",
		approval: approval("ops_kb_sync"),
		description:
			"知识库 git 同步（pull --rebase + commit + push）。全程 best-effort：失败不阻塞本地使用。" +
			"未配置远端 = 本地模式。host 参数仅做格式一致性校验（同步本身只操作知识仓 git，不涉及 ops 目标主机）。",
		parameters: z.object({
			host: z.string().optional().describe("保留参数（同步仅操作知识仓 git，不涉及 ops 目标主机）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			normalizeTargetHost(typeof p.host === "string" ? p.host : undefined);
			const authz = assertAuthorized("ops_kb_sync", { sync: true }, ctx.authzView);
			const { actions } = await gitSync(ctx.kb.kbDir, ctx.kbRepo, ctx.kbBranch, ctx.shell);
			return {
				content: [{ type: "text", text: actions.length > 0 ? actions.join("\n") : "已是最新，无同步动作" }],
				details: { authz, actions },
			};
		},
	});
}
