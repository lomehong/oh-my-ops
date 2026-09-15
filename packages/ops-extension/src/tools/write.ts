import { LOCAL_HOST, OpsError, normalizeTargetHost } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { CredentialVault } from "@ops-pi/core";
import type { OpsContext } from "../context.ts";

/**
 * P8/P13/P14：write 档工具——ops_file_write / ops_vault_store / ops_vault_rekey。
 * write 档须 Owner 预授权（TIER_TABLE: WRITE → needsOwnerAuth 恒真），
 * execute 首行 assertAuthorized（③ 权威复核），全量落审计（tool_execution_end 钩子）。
 *
 * vault 语义（§3.11 + §7.7）：
 *  - 口令仅来自环境变量 OPS_VAULT_PASSPHRASE（session_start 自动解锁，不入配置文件）。
 *  - 未配置 vault / 未解锁 → VAULT_LOCKED 诚实失败，不静默降级。
 *  - ops_vault_store 仅存凭据（key → secret），ops_vault_list 列名不回明文。
 *  - P14：ops_vault_rekey 轮换口令（新盐重加密原子落盘）；备份 = 锁态整文件拷贝（密文）。
 */
export function registerWriteTools(pi: ExtensionAPI, ctx: OpsContext, vault: CredentialVault | undefined, approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;

	registerOpsTool(pi, {
		name: "ops_file_write",
		label: "File Write",
		loadMode: "essential",
		approval: approval("ops_file_write"),
		description:
			"写入文本文件（write 档；支持远程主机经 SshPool）。父目录须已存在；mode 可指定八进制权限（如 600）。" +
			"须 Owner 预授权：policy.json 对应 host 规则的 actions 须显式包含 'file-write'（远程主机填真实 hostname 规则），或批准令牌。" +
			"本机信任根（policy.json / approval-token.json / config / 审计文件 / omo 安装域）与机密根一律拒写。",
		parameters: z.object({
			path: z.string().describe("文件绝对路径"),
			content: z.string().describe("要写入的完整内容（覆盖式）"),
			mode: z.string().optional().describe("八进制权限（如 '600'），缺省 644"),
			host: z.string().optional().describe("目标主机（留空 = 本机；远程须 policy 预授权 + SSH 密钥可达）"),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as Record<string, unknown>;
			const pathVal = String(p.path ?? "");
			const content = String(p.content ?? "");
			const hostRaw = typeof p.host === "string" ? p.host.trim() : "";
			// P13：远程写入经 SshPool（非法主机名由 normalizeTargetHost 即拒）
			const host = hostRaw === "" || hostRaw === LOCAL_HOST ? undefined : normalizeTargetHost(hostRaw);
			if (pathVal === "") throw new Error("[INTERNAL] 缺少 path");

			// ③ 权威复核：host 透传进策略维度（action='file-write'，P11 显式授权）
			const authz = assertAuthorized("ops_file_write", { path: pathVal, host: host ?? LOCAL_HOST }, ctx.authzView);
			// 信任根/机密根不可写（仅本机）：file-write 授权不得用于改写 policy/token/config/审计/安装域——否则等价于自授权
			if (host === undefined) ctx.pathGuard.assertWritable(pathVal);

			const modeRaw = typeof p.mode === "string" ? p.mode.trim() : "";
			const mode = /^[0-7]{3,4}$/.test(modeRaw) ? parseInt(modeRaw, 8) : undefined;

			const ops = ctx.forHost(host);
			await ops.files.write(pathVal, content, { mode, signal });
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
			"存入凭据到加密 vault（write 档）。须 Owner 预授权（policy.json 规则的 actions 须显式包含 'vault-write'，" +
			"或批准令牌）+ vault 已解锁（OPS_VAULT_PASSPHRASE）。" +
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

	registerOpsTool(pi, {
		name: "ops_vault_rekey",
		label: "Vault Rekey",
		loadMode: "essential",
		approval: approval("ops_vault_rekey"),
		description:
			"轮换 vault 口令（re-key，write 档，P14）：以新口令+新盐重加密现有凭据并原子落盘，旧口令随即失效。" +
			"须 vault 已解锁（OPS_VAULT_PASSPHRASE）+ Owner 预授权（policy.json 规则 actions 显式包含 'vault-rekey'，或批准令牌）。" +
			"备份建议：轮换前锁态整文件拷贝 vault db（密文，可用旧口令解锁恢复）。",
		parameters: z.object({
			newPassphrase: z.string().describe("新口令（派生新密钥；空口令拒绝）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			const newPassphrase = String(p.newPassphrase ?? "");
			if (newPassphrase === "") throw new OpsError("VAULT_KEY_EMPTY", "新口令不能为空");
			if (vault === undefined) {
				throw new OpsError("VAULT_LOCKED", "vault 未配置：在 .ops-pi/config.json 设置 vault.dbPath 后重试");
			}
			// ③ 权威复核：vault 为控制节点本机能力，host 恒 @local（action='vault-rekey'）
			const authz = assertAuthorized("ops_vault_rekey", { host: LOCAL_HOST }, ctx.authzView);
			// 惰性解锁（与 ops_vault_store 同路径）
			if (!vault.isUnlocked && process.env.OPS_VAULT_PASSPHRASE) {
				vault.unlock(process.env.OPS_VAULT_PASSPHRASE);
			}
			if (!vault.rekey(newPassphrase)) {
				throw new OpsError("VAULT_LOCKED", "口令轮换失败：vault 未解锁或落盘失败（旧口令仍有效）");
			}
			return {
				content: [{ type: "text", text: "vault 口令已轮换（新盐重加密原子落盘，旧口令失效；建议立即更新 OPS_VAULT_PASSPHRASE 并整文件备份）" }],
				details: { authz, op: "vault-rekey" },
			};
		},
	});
}
