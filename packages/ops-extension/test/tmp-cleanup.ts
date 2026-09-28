import * as fs from "node:fs";

/**
 * 测试临时目录清理（Windows EBUSY 兜底，CIPORT 同主题）：
 * git 刚写完的对象/打包文件会被 Defender/索引器短暂持锁，紧随其后的 rmSync 抛 EBUSY ——
 * 失败的是 finally 清理而非断言，却把通过用例标红。这里小步重试；仍失败则放弃
 * （残留 %TEMP% 目录无害，OS 会清），绝不让清理失败推翻已通过的测试。
 */
export function rmTempSync(target: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(target, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (attempt < 8 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
				continue;
			}
			return; // 放弃清理：测试已跑完，临时目录残留无害
		}
	}
}
