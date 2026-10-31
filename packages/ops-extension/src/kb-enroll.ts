import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
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
	/** install-remote.sh 用：服务端 /install/enroll 的 JSON 响应（已由受 pin 保护的 curl 取得） */
	responseFile?: string;
	/** 安装令牌模式：端点为 /install/enroll，Bearer 鉴权 */
	installToken?: string;
	endpoint?: string;
	bearer?: string;
	/** 可选 CA PEM（直接模式；也可用 NODE_EXTRA_CA_CERTS） */
	caFile?: string;
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
 * 安装态（控制面来源）：用于 `omo kb status --report` 上报实例最近状态。
 * 不含任何凭据秘密；reportToken 是**实例上报令牌**（安装时一次性下发，服务端只存哈希）。
 */
export interface KbInstallState {
	controlPlane: string;
	installId: string;
	version?: string;
	reportToken?: string;
	/** 自签 CA PEM 路径（安装时保存；上报时作为信任锚） */
	caFile?: string;
	enrolledAt: string;
}

export function kbInstallStatePath(omoDir: string): string {
	return path.join(omoDir, "kb", "install.json");
}

export async function loadKbInstallState(omoDir: string): Promise<KbInstallState | undefined> {
	try {
		const raw = JSON.parse(await fs.readFile(kbInstallStatePath(omoDir), "utf8")) as Partial<KbInstallState>;
		if (typeof raw.controlPlane !== "string" || typeof raw.installId !== "string") return undefined;
		return {
			controlPlane: raw.controlPlane,
			installId: raw.installId,
			version: raw.version,
			reportToken: raw.reportToken,
			caFile: raw.caFile,
			enrolledAt: raw.enrolledAt ?? new Date().toISOString(),
		};
	} catch {
		return undefined;
	}
}

