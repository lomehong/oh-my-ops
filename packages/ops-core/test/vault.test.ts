import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CredentialVault } from "../src/vault.ts";

function tmpDb(): string {
	return path.join(os.tmpdir(), `omo-vault-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

describe("CredentialVault", () => {
	it("首次 unlock 初始化空库 → store/keys/read 往返", () => {
		const db = tmpDb();
		const vault = new CredentialVault(db);
		assert.equal(vault.isUnlocked, false);
		assert.equal(vault.unlock("correct-horse"), true);
		assert.equal(vault.isUnlocked, true);
		vault.store("ssh/prod-db", "SECRET-1");
		assert.deepEqual(vault.keys(), ["ssh/prod-db"]);
		assert.equal(vault.read("ssh/prod-db"), "SECRET-1");
		assert.ok(fs.existsSync(db));
		const mode = fs.statSync(db).mode & 0o777;
		assert.equal(mode, 0o600, "落盘权限须 0600");
		vault.lock();
	});

	it("重开同口令解锁 → 数据持久化；密文不落明文", () => {
		const db = tmpDb();
		const v1 = new CredentialVault(db);
		assert.equal(v1.unlock("pass-1"), true);
		v1.store("token/api", "SECRET-2");
		v1.lock();

		const v2 = new CredentialVault(db);
		assert.equal(v2.isUnlocked, false);
		assert.equal(v2.unlock("pass-1"), true);
		assert.equal(v2.read("token/api"), "SECRET-2");
		const raw = fs.readFileSync(db, "utf8");
		assert.ok(!raw.includes("SECRET-2"), "明文不得出现在落盘文件");
		assert.equal(JSON.parse(raw).kdf, "scrypt");
		v2.lock();
	});

	it("错误口令 unlock → false，且不破坏既有数据", () => {
		const db = tmpDb();
		const v1 = new CredentialVault(db);
		v1.unlock("right");
		v1.store("k", "v");
		v1.lock();

		const v2 = new CredentialVault(db);
		assert.equal(v2.unlock("wrong"), false);
		assert.equal(v2.isUnlocked, false);

		const v3 = new CredentialVault(db);
		assert.equal(v3.unlock("right"), true);
		assert.equal(v3.read("k"), "v");
		v3.lock();
	});

	it("篡改密文 → 解锁失败（GCM 完整性）", () => {
		const db = tmpDb();
		const v1 = new CredentialVault(db);
		v1.unlock("pw");
		v1.store("k", "v");
		v1.lock();

		const raw = JSON.parse(fs.readFileSync(db, "utf8")) as { payload: string };
		const flipped = (BigInt("0x" + raw.payload.slice(0, 16)) ^ 1n).toString(16).padStart(16, "0");
		raw.payload = flipped + raw.payload.slice(16);
		fs.writeFileSync(db, JSON.stringify(raw));

		const v2 = new CredentialVault(db);
		assert.equal(v2.unlock("pw"), false);
	});

	it("lock() 后读写抛 VAULT_LOCKED；remove/keys 正常", () => {
		const db = tmpDb();
		const vault = new CredentialVault(db);
		vault.unlock("pw");
		vault.store("a", "1");
		vault.store("b", "2");
		vault.lock();

		assert.throws(() => vault.read("a"), /VAULT_LOCKED/);
		assert.throws(() => vault.store("c", "3"), /VAULT_LOCKED/);
		assert.throws(() => vault.keys(), /VAULT_LOCKED/);

		vault.unlock("pw");
		assert.deepEqual(vault.keys(), ["a", "b"]);
		assert.equal(vault.remove("a"), true);
		assert.equal(vault.remove("a"), false);
		assert.deepEqual(vault.keys(), ["b"]);
		vault.lock();
	});
});
