import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTROL_PLANE_VERSION,
	ControlPlaneError,
	activateInstallToken,
	atomicWriteJson,
	completeInstallToken,
	controlPlaneDir,
	ensureAdminToken,
	instanceView,
	issueInstallToken,
	issueReportToken,
	listInstallTokens,
	listInstallers,
	listInstances,
	loadStore,
	readAdminToken,
	revokeInstallToken,
	revokeReportToken,
	sha256Hex,
	storePath,
	updateStore,
	upsertInstaller,
	upsertInstance,
	verifyInstallToken,
	verifyReportToken,
} from "../../../scripts/lib/kb-control-plane.mjs";

const roots: string[] = [];
function tmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kbcp-"));
	roots.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

describe("control-plane store", () => {
	test("缺失返回空 store；损坏/旧版本大声失败", () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "tokens");
		expect(loadStore(file).revision).toBe(0);
		expect(loadStore(file).items).toEqual([]);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{bad json");
		expect(() => loadStore(file)).toThrow(ControlPlaneError);
		fs.writeFileSync(file, JSON.stringify({ version: 999, revision: 1, items: [] }));
		expect(() => loadStore(file)).toThrow(/版本不支持/);
	});

	test("原子写 0600（能力可表达时）且 revision 递增", async () => {
		const root = tmpRoot();
		const dir = controlPlaneDir(root);
		const file = storePath(dir, "instances");
		const r1 = await updateStore(file, (s) => { s.items.push({ installId: "ins_1" }); return 1; });
		const r2 = await updateStore(file, (s) => { s.items.push({ installId: "ins_2" }); return 2; });
		expect(r1.result).toBe(1);
		expect(r2.revision).toBe(r1.revision + 1);
		expect(loadStore(file).items).toHaveLength(2);
		const mode = fs.statSync(file).mode & 0o777;
		if (process.platform !== "win32") expect(mode).toBe(0o600);
	});
});

describe("install tokens", () => {
	test("签发只落哈希；验证→激活→完成；完成后不可重放", async () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "tokens");
		const { token, record } = await issueInstallToken(file, { version: "v1", device: "node-a", createdBy: "test" });
		expect(token.startsWith("omoinst_")).toBe(true);
		expect(token.length).toBeGreaterThan(40);
		expect(record.installId.startsWith("ins_")).toBe(true);
		const raw = fs.readFileSync(file, "utf8");
		expect(raw).not.toContain(token);
		expect(raw).toContain(sha256Hex(token));
		expect(verifyInstallToken(file, token, "node-a").ok).toBe(true);
		expect(verifyInstallToken(file, token, "node-b").reason).toBe("device_mismatch");
		await activateInstallToken(file, token);
		expect(verifyInstallToken(file, token, "node-a").ok).toBe(true);
		await completeInstallToken(file, token);
		expect(verifyInstallToken(file, token, "node-a").reason).toBe("completed");
		expect(listInstallTokens(file)[0]?.sha256).toBeUndefined();
	});

	test("过期与吊销拒绝", async () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "tokens");
		const a = await issueInstallToken(file, { version: "v1", ttlMin: 1 });
		await updateStore(file, (s) => {
			const rec = s.items.find((x: any) => x.installId === a.record.installId);
			rec.expiresAt = new Date(Date.now() - 1000).toISOString();
		});
		expect(verifyInstallToken(file, a.token).reason).toBe("expired");

		const b = await issueInstallToken(file, { version: "v1" });
		await revokeInstallToken(file, b.record.installId);
		expect(verifyInstallToken(file, b.token).reason).toBe("revoked");
	});

	test("并发签发不丢记录", async () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "tokens");
		const issued = await Promise.all(Array.from({ length: 20 }, () => issueInstallToken(file, { version: "v1" })));
		expect(new Set(issued.map((x) => x.record.installId)).size).toBe(20);
		expect(loadStore(file).items).toHaveLength(20);
		expect(loadStore(file).revision).toBe(20);
	});
});

describe("installers and instances", () => {
	test("installer upsert 按 version/channel 幂等；缺 script_sha256 拒绝", async () => {
		const root = tmpRoot();
		const dir = controlPlaneDir(root);
		const file = storePath(dir, "installers");
		const base = { version: "v1", channel: "stable", script_sha256: "a".repeat(64), manifest: { platforms: [] } };
		await upsertInstaller(file, base);
		await upsertInstaller(file, { ...base, status: "hidden" });
		expect(listInstallers(file)).toHaveLength(1);
		expect(listInstallers(file)[0].status).toBe("hidden");
		await expect(upsertInstaller(file, { version: "v2" })).rejects.toThrow(/script_sha256/);
	});

	test("实例以 installId 唯一；lastSeen 过期标 stale", async () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "instances");
		await upsertInstance(file, { installId: "ins_1", device: "a", version: "v1", lastSeen: new Date().toISOString() });
		await upsertInstance(file, { installId: "ins_1", device: "a", version: "v2" });
		expect(listInstances(file)).toHaveLength(1);
		expect(listInstances(file)[0].version).toBe("v2");
		const view = instanceView({ ...listInstances(file)[0], lastSeen: new Date(Date.now() - 48 * 3600_000).toISOString() }, Date.now(), 24 * 3600_000);
		expect(view.stale).toBe(true);
		expect(view.online).toBe(false);
	});

	test("★ 上报令牌：只存哈希；按哈希定位实例；吊销/撤销后拒绝；列表不回显哈希", async () => {
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "instances");
		await upsertInstance(file, { installId: "ins_auth", device: "node-1", version: "v1" });
		const { token } = await issueReportToken(file, "ins_auth");
		expect(token.startsWith("omoreport_")).toBe(true);
		expect(verifyReportToken(file, token).ok).toBe(true);
		expect(verifyReportToken(file, `${token}x`).ok).toBe(false);
		expect(JSON.stringify(listInstances(file))).not.toContain(token);
		expect(JSON.stringify(listInstances(file))).not.toContain(sha256Hex(token));
		expect(listInstances(file)[0].reportToken).toBe(true);

		// 普通上报不得清掉令牌（字段沿用 prev）
		await upsertInstance(file, { installId: "ins_auth", status: "reported", lastSeen: new Date().toISOString() });
		expect(verifyReportToken(file, token).ok).toBe(true);

		await revokeReportToken(file, "ins_auth");
		expect(verifyReportToken(file, token).ok).toBe(false);
		expect(verifyReportToken(file, token).reason).toBe("revoked");
		expect(listInstances(file)[0].reportToken).toBe(false);

		await expect(issueReportToken(file, "ins_missing")).rejects.toThrow(/实例不存在/);
	});
});

describe("admin token", () => {
	test("首次生成 0600；再次读取同一 token；不落空", () => {
		const root = tmpRoot();
		const file = path.join(controlPlaneDir(root), "admin.token");
		const a = ensureAdminToken(file);
		expect(a.created).toBe(true);
		expect(a.token.startsWith("omoadmin_")).toBe(true);
		expect(readAdminToken(file)).toBe(a.token);
		const b = ensureAdminToken(file);
		expect(b.created).toBe(false);
		expect(b.token).toBe(a.token);
	});
});

describe("version constant", () => {
	test("store version 固定", () => {
		expect(CONTROL_PLANE_VERSION).toBe(1);
		const root = tmpRoot();
		const file = storePath(controlPlaneDir(root), "tokens");
		atomicWriteJson(file, { version: CONTROL_PLANE_VERSION, revision: 0, items: [] });
		expect(loadStore(file).version).toBe(CONTROL_PLANE_VERSION);
	});
});
