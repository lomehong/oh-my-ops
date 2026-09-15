import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PathGuard, realize } from "../src/path-guard.ts";

function sandbox(): { base: string; omo: string; home: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-pg-"));
	const omo = path.join(base, ".omo");
	const home = path.join(omo, "home");
	fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
	fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
	fs.writeFileSync(path.join(omo, "policy.json"), "{}");
	fs.writeFileSync(path.join(omo, "approval-token.json"), "{}");
	fs.writeFileSync(path.join(home, ".omp", "auth.json"), "{\"key\":\"sk-…\"}");
	fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE");
	return { base, omo, home };
}

const includes = (actual: string | null, needle: string) => assert.ok(actual?.includes(needle), `期望包含「${needle}」，实际：${actual}`);

function guardFor(s: ReturnType<typeof sandbox>): PathGuard {
	return new PathGuard({
		secret: [path.join(s.omo, "approval-token.json"), path.join(s.omo, "vault.db"), path.join(s.home, ".omp"), path.join(s.home, ".ssh"), s.home],
		trust: [s.omo, path.join(s.omo, "policy.json"), path.join(s.omo, "audit", "ops-audit.jsonl"), path.join(s.base, "proj", ".ops-pi")],
	});
}

describe("PathGuard · 机密根（读写皆拒）", () => {
	it("模型凭据 / SSH 私钥 / 令牌 / vault（尚不存在的文件亦拒）→ 读拒", () => {
		const s = sandbox();
		const g = guardFor(s);
		includes(g.denyRead(path.join(s.home, ".omp", "auth.json")), "机密根");
		includes(g.denyRead(path.join(s.home, ".ssh", "id_ed25519")), "机密根");
		includes(g.denyRead(path.join(s.omo, "approval-token.json")), "机密根");
		includes(g.denyRead(path.join(s.omo, "vault.db")), "机密根");
		assert.throws(() => g.assertReadable(path.join(s.home, ".omp", "auth.json")), /POLICY_DENIED/);
	});

	it("相对路径 / `..` 穿越归一后仍命中", () => {
		const s = sandbox();
		const g = guardFor(s);
		const sneaky = path.join(s.omo, "knowledge", "..", "home", ".omp", "auth.json");
		includes(g.denyRead(sneaky), "机密根");
	});

	it("符号链接绕行：/tmp/x → $HOME/.ssh 归一到真实路径后拒", () => {
		const s = sandbox();
		const g = guardFor(s);
		const link = path.join(s.base, "innocent");
		try {
			fs.symlinkSync(path.join(s.home, ".ssh"), link, "dir");
		} catch {
			return; // 平台不允许创建符号链接（Windows 非管理员）→ 跳过
		}
		assert.equal(realize(path.join(link, "id_ed25519")), realize(path.join(s.home, ".ssh", "id_ed25519")));
		includes(g.denyRead(path.join(link, "id_ed25519")), "机密根");
	});

	it("普通路径放行：/var/log、/etc/hosts、policy.json（信任根可读）", () => {
		const s = sandbox();
		const g = guardFor(s);
		assert.equal(g.denyRead("/var/log/nginx/error.log"), null);
		assert.equal(g.denyRead("/etc/hosts"), null);
		assert.equal(g.denyRead(path.join(s.omo, "policy.json")), null);
		assert.equal(g.denyRead(path.join(s.omo, "knowledge", "x.md")), null);
	});

	it("递归读（grep -r）：目标覆盖机密根（如 $HOME 的父目录 / 私有域根）→ 拒；具体日志目录放行", () => {
		const s = sandbox();
		const g = guardFor(s);
		includes(g.denyReadTree(s.base), "覆盖机密根");
		includes(g.denyReadTree(s.omo), "覆盖机密根");
		includes(g.denyReadTree(path.join(s.home, ".omp")), "机密根");
		assert.equal(g.denyReadTree("/var/log"), null);
	});
});

describe("PathGuard · 信任根（写拒、读放行）", () => {
	it("★ policy.json / approval-token.json / 私有域任意文件 / 项目 .ops-pi/config.json → 写拒（防自授权）", () => {
		const s = sandbox();
		const g = guardFor(s);
		includes(g.denyWrite(path.join(s.omo, "policy.json")), "信任根");
		includes(g.denyWrite(path.join(s.omo, "approval-token.json")), "机密根");
		includes(g.denyWrite(path.join(s.omo, "extensions", "ops-pi", "index.ts")), "信任根");
		includes(g.denyWrite(path.join(s.omo, "audit", "ops-audit.jsonl")), "信任根");
		includes(g.denyWrite(path.join(s.base, "proj", ".ops-pi", "config.json")), "信任根");
		assert.throws(() => g.assertWritable(path.join(s.omo, "policy.json")), /POLICY_DENIED/);
	});

	it("信任根外的写放行：/etc/nginx/conf.d/x.conf、/tmp/x", () => {
		const s = sandbox();
		const g = guardFor(s);
		assert.equal(g.denyWrite("/etc/nginx/conf.d/x.conf"), null);
		assert.equal(g.denyWrite(path.join(s.base, "proj", "app.log")), null);
	});

	it("空根/空串被忽略；无根时一切放行", () => {
		const g = new PathGuard({ secret: ["", "  "], trust: [] });
		assert.deepEqual(g.roots, { secret: [], trust: [] });
		assert.equal(g.denyRead("/root/.ssh/id_rsa"), null);
		assert.equal(g.denyWrite("/root/.omo/policy.json"), null);
	});
});
