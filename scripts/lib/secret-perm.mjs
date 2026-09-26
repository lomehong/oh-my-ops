/**
 * secret-perm.mjs —— 「秘密文件权限」能力探测与断言（供给 CLI / enroll 服务共用）
 *
 * 背景：POSIX 上 0600 是硬要求；但 Windows/Git Bash 的文件系统**无法表达** 0600
 * （Node 以 mode 0o600 写文件，stat 仍返回 666；bash `chmod 600` 得到 644）⇒ 在无法表达的
 * 平台上「硬拦」等于把整条工具链锁死。策略（CIPORT-1）：
 *   - 能力探测在**运行时实测**（临时文件 chmod 600 → stat），不看平台名；
 *   - 能表达 ⇒ 权限过宽即抛（POSIX 严格性完全保留）；
 *   - 不能表达 ⇒ stderr **大声一次性警告**后放行（绝不静默降级）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cached;
export function canExpress0600() {
	if (cached !== undefined) return cached;
	let dir;
	try {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-perm-"));
		const f = path.join(dir, "f");
		fs.writeFileSync(f, "x", { mode: 0o600 });
		fs.chmodSync(f, 0o600);
		const m = fs.statSync(f).mode & 0o777;
		cached = m === 0o600 || m === 0o400;
	} catch {
		cached = false;
	} finally {
		if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
	}
	return cached;
}

let warned = false;
export function warnPermUnsupported(file, what) {
	if (warned) return;
	warned = true;
	process.stderr.write(`  ⚠ 本文件系统无法表达 0600（Windows/Git Bash 已知短板）：${what}文件 ${file} 实际权限不受约束\n`);
	process.stderr.write(`  ⚠ 已降级放行；POSIX 主机上同一检查仍会硬拦。请确保该文件所在目录仅本账号可读。\n`);
}

export function assertSecretFilePerm(file, what = "秘密") {
	const st = fs.statSync(file);
	if ((st.mode & 0o077) === 0) return;
	if (!canExpress0600()) {
		warnPermUnsupported(file, what);
		return;
	}
	throw new Error(`${what}文件权限过宽（应 0600）：${file} 当前 ${(st.mode & 0o777).toString(8)}`);
}
