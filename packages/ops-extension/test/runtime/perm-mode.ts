/**
 * perm-mode.ts —— 测试侧「秘密文件 0600」断言辅助（CIPORT-1）
 *
 * POSIX 上 0600 是硬要求；但 Windows/Git Bash 的文件系统**无法表达** 0600（写入 mode 0o600 后
 * stat 仍返回 0o666）⇒ 断言按**能力分级**：可表达 ⇒ 严格等值；不可表达 ⇒ 降级为存在性检查，
 * 并在首次降级时打印一行告知（绝不静默）。策略与 scripts/lib/secret-perm.mjs 一致。
 */
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cached: boolean | undefined;

export function canExpress0600(): boolean {
	if (cached !== undefined) return cached;
	let dir: string | undefined;
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

let degraded = 0;
let announced = false;

function announceDegraded(): void {
	if (announced) return;
	announced = true;
	console.log("  ⚠ 本文件系统无法表达 0600（Windows/Git Bash 已知短板）：0600 断言降级为存在性检查（POSIX 上仍严格）");
}

/** 断言文件为 0600（不可表达时降级为「存在」）。返回实际 mode 便于调用方附加断言。 */
export function expectSecret0600(file: string): number {
	const mode = fs.statSync(file).mode & 0o777;
	if (canExpress0600()) {
		expect(mode).toBe(0o600);
		return mode;
	}
	degraded++;
	announceDegraded();
	expect(fs.existsSync(file)).toBe(true);
	return mode;
}
