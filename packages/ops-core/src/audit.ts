import * as fs from "node:fs";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

/** 审计数据面字段（与 hooks/commands 的 appendEntry("ops_audit", …) 形状一致） */
export interface AuditData {
	tool: string;
	ts: string;
	authz: string;
	isError: boolean;
	host?: string;
	toolCallId?: string;
	reasonClass?: string;
	reason?: string;
	[extra: string]: unknown;
}

/** 落盘记录：数据 + 链式完整性字段 */
export interface AuditRecord extends AuditData {
	seq: number;
	/** 前一条记录的 hash；首条为 GENESIS */
	prev: string;
	/** sha256(prev + canonical(data-without-hash)) */
	hash: string;
}

export interface AuditVerifyResult {
	ok: boolean;
	count: number;
	/** 首个断链/损坏的行号（1 起）；ok 时为 undefined */
	brokenAt?: number;
	reason?: string;
}

export const AUDIT_GENESIS = "GENESIS";

/**
 * 独立审计存储（append-only JSONL + 哈希链）。
 * 动机：宿主 `pi.appendEntry` 只写会话；`--no-session`（README 的无人值守标准用法）下会话为
 * 内存态，进程退出即丢——A4「全过程留审计」在最主要的运行形态下不成立。本存储与会话机制解耦：
 * 每条同步追加（进程退出前必落盘），文件 0600、目录 0700；hash 链使事后删改可被 verify 发现。
 * 写失败不抛（审计不得阻断业务），但计入 lastError 供 status 面板暴露。
 */
export class AuditLog {
	readonly path: string;
	#seq = 0;
	#prev = AUDIT_GENESIS;
	#loaded = false;
	lastError: string | undefined;

	constructor(path: string) {
		this.path = path;
	}

	/** 追加一条记录（同步；失败静默记 lastError） */
	append(data: AuditData): AuditRecord | undefined {
		try {
			this.#ensureLoaded();
			const seq = this.#seq + 1;
			const body = { ...data, seq, prev: this.#prev };
			const hash = hashRecord(body);
			const record: AuditRecord = { ...body, hash };
			fs.mkdirSync(nodePath.dirname(this.path), { recursive: true, mode: 0o700 });
			fs.appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			this.#seq = seq;
			this.#prev = hash;
			this.lastError = undefined;
			return record;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}

	/** 读取最近 n 条（按文件顺序，最新在后）；文件缺失 → [] */
	readRecent(n: number): AuditRecord[] {
		const all = readAll(this.path);
		return n >= all.length ? all : all.slice(all.length - n);
	}

	/** 校验哈希链完整性（逐行重算并比对 prev/hash/seq） */
	verify(): AuditVerifyResult {
		let lines: string[];
		try {
			if (!fs.existsSync(this.path)) return { ok: true, count: 0 };
			lines = fs.readFileSync(this.path, "utf8").split("\n").filter((l) => l !== "");
		} catch (error) {
			return { ok: false, count: 0, brokenAt: 0, reason: error instanceof Error ? error.message : String(error) };
		}
		let prev = AUDIT_GENESIS;
		for (let i = 0; i < lines.length; i++) {
			let rec: AuditRecord;
			try {
				rec = JSON.parse(lines[i]!) as AuditRecord;
			} catch {
				return { ok: false, count: i, brokenAt: i + 1, reason: "JSON 解析失败" };
			}
			if (rec.seq !== i + 1) return { ok: false, count: i, brokenAt: i + 1, reason: `seq 不连续（期望 ${i + 1}，得 ${rec.seq}）` };
			if (rec.prev !== prev) return { ok: false, count: i, brokenAt: i + 1, reason: "prev 与上一条 hash 不符" };
			const { hash, ...body } = rec;
			if (hashRecord(body) !== hash) return { ok: false, count: i, brokenAt: i + 1, reason: "hash 不符（内容被改动）" };
			prev = hash;
		}
		return { ok: true, count: lines.length };
	}

	/** 首次写入前读取尾部状态（seq/prev），使跨进程追加保持链连续 */
	#ensureLoaded(): void {
		if (this.#loaded) return;
		const all = readAll(this.path);
		const last = all[all.length - 1];
		if (last !== undefined) {
			this.#seq = last.seq;
			this.#prev = last.hash;
		}
		this.#loaded = true;
	}
}

function readAll(path: string): AuditRecord[] {
	try {
		if (!fs.existsSync(path)) return [];
		const out: AuditRecord[] = [];
		for (const line of fs.readFileSync(path, "utf8").split("\n")) {
			if (line === "") continue;
			try { out.push(JSON.parse(line) as AuditRecord); } catch { /* 损坏行跳过；verify 会报告 */ }
		}
		return out;
	} catch {
		return [];
	}
}

/** 规范化序列化：键按字典序，保证跨进程 hash 稳定 */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const rec = value as Record<string, unknown>;
		const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function hashRecord(body: Record<string, unknown>): string {
	return createHash("sha256").update(canonical(body)).digest("hex");
}
