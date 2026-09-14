import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { OpsError } from "./errors.ts";

const KDF_SALT_BYTES = 16;
const KDF_KEYLEN = 32;
const KDF_N = 16384; // scrypt 成本参数（Node 默认 r=8, p=1）

/** 落盘文件结构（0600）。payload 为 AES-256-GCM 密文（entries JSON）。 */
interface VaultFile {
	v: 1;
	kdf: "scrypt";
	salt: string; // hex
	iv: string; // hex
	tag: string; // hex
	payload: string; // hex
}

interface VaultEntries {
	[key: string]: { value: string; createdAt: string; updatedAt: string };
}

/**
 * CredentialVault —— 凭据加密存储（§3.11）。
 *
 * 语义：
 *  - unlock(passphrase)：用口令派生密钥解密既有文件；文件不存在则以该口令初始化空库。
 *    错误口令对既有文件 → GCM 认证失败 → false（不抛、不落盘）。
 *  - store/read/remove/keys 仅在解锁态可用；lock() 清除内存密钥与条目。
 *  - 每次变更即原子落盘（tmp+rename，0600）。
 *  - 口令来源：环境变量 OPS_VAULT_PASSPHRASE（§7.7，不入配置文件）。
 */
export class CredentialVault {
	private readonly dbPath: string;
	private entries: VaultEntries | undefined;
	private key: Buffer | undefined;
	private salt: Buffer | undefined;
	private unlocked = false;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	get isUnlocked(): boolean {
		return this.unlocked;
	}

	get path(): string {
		return this.dbPath;
	}

	/** 解锁：返回 true=成功（含首次初始化）。错误口令对既有库 → false。 */
	unlock(passphrase: string): boolean {
		if (passphrase === "") return false;
		let file: VaultFile | undefined;
		if (fs.existsSync(this.dbPath)) {
			try {
				file = JSON.parse(fs.readFileSync(this.dbPath, "utf8")) as VaultFile;
			} catch {
				return false; // 文件损坏，无法用该口令验证
			}
			if (file.kdf !== "scrypt" || typeof file.salt !== "string") return false;
		}
		const salt = file ? Buffer.from(file.salt, "hex") : randomBytes(KDF_SALT_BYTES);
		const key = scryptSync(passphrase, salt, KDF_KEYLEN, { N: KDF_N });
		this.salt = salt;

		if (file) {
			try {
				const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
				decipher.setAuthTag(Buffer.from(file.tag, "hex"));
				const plain = Buffer.concat([decipher.update(Buffer.from(file.payload, "hex")), decipher.final()]).toString("utf8");
				this.entries = JSON.parse(plain) as VaultEntries;
			} catch {
				return false; // 口令错误或文件被篡改
			}
		} else {
			this.entries = {};
		}
		this.key = key;
		this.unlocked = true;
		return true;
	}

	/** 锁定：清除内存密钥与条目（落盘文件保留，可再次解锁） */
	lock(): void {
		this.entries = undefined;
		this.key = undefined;
		this.unlocked = false;
	}

	/**
	 * 口令轮换（re-key，P14）：解锁态下以新口令 + 新盐重派生密钥并原子落盘。
	 * 返回 true=成功；空口令或落盘失败 → false（内存密钥回滚，旧口令继续有效）。
	 * 备份语义：落盘文件自始至终是 AES-256-GCM 密文——锁态下整文件拷贝即备份，恢复=放回原路径。
	 */
	rekey(newPassphrase: string): boolean {
		this.assertUnlocked();
		if (newPassphrase === "") return false;
		const oldKey = this.key;
		const oldSalt = this.salt;
		const salt = randomBytes(KDF_SALT_BYTES);
		this.key = scryptSync(newPassphrase, salt, KDF_KEYLEN, { N: KDF_N });
		this.salt = salt;
		try {
			this.persist();
			return true;
		} catch {
			this.key = oldKey;
			this.salt = oldSalt;
			return false;
		}
	}

	private assertUnlocked(): void {
		if (!this.unlocked || !this.entries || !this.key) {
			throw new OpsError("VAULT_LOCKED", "vault 未解锁：设置 OPS_VAULT_PASSPHRASE 后重试");
		}
	}

	/** 存入凭据（同 key 覆盖并保留 createdAt） */
	store(key: string, value: string): void {
		this.assertUnlocked();
		if (key === "") throw new OpsError("VAULT_KEY_EMPTY", "vault key 不能为空");
		const now = new Date().toISOString();
		const prev = this.entries![key];
		this.entries![key] = { value, createdAt: prev?.createdAt ?? now, updatedAt: now };
		this.persist();
	}

	/** 读取凭据明文；不存在 → undefined */
	read(key: string): string | undefined {
		this.assertUnlocked();
		return this.entries![key]?.value;
	}

	/** 删除凭据；返回是否存在 */
	remove(key: string): boolean {
		this.assertUnlocked();
		if (this.entries![key] === undefined) return false;
		delete this.entries![key];
		this.persist();
		return true;
	}

	/** 凭据名清单（不含明文） */
	keys(): string[] {
		this.assertUnlocked();
		return Object.keys(this.entries!).sort();
	}

	/** 原子落盘（tmp + rename，0600） */
	private persist(): void {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
		const payload = Buffer.concat([cipher.update(JSON.stringify(this.entries!), "utf8"), cipher.final()]);
		const salt = this.salt ?? randomBytes(KDF_SALT_BYTES);
		const file: VaultFile = {
			v: 1,
			kdf: "scrypt",
			salt: salt.toString("hex"),
			iv: iv.toString("hex"),
			tag: cipher.getAuthTag().toString("hex"),
			payload: payload.toString("hex"),
		};
		const tmp = `${this.dbPath}.tmp.${process.pid}`;
		fs.mkdirSync(nodePath.dirname(this.dbPath), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
		fs.renameSync(tmp, this.dbPath);
	}

}
