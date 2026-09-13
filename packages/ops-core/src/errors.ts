/** omo 统一错误：机器可判读 code + 人类可读 message（方案 §7.4 错误处理） */
export type OpsErrorCode =
	| "CONNECTION_REFUSED"
	| "AUTH_FAILED"
	| "TIMEOUT"
	| "EXEC_FAILED"
	| "NOT_FOUND"
	| "PERMISSION_DENIED"
	| "POLICY_DENIED"
	| "VAULT_LOCKED"
	| "VAULT_KEY_EMPTY"
	| "SANDBOX_UNAVAILABLE"
	| "INTERNAL";

export class OpsError extends Error {
	readonly code: OpsErrorCode;
	constructor(code: OpsErrorCode, message: string, options?: { cause?: unknown }) {
		super(`[${code}] ${message}`, options === undefined ? undefined : { cause: options.cause });
		this.name = "OpsError";
		this.code = code;
	}
}
