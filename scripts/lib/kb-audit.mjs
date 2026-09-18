/**
 * kb-audit.mjs —— 零依赖审计链（append-only JSONL + sha256 链），供**已安装的 kb-enroll 服务**使用。
 *
 * 与 `packages/ops-core/src/audit.ts`（宿主侧 AuditLog）**同一算法**，互不导入：
 *   canonical(value)：数组/对象按键字典序、丢弃 undefined；hash = sha256(canonical({...data, seq, prev}))。
 *   ⇒ 同一批记录经两者追加，产出**逐字节相同**的文件（由 packages/ops-extension/test/kb-audit-parity.test.ts 守卫）。
 *
 * 为什么不在服务里直接 import @ops-pi/core：服务被安装到私有域 `~/.omo-kb/service/`，
 * 那里没有 monorepo 的 node_modules —— 真机装完 `Cannot find module '@ops-pi/core'`，服务起不来。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const AUDIT_GENESIS = "GENESIS";

/** 规范化序列化：键按字典序，保证跨进程/跨实现 hash 稳定 */
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const rec = value;
		const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function hashRecord(body) {
	return createHash("sha256").update(canonical(body)).digest("hex");
}

export class AuditLog {
	#seq = 0;
	#prev = AUDIT_GENESIS;
	#loaded = false;

	constructor(file) {
		this.path = file;
		this.lastError = undefined;
	}

	#ensureLoaded() {
		if (this.#loaded) return;
		this.#loaded = true;
		try {
			const text = fs.readFileSync(this.path, "utf8");
			const lines = text.split("\n").filter((l) => l.trim() !== "");
			const last = lines[lines.length - 1];
			if (last !== undefined) {
				const rec = JSON.parse(last);
				if (typeof rec.seq === "number" && typeof rec.hash === "string") {
					this.#seq = rec.seq;
					this.#prev = rec.hash;
				}
			}
		} catch {
			// 文件不存在/不可读：保持初始链（GENESIS）
		}
	}

	/** 追加一条（同步落盘；失败不抛，记 lastError —— 审计不得阻断业务） */
	append(data) {
		try {
			this.#ensureLoaded();
			const seq = this.#seq + 1;
			const body = { ...data, seq, prev: this.#prev };
			const record = { ...body, hash: hashRecord(body) };
			fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
			fs.appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			this.#seq = seq;
			this.#prev = record.hash;
			return record;
		} catch (err) {
			this.lastError = String(err?.message ?? err);
			return undefined;
		}
	}

	/** 校验链完整（返回首个断链行号，1 起；ok 时 undefined） */
	verify() {
		try {
			const lines = fs.readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim() !== "");
			let prev = AUDIT_GENESIS;
			for (let i = 0; i < lines.length; i++) {
				const rec = JSON.parse(lines[i]);
				const { hash, ...body } = rec;
				if (body.prev !== prev) return { ok: false, count: lines.length, brokenAt: i + 1, reason: "prev 链断裂" };
				if (hashRecord(body) !== hash) return { ok: false, count: lines.length, brokenAt: i + 1, reason: "记录被篡改" };
				prev = hash;
			}
			return { ok: true, count: lines.length };
		} catch (err) {
			return { ok: false, count: 0, reason: String(err?.message ?? err) };
		}
	}
}