export async function saveKbInstallState(omoDir: string, state: KbInstallState): Promise<string> {
	const dir = path.join(omoDir, "kb");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = kbInstallStatePath(omoDir);
	await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	return file;
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
	const installTokenFile = val("install-token-file");
	if (installTokenFile !== undefined) {
		if (server === undefined || server === "") throw new Error("--install-token-file 需要 --server");
		const installToken = await readCodeFile(installTokenFile);
		return {
			server,
			code: "",
			device: val("device") ?? "",
			agentId: val("agent-id"),
			installToken,
			endpoint: "/install/enroll",
			bearer: installToken,
			caFile: val("ca-file"),
			allowInsecureHttp: argv.includes("--allow-insecure-http"),
			allowInsecureTls: argv.includes("--allow-insecure-tls"),
			timeoutMs: 20_000,
		};
	}
	const responseFile = val("response-file");
	if (responseFile !== undefined) {
		if (server === undefined || server === "") throw new Error("--response-file 仍需要 --server（用于校验响应来源展示）");
		return {
			server,
			code: "",
			device: val("device") ?? "",
			agentId: val("agent-id"),
			responseFile,
			allowInsecureHttp: argv.includes("--allow-insecure-http"),
			allowInsecureTls: argv.includes("--allow-insecure-tls"),
			timeoutMs: 20_000,
		};
	}
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
let permProbeCache: boolean | undefined;
/** 本文件系统能否表达 0600（Windows/Git Bash 不能；与 scripts/lib/secret-perm.mjs 同策略） */
async function canExpress0600(): Promise<boolean> {
	if (permProbeCache !== undefined) return permProbeCache;
	let dir: string | undefined;
	try {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omo-perm-"));
		const f = path.join(dir, "f");
		await fs.writeFile(f, "x", { mode: 0o600 });
		await fs.chmod(f, 0o600);
		const m = (await fs.stat(f)).mode & 0o777;
		permProbeCache = m === 0o600 || m === 0o400;
	} catch {
		permProbeCache = false;
	} finally {
		if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	return permProbeCache;
}

let permWarned = false;

export async function readCodeFile(file: string): Promise<string> {
	const st = await fs.stat(file);
	if ((st.mode & 0o077) !== 0) {
		if (await canExpress0600()) {
			throw new Error(`兑换码文件权限过宽（应 0600）：${file} 当前 ${(st.mode & 0o777).toString(8)}`);
		}
		if (!permWarned) {
			permWarned = true;
			process.stderr.write(`  ⚠ 本文件系统无法表达 0600（Windows/Git Bash 已知短板）：兑换码文件 ${file} 实际权限不受约束\n`);
			process.stderr.write(`  ⚠ 已降级放行；POSIX 主机上同一检查仍会硬拦。请确保该文件所在目录仅本账号可读。\n`);
		}
	}
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
 * 带显式 CA 的 JSON POST（node:https/http 实现）。
 * 不用 NODE_EXTRA_CA_CERTS 的原因：该变量只在进程启动时生效，运行时设置不保证被 fetch 采用
 * （真机上表现为「CA 明明存在却仍验证失败」）。这里把 CA 直接绑到本次连接。
 */
function postJsonWithTrust(
	url: string,
	bodyText: string,
	headers: Record<string, string>,
	opts: { caPem?: string; rejectUnauthorized?: boolean; timeoutMs?: number } = {},
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const secure = u.protocol === "https:";
		const mod = secure ? https : http;
		const req = mod.request(
			{
				protocol: u.protocol,
				hostname: u.hostname,
				port: u.port === "" ? (secure ? 443 : 80) : Number(u.port),
				path: `${u.pathname}${u.search}`,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyText), ...headers },
				...(secure ? { ca: opts.caPem, rejectUnauthorized: opts.rejectUnauthorized !== false } : {}),
				timeout: opts.timeoutMs ?? 20_000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("timeout", () => req.destroy(new Error(`请求超时（${opts.timeoutMs ?? 20_000}ms）`)));
		req.on("error", reject);
		req.end(bodyText);
	});
}

/**
 * 实例状态上报（`omo kb status --report`）：不引入常驻心跳，只在人工/运维动作时推一次最近状态。
 * 认证用安装时下发的实例上报令牌（Bearer）；服务端按哈希校验，吊销即失效。
 */
export interface ReportStatusResult {
	ok: boolean;
	status: number;
	message: string;
}

export async function reportInstallStatus(
	install: KbInstallState,
	payload: { device: string; ok: boolean; lastSync?: string; reason?: string; version?: string; configRevision?: string; appliedRevision?: string },
	opts: { allowInsecureHttp?: boolean; allowInsecureTls?: boolean; caFile?: string; timeoutMs?: number } = {},
): Promise<ReportStatusResult> {
	if (install.reportToken === undefined || install.reportToken === "") {
		return { ok: false, status: 0, message: "本机没有实例上报令牌（需经控制面安装/接入一次）" };
	}
	const base = install.controlPlane.replace(/\/+$/, "");
	const url = `${base}/install/report`;
	if (base.startsWith("http://") && opts.allowInsecureHttp !== true) {
		return { ok: false, status: 0, message: "拒绝以明文 HTTP 上报：控制面请配 TLS，或显式 --allow-insecure-http（仅限受信内网）" };
	}
	const caFile = opts.caFile ?? install.caFile;
	const caPem = caFile === undefined ? undefined : await fs.readFile(caFile, "utf8").catch(() => undefined);
	if (caFile !== undefined && caPem === undefined) {
		return { ok: false, status: 0, message: `CA 文件不可读：${caFile}（可用 --ca-file 指定）` };
	}
	let res: { status: number; text: string };
	try {
		res = await postJsonWithTrust(
			url,
			JSON.stringify({
				stage: "status",
				device: payload.device,
				ok: payload.ok,
				...(payload.lastSync === undefined ? {} : { lastSync: payload.lastSync }),
				...(payload.reason === undefined ? {} : { reason: payload.reason }),
				...(payload.version === undefined ? {} : { version: payload.version }),
				...(payload.configRevision === undefined ? {} : { configRevision: payload.configRevision }),
				...(payload.appliedRevision === undefined ? {} : { appliedRevision: payload.appliedRevision }),
			}),
			{ Authorization: `Bearer ${install.reportToken}` },
			{ caPem, rejectUnauthorized: opts.allowInsecureTls !== true, timeoutMs: opts.timeoutMs ?? 15_000 },
		);
	} catch (err) {
		return { ok: false, status: 0, message: `无法连接控制面（${base}）：${String((err as Error)?.message ?? err)}` };
	}
	let body: { error?: string } = {};
	try {
		body = JSON.parse(res.text) as typeof body;
	} catch {
		// 非 JSON 应答按状态码处理
	}
	if (res.status < 200 || res.status >= 300) {
		const hint = res.status === 401 || res.status === 403 ? "上报令牌无效/已吊销" : res.status === 409 ? "该实例已撤销上报" : body.error ?? "服务侧失败";
		return { ok: false, status: res.status, message: hint };
	}
	return { ok: true, status: res.status, message: `已上报实例状态（installId=${install.installId}）` };
}

/**
 * 兑换凭据并落盘自证。
 * @param opts 选项（server/code/device）
 * @param omoDir omo 私有域根（凭据落 `$OMO_DIR/kb/credential.json`）
 */
export async function enroll(opts: EnrollOptions, omoDir: string): Promise<EnrollResult> {
	const url = `${opts.server.replace(/\/+$/, "")}${opts.endpoint ?? "/enroll"}`;
	let body: { ok?: boolean; op?: string; credential?: KbCredential; revoked?: boolean; error?: string; installId?: string; control_plane?: string; report_token?: string; version?: string } = {};

	if (opts.responseFile !== undefined) {
		// install-remote.sh 路径：响应已由受 cacert+pin 保护的 curl 取得；这里只做落盘，不再发网络请求。
		let text: string;
		try {
			text = await fs.readFile(opts.responseFile, "utf8");
		} catch (err) {
			throw new Error(`安装响应不可读（${opts.responseFile}）：${String((err as Error)?.message ?? err)}`);
		}
		try {
			body = JSON.parse(text) as typeof body;
		} catch {
			throw new Error(`安装响应不是合法 JSON：${opts.responseFile}`);
		}
	} else {
		if (url.startsWith("http://") && opts.allowInsecureHttp !== true) {
			throw new Error("拒绝以明文 HTTP 兑换凭据（会经网络明文传输）：服务请配 TLS，或显式 --allow-insecure-http（仅限受信内网）");
		}
		// CA 与「跳过校验」都绑定到本次连接（node:https），不污染进程级 TLS 开关。
		const caPem = opts.caFile === undefined ? undefined : await fs.readFile(opts.caFile, "utf8").catch(() => undefined);
		if (opts.caFile !== undefined && caPem === undefined) throw new Error(`CA 文件不可读：${opts.caFile}`);
		let res: { status: number; text: string };
		try {
			res = await postJsonWithTrust(
				url,
				JSON.stringify(opts.installToken === undefined ? { code: opts.code, device: opts.device, agent_id: opts.agentId } : { device: opts.device, agent_id: opts.agentId }),
				{ ...(opts.bearer === undefined ? {} : { Authorization: `Bearer ${opts.bearer}` }) },
				{ caPem, rejectUnauthorized: opts.allowInsecureTls !== true, timeoutMs: opts.timeoutMs ?? 20_000 },
			);
		} catch (err) {
			throw new Error(`无法连接自注册服务（${opts.server}）：${String((err as Error)?.message ?? err)}`);
		}
		try {
			body = JSON.parse(res.text) as typeof body;
		} catch {
			body = {};
		}
		if (res.status < 200 || res.status >= 300) throw new Error(failMessageFor(res.status, body));
	}

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
	if (typeof body.report_token === "string" && typeof body.control_plane === "string" && typeof body.installId === "string") {
		await saveKbInstallState(omoDir, {
			controlPlane: body.control_plane,
			installId: body.installId,
			version: body.version,
			reportToken: body.report_token,
			caFile: opts.caFile ?? process.env.OMO_KB_CA_FILE,
			enrolledAt: new Date().toISOString(),
		});
	}
	return {
		ok: true,
		credential: cred,
		message: `${body.op === "rotate" ? "凭据已轮换" : "凭据已发放"}：${cred.username} @ ${cred.repo}（已落盘 0600${body.op === "rotate" ? "，旧凭据即时失效" : ""}）`,
	};
}
