import { LOCAL_HOST, OpsError } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { CredentialVault } from "@ops-pi/core";
import type { OpsContext } from "../context.ts";

/**
 * P8：write 档工具——ops_file_write / ops_vault_store。
 * write 档须 Owner 预授权（TIER_TABLE: WRITE → needsOwnerAuth 恒真），
 * execute 首行 assertAuthorized（③ 权威复核），全量落审计（tool_execution_end 钩子）。
 *
 * vault 语义（§3.11 + §7.7）：
 *  - 口令仅来自环境变量 OPS_VAULT_PASSPHRASE（session_start 自动解锁，不入配置文件）。
 *  - 未配置 vault / 未解锁 → VAULT_LOCKED 诚实失败，不静默降级。
 *  - ops_vault_store 仅存凭据（key → secret），ops_vault_list 列名不回明文。
 */
export function registerWriteTools(pi: ExtensionAPI, ctx: OpsContext, vault: CredentialVault | undefined, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_file_write",
		label: "File Write",
		loadMode: "essential",
		approval: approval("ops_file_write"),
		description:
			"写入文本文件（write 档，仅本机）。父目录须已存在；mode 可指定八进制权限（如 600）。" +
			"须 Owner 预授权（policy.json 对应 host 规则或批准令牌）。",
		parameters: z.object({
			path: z.string().describe("文件绝对路径"),
			content: z.string().describe("要写入的完整内容（覆盖式）"),
			mode: z.string().optional().describe("八进制权限（如 '600'），缺省 644"),
			host: z.string().optional().describe("目标主机（当前仅支持 '@local'/留空；远程写入未实现）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const pathVal = String(p.path ?? "");
			const content = String(p.content ?? "");
			const hostRaw = typeof p.host === "string" ? p.host.trim() : "";
			const host = normalizeHost(hostRaw);
			if (pathVal === "") throw new Error("[INTERNAL] 缺少 path");

			// ③ 权威复核：host 透传进策略维度（远程写入未实现 → 只允许 @local）
			const authz = assertAuthorized("ops_file_write", { path: pathVal, host: host ?? LOCAL_HOST }, ctx.authzView);

			const modeRaw = typeof p.mode === "string" ? p.mode.trim() : "";
			const mode = /^[0-7]{3,4}$/.test(modeRaw) ? parseInt(modeRaw, 8) : undefined;

			await ctx.files.write(pathVal, content, { mode, signal });
			return {
				content: [{ type: "text", text: `已写入 ${pathVal}（${Buffer.byteLength(content)} 字节）` }],
				details: { authz, path: pathVal, bytes: Buffer.byteLength(content), host: host ?? LOCAL_HOST },
			};
		},
	});

	registerOpsTool(pi, {
		name: "ops_vault_store",
		label: "Vault Store",
		loadMode: "essential",
		approval: approval("ops_vault_store"),
		description:
			"存入凭据到加密 vault（write 档）。须 Owner 预授权 + vault 已解锁（OPS_VAULT_PASSPHRASE）。" +
			"key 为凭据名（如 'ssh/prod-db'），value 为机密内容（落盘为密文）。",
		parameters: z.object({
			key: z.string().describe("凭据名（如 'ssh/prod-db'）"),
			value: z.string().describe("机密内容（将以 AES-256-GCM 密文落盘）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			const key = String(p.key ?? "");
			const value = String(p.value ?? "");
			if (key === "") throw new Error("[INTERNAL] 缺少 key");
			if (vault === undefined) {
				throw new OpsError("VAULT_LOCKED", "vault 未配置：在 .ops-pi/config.json 设置 vault.dbPath 后重试");
			}
			// ③ 权威复核：vault 为控制节点本机能力，host 恒 @local
			const authz = assertAuthorized("ops_vault_store", { key, host: LOCAL_HOST }, ctx.authzView);
			// 惰性解锁：session_start 之外的执行路径（--no-session -p）同样可用
			if (!vault.isUnlocked && process.env.OPS_VAULT_PASSPHRASE) {
				vault.unlock(process.env.OPS_VAULT_PASSPHRASE);
			}
			vault.store(key, value);
			return {
				content: [{ type: "text", text: `已存入凭据 '${key}'（密文落盘，明文不留日志）` }],
				details: { authz, key },
			};
		},
	});
}

function normalizeHost(raw: string): string | undefined {
	const host = raw === "" ? undefined : raw;
	if (host !== undefined && host !== LOCAL_HOST) {
		// 远程写入未实现（P8 范围），诚实约束：file_write 仅本机
		if (host !== "@local") {
			throw new OpsError(
				"POLICY_DENIED",
				`[ERR_POLICY] 远程写入尚未实现：ops_file_write 当前仅支持本机目标（host='${host}'）`,
			);
		}
	}
	return host === LOCAL_HOST ? undefined : host;
}
