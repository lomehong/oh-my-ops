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

/** 跨进程锁：轮询间隔与陈旧锁超时（毫秒） */
const LOCK_POLL_MS = 5;
const LOCK_TIMEOUT_MS = 2_000;

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
	/** 最近一次写入失败的原因（成功写入**不清除**——运维需知道链路曾中断，见 append 注释） */
	lastError: string | undefined;
	/** 最近一次写入失败的时间（成功不清除） */
	lastErrorAt: string | undefined;

	constructor(path: string) {
		this.path = path;
	}

	/** 追加一条记录（同步；失败静默记 lastError） */
	append(data: AuditData): AuditRecord | undefined {
		try {
			this.#ensureLoaded();
			// 跨进程互斥：多个 omo 进程（serve + 交互会话 / 定时同步）可能同时追加同一文件。
			// 不加锁时各自的 seq/prev 基于同一基点计算 → 哈希链分叉，verify() 报断链但
			// 成因是并发而非篡改，与安全语义混淆（审查 3.8）。锁失败按 best-effort 继续，
			// 但记录到 lastError 让 /ops-status 可见。
			const release = this.#acquireLock();
			try {
				// 拿到锁后**重新**读取尾部：等锁期间其他进程可能已追加（#loaded 缓存已过期）
				this.#loaded = false;
				this.#ensureLoaded();
				const seq = this.#seq + 1;
				const body = { ...data, seq, prev: this.#prev };
				const hash = hashRecord(body);
				const record: AuditRecord = { ...body, hash };
				fs.mkdirSync(nodePath.dirname(this.path), { recursive: true, mode: 0o700 });
				fs.appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
				this.#seq = seq;
				this.#prev = hash;
				return record;
			} finally {
				release();
			}
		} catch (error) {
			// ★ 失败信息只记不清：清掉会让「曾失败」这个事实消失（审查 3.9 / 4.1）
			//   ——运维需要知道审计链路曾经中断过，而非只看最后一次是否成功。
			this.lastError = error instanceof Error ? error.message : String(error);
			this.lastErrorAt = new Date().toISOString();
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

	/**
	 * 跨进程互斥：`<path>.lock` 以 O_EXCL 原子创建（POSIX/Windows 均为原子操作）。
	 * 拿不到锁则短暂轮询重试；超时（LOCK_TIMEOUT_MS）视为陈旧锁（持有者已崩溃）→ 强拆后自持。
	 * 返回释放函数；获取失败不抛（审计不得阻断业务，调用方 best-effort 继续）。
	 */
	#acquireLock(): () => void {
		const lockPath = `${this.path}.lock`;
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		let warned = false;
		for (;;) {
			try {
				const fd = fs.openSync(lockPath, "wx", 0o600);
				fs.closeSync(fd);
				return () => {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						/* 已释放或被强拆 */
					}
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// EEXIST = 锁被他人持有；其余（EACCES/EROFS 等）= 本进程无法建锁
				if (code !== "EEXIST") {
					if (!warned) {
						this.lastError = `审计文件锁不可用（${String((error as Error).message ?? error)}）——并发追加可能造成链分叉`;
						this.lastErrorAt = new Date().toISOString();
						warned = true;
					}
					return () => {};
				}
				if (Date.now() >= deadline) {
					// 陈旧锁：持有者崩溃遗留，强拆后自持（否则审计永久停写）
					try {
						fs.unlinkSync(lockPath);
					} catch {
						/* 已被他人释放 */
					}
					continue;
				}
				sleepSync(LOCK_POLL_MS);
			}
		}
	}
}

/** 同步短睡（毫秒）：Atomics.wait 在主线程可用，无需 busy-loop 耗 CPU */
function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// 退化：极窄环境不支持 Atomics.wait（不影响正确性，仅退化为忙等）
		const until = Date.now() + ms;
		while (Date.now() < until) {
			/* busy wait */
		}
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
