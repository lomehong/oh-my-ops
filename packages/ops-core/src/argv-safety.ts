import { OpsError } from "./errors.ts";

/**
 * 执行层参数收口（argv 边界防护）。
 *
 * 动机：ShellExec 以 argv 数组 spawn（不经 shell），但**下游命令仍会自行解析选项**——
 * `systemctl restart --all`、`docker exec --privileged …`、`kubectl logs --kubeconfig=…`
 * 这类「位置参数被当成旗标」的注入，与 shell 注入等价，且能直接扩大破坏范围或改写执行语义。
 *
 * 本模块给出统一的收口手段：
 *  1. assertSafeIdentifier —— 资源标识符白名单（service/container/pod/namespace/kind…）。
 *     这些名字在真实系统里本就受限（systemd unit 名、Docker 容器名、K8s 对象名均不允许
 *     以 `-` 开头、不允许路径分隔符），因此白名单既安全又不产生误报。
 *  2. assertNoFlagLike —— 只要求「不得以 `-` 开头」的轻量档，用于白名单过严的字段。
 *  3. safeRelativePath —— 相对路径校验（compose 文件名等），拒绝绝对路径与 `..` 穿越。
 *
 * 语义：全部抛 OpsError("POLICY_DENIED")，与 normalizeTargetHost 的主机名自防同风格——
 * core 层自防，不依赖扩展层调用纪律（漏一处调用点不应等于开一个洞）。
 */

/** systemd unit 名：字母数字与 _ . - @ （instance 后缀用 @），不含路径分隔符 */
const SERVICE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/;
/** Docker 容器名/ID：字母数字与 _ . - （容器名规范本身即如此） */
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** K8s 对象名（RFC 1123 子域名，小写字母数字与 - .） */
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
/** K8s 命名空间（RFC 1123 label） */
const K8S_NS_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** 相对路径单段：不含分隔符、不含 .. 、不以 - 开头 */
const REL_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export interface IdentifierKind {
	readonly pattern: RegExp;
	/** 展示用字段名（错误信息） */
	readonly label: string;
	/** 合法字符的可读描述（错误信息） */
	readonly charset: string;
}

export const IDENTIFIER_KINDS = {
	systemdUnit: { pattern: SERVICE_RE, label: "服务名", charset: "字母数字与 _ . - @" },
	dockerContainer: { pattern: CONTAINER_RE, label: "容器名", charset: "字母数字与 _ . -" },
	k8sName: { pattern: K8S_NAME_RE, label: "K8s 对象名", charset: "小写字母数字与 - ." },
	k8sNamespace: { pattern: K8S_NS_RE, label: "K8s 命名空间", charset: "小写字母数字与 -" },
} as const satisfies Record<string, IdentifierKind>;

export type IdentifierKindName = keyof typeof IDENTIFIER_KINDS;

/**
 * 资源标识符白名单校验；不通过抛 OpsError("POLICY_DENIED")。
 * 空值放行由调用方判断（空串通常已被 `?? fallback` 处理）。
 */
export function assertSafeIdentifier(kind: IdentifierKindName, value: string): string {
	const { pattern, label, charset } = IDENTIFIER_KINDS[kind];
	if (!pattern.test(value)) {
		throw new OpsError(
			"POLICY_DENIED",
			`[ERR_POLICY] 非法${label}：'${value}'（仅允许 ${charset}）——位置参数以 '-' 开头会被下游解析为选项，等价于绕过授权扩大操作范围`,
		);
	}
	return value;
}

/**
 * 轻量档：仅拒绝「以 `-` 开头」的旗标形态（不做完整白名单）。
 * 用于命名空间等已在上游做过格式约束、但不希望本层重复过严规则的字段。
 */
export function assertNoFlagLike(value: string, label: string): string {
	if (value.startsWith("-")) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法${label}：'${value}'（不得以 '-' 开头，会被下游解析为选项）`);
	}
	return value;
}

/**
 * 相对单段路径校验（compose 文件名等）：拒绝绝对路径、`..` 穿越与分隔符。
 * 用于「必须落在授权目录内」的字段——策略只授权了 projectDir，
 * 文件名若能穿越（`../../etc/x.yml`）即等于把执行权扩到授权域之外。
 */
export function safeRelativePath(value: string, label: string): string {
	if (value.includes("/") || value.includes("\\")) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法${label}：'${value}'（不得含路径分隔符）`);
	}
	if (value === ".." || value.startsWith("../") || value.includes("..")) {
		throw new OpsError("POLICY_DENIED", `[ERR_POLICY] 非法${label}：'${value}'（不得含 '..' 路径穿越）`);
	}
	if (!REL_PATH_RE.test(value)) {
		throw new OpsError(
			"POLICY_DENIED",
			`[ERR_POLICY] 非法${label}：'${value}'（仅允许字母数字与 _ . -，且须以字母数字或 _ 开头）`,
		);
	}
	return value;
}

/**
 * 数值夹取（工具入参的数值字段统一收口）：非有限数 / ≤0 → fallback；超上限截断。
 * 对应审查项 3.5 / 3.7：`docker logs --tail NaN`、`file_read maxBytes=null→1`。
 */
export function clampNumeric(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.max(Math.floor(n), min), max);
}