import * as fs from "node:fs";
import * as nodePath from "node:path";
import { OpsError } from "./errors.ts";

export interface PathGuardRoots {
	/** 机密根：读与写一律拒绝（模型凭据、SSH 私钥、vault 密文、批准令牌…） */
	secret?: readonly string[];
	/** 信任根：写拒绝、读放行（policy.json、config.json、审计文件、扩展/运行时安装域…） */
	trust?: readonly string[];
}

/**
 * 本机路径守卫（L1 纯函数能力，不依赖宿主）。
 * 动机：三层授权模型只回答「能否对目标做动作」，不建模「读什么 / 写哪里」——
 *   · read 档三模式自动放行，但同一进程 HOME 下就有模型 API key、vault 密文、令牌文件、SSH 私钥；
 *   · 拿到 file-write 授权的 Agent 可以改写 policy.json / approval-token.json（信任根），
 *     ReloadableTargetPolicy 热加载后下一次判定即生效——等价于自授权。
 * 本守卫给 ops_file_read/ls/log_tail/log_grep 的读路径与 ops_file_write 的写路径加不变量：
 *   机密根不可读写、信任根不可写。仅约束本机（远程主机文件系统不同，由其 host 规则负责）。
 * 路径按 realpath 归一（存在的最深祖先），防止经符号链接绕行。
 */
export class PathGuard {
	readonly #secret: readonly string[];
	readonly #trust: readonly string[];

	constructor(roots: PathGuardRoots = {}) {
		this.#secret = uniqueRealRoots(roots.secret ?? []);
		this.#trust = uniqueRealRoots(roots.trust ?? []);
	}

	/** 只读视图（供 status 面板/测试） */
	get roots(): { secret: readonly string[]; trust: readonly string[] } {
		return { secret: this.#secret, trust: this.#trust };
	}

	/** 读拒绝原因（命中机密根）；null = 放行 */
	denyRead(path: string): string | null {
		const real = realize(path);
		const hit = this.#secret.find((root) => contains(root, real));
		return hit === undefined ? null : `路径位于机密根（${hit}）——read 档不得读取凭据/密钥/令牌`;
	}

	/**
	 * 递归读拒绝原因（目录树遍历类操作，如 grep -r）：目标位于机密根内 **或** 机密根位于目标之下
	 * （如对 $HOME 或 / 递归 grep 会顺带读到凭据）；null = 放行
	 */
	denyReadTree(path: string): string | null {
		const inside = this.denyRead(path);
		if (inside !== null) return inside;
		const real = realize(path);
		const hit = this.#secret.find((root) => contains(real, root));
		return hit === undefined ? null : `递归读取范围覆盖机密根（${hit}）——请缩小到具体日志目录`;
	}

	/** 写拒绝原因（命中机密根或信任根）；null = 放行 */
	denyWrite(path: string): string | null {
		const real = realize(path);
		const secret = this.#secret.find((root) => contains(root, real));
		if (secret !== undefined) return `路径位于机密根（${secret}）——禁止写入`;
		const trust = this.#trust.find((root) => contains(root, real));
		if (trust !== undefined) return `路径位于信任根（${trust}）——Agent 不得改写自身策略/令牌/配置/安装域`;
		return null;
	}

	/** @throws OpsError("POLICY_DENIED") */
	assertReadable(path: string): void {
		const reason = this.denyRead(path);
		if (reason !== null) throw new OpsError("POLICY_DENIED", `${reason}：${path}`);
	}

	/** @throws OpsError("POLICY_DENIED") */
	assertTreeReadable(path: string): void {
		const reason = this.denyReadTree(path);
		if (reason !== null) throw new OpsError("POLICY_DENIED", `${reason}：${path}`);
	}

	/** @throws OpsError("POLICY_DENIED") */
	assertWritable(path: string): void {
		const reason = this.denyWrite(path);
		if (reason !== null) throw new OpsError("POLICY_DENIED", `${reason}：${path}`);
	}
}

/** root 包含 target（含相等）；两侧均已归一化 */
function contains(root: string, target: string): boolean {
	const rel = nodePath.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/** 归一化：绝对化 + 存在的最深祖先取 realpath（尾段可尚不存在，如待创建的文件） */
export function realize(path: string): string {
	const abs = nodePath.resolve(path);
	let cursor = abs;
	let tail = "";
	for (;;) {
		try {
			const real = fs.realpathSync(cursor);
			return tail === "" ? real : nodePath.join(real, tail);
		} catch {
			const parent = nodePath.dirname(cursor);
			if (parent === cursor) return abs;
			tail = tail === "" ? nodePath.basename(cursor) : nodePath.join(nodePath.basename(cursor), tail);
			cursor = parent;
		}
	}
}

function uniqueRealRoots(roots: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of roots) {
		if (typeof raw !== "string" || raw.trim() === "") continue;
		const real = realize(raw);
		if (!out.includes(real)) out.push(real);
	}
	return out;
}
