import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ensureGitCredentialsFile,
	kbCredentialPath,
	saveKbCredential,
	type KbCredential,
} from "./kb-credential.ts";

/**
 * `omo kb enroll` 的**客户端实现**（OMO-KB-SYNC P3）：向凭据自注册服务兑换一次性码，
 * 把返回的凭据落盘（0600）并自证可用。
 *
 * 契约：docs/designs/omo-kb-sync-credential-design.md §5.6
 *   POST {server}/enroll  {code, device, agent_id?}
 *   200 → {ok, op: enroll|rotate, credential:{repo,username,secret,kind}}  或
 *         {ok, op: "revoke", revoked: true}
 *   401 码无效 / 410 码过期 / 409 码已用 / 403 设备不匹配 / 429 限流 / 500 服务侧失败
 *
 * 纪律：秘密只经本次 HTTPS 响应进入实例（不进 argv、不落日志）；落盘 0600 + 私有 HOME；
 * 兑换码可经 `--code-file`/env 传入，避免出现在命令行。
 */
export interface EnrollOptions {
	/** 服务地址（形如 https://host:8787；末尾斜杠可有可无） */
	server: string;
	/** 一次性兑换码（明文；调用方负责不要在进程列表里暴露） */
	code: string;
	/** 设备名（服务侧用于绑定/命名 bot 账号） */
	device: string;
	agentId?: string;
	/** 仅本机/受信链路允许明文 http（默认拒绝） */
	allowInsecureHttp?: boolean;
	/** 跳过 TLS 校验（自签证书自建服务时使用；默认关闭） */
	allowInsecureTls?: boolean;
	timeoutMs?: number;
}

export interface EnrollResult {
	ok: boolean;
	/** 面向用户的单行结果 */
	message: string;
	/** 成功发放/轮换后的凭据（revoke 时为 undefined） */
	credential?: KbCredential;
	revoked?: boolean;
}

/**
 * 由命令行参数解析 enroll 选项（--server/--code/--code-file/--device + 环境变量兜底）。
 * 兑换码优先序：--code-file（0600，推荐）→ --code → env OMO_KB_ENROLL_CODE。
 */
export async function parseEnrollArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<EnrollOptions> {
	const val = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const server = val("server") ?? env.OMO_KB_SERVER;
	if (server === undefined || server === "") throw new Error("缺少 --server（或环境变量 OMO_KB_SERVER）");
	const codeFile = val("code-file");
	const code = codeFile !== undefined ? await readCodeFile(codeFile) : (val("code") ?? env.OMO_KB_ENROLL_CODE ?? "");
	if (code === "") throw new Error("缺少兑换码：--code-file <0600 文件>（推荐）或 --code / OMO_KB_ENROLL_CODE");
	return {
		server,
		code,
		device: val("device") ?? "",
		agentId: val("agent-id"),
		allowInsecureHttp: argv.includes("--allow-insecure-http"),
		allowInsecureTls: argv.includes("--allow-insecure-tls"),
		timeoutMs: 20_000,
	};
}

/** 读兑换码文件（0600 强制；码本身是秘密，与令牌同级对待） */
export async function readCodeFile(file: string): Promise<string> {
	const st = await fs.stat(file);
	if ((st.mode & 0o077) !== 0) throw new Error(`兑换码文件权限过宽（应 0600）：${file} 当前 ${(st.mode & 0o777).toString(8)}`);
	return (await fs.readFile(file, "utf8")).trim();
}

function failMessageFor(status: number, body: { error?: string }): string {
	switch (status) {
		case 400:
			return `服务拒绝：请求不完整（${body.error ?? "缺参"}）`;
		case 401:
			return "兑换码无效（请确认从 Owner 处拿到的是最新码）";
		case 403:
			return `兑换码与本设备不匹配（${body.error ?? ""}）——请让 Owner 按本机设备名签发`;
		case 409:
			return "兑换码已被使用（一次性码不可重放）——请让 Owner 重新签发";
		case 410:
			return "兑换码已过期——请让 Owner 重新签发";
		case 429:
			return "尝试过于频繁，稍后再试";
		default:
			return `服务侧失败 HTTP ${status}${body.error === undefined ? "" : `：${body.error}`}`;
	}
}

/**
 * 兑换凭据并落盘自证。
 * @param opts 选项（server/code/device）
 * @param omoDir omo 私有域根（凭据落 `$OMO_DIR/kb/credential.json`）
 */
export async function enroll(opts: EnrollOptions, omoDir: string): Promise<EnrollResult> {
	const url = `${opts.server.replace(/\/+$/, "")}/enroll`;
	if (url.startsWith("http://") && opts.allowInsecureHttp !== true) {
		throw new Error("拒绝以明文 HTTP 兑换凭据（会经网络明文传输）：服务请配 TLS，或显式 --allow-insecure-http（仅限受信内网）");
	}
	if (opts.allowInsecureTls === true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: opts.code, device: opts.device, agent_id: opts.agentId }),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
		});
	} catch (err) {
		throw new Error(`无法连接自注册服务（${opts.server}）：${String((err as Error)?.message ?? err)}`);
	}
	let body: { ok?: boolean; op?: string; credential?: KbCredential; revoked?: boolean; error?: string } = {};
	try {
		body = (await res.json()) as typeof body;
	} catch {
		body = {};
	}
	if (!res.ok) throw new Error(failMessageFor(res.status, body));

	if (body.revoked === true) {
		// 吊销：删除本地凭据与 git store 文件（保留本地知识库内容）
		await fs.rm(kbCredentialPath(omoDir), { force: true });
		await fs.rm(path.join(omoDir, "home", ".git-credentials"), { force: true });
		return { ok: true, revoked: true, message: "服务已吊销本机凭据：本地凭据已删除，远端同步停用（本地知识库保留）" };
	}

	const cred = body.credential;
	if (cred === undefined || typeof cred.repo !== "string" || typeof cred.username !== "string" || typeof cred.secret !== "string" || cred.kind !== "password") {
		throw new Error("服务响应缺少合法凭据（repo/username/secret/kind）");
	}
	await saveKbCredential(omoDir, cred);
	await ensureGitCredentialsFile(omoDir, cred);
	return {
		ok: true,
		credential: cred,
		message: `${body.op === "rotate" ? "凭据已轮换" : "凭据已发放"}：${cred.username} @ ${cred.repo}（已落盘 0600${body.op === "rotate" ? "，旧凭据即时失效" : ""}）`,
	};
}
