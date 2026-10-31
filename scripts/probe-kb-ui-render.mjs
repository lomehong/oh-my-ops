#!/usr/bin/env bun
/**
 * probe-kb-ui-render.mjs —— 页面渲染真执行验收（headless）
 *
 * 动机（真机教训）：契约探针只 grep HTML 字符串，抓不到「HTML 在但 JS 语法错/逻辑废」——
 * 曾把 renderRegistry 括号不配对（整页 JS 全废）与 config 形状不一致（配置表单恒空）放行。
 * 本脚本把 index.html 里的真实 JS 抽出来，在最小 DOM 垫片下**真跑一遍** loadState 并断言渲染结果。
 */
import { readFileSync } from "node:fs";

const htmlPath = process.argv[2] ?? "scripts/ui/index.html";
const html = readFileSync(htmlPath, "utf8");
const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
if (m === null) {
	console.error("  ✗ 页面中找不到 <script> 块");
	process.exit(1);
}
const pageJs = m[1].replace(/^\s*loadState\(\);\s*$/m, "");

/* 最小 DOM 垫片：只实现页面用到的那几个 API */
const nodes = new Map();
const mk = (sel) => ({
	sel,
	html: "",
	textContent: "",
	value: "",
	dataset: {},
	classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
	addEventListener() {},
	set innerHTML(v) { this.html = String(v); },
	get innerHTML() { return this.html; },
});
globalThis.document = {
	querySelector: (s) => { if (!nodes.has(s)) nodes.set(s, mk(s)); return nodes.get(s); },
	querySelectorAll: () => [],
	addEventListener: () => {},
};
globalThis.navigator = { clipboard: { writeText: async () => {} } };
globalThis.location = { pathname: "/ui/", reload() {} };
globalThis.sessionStorage = { getItem: () => "harness-token", setItem: () => {}, removeItem: () => {} };
globalThis.alert = () => {};
globalThis.confirm = () => true;

/* fixture：4 条登记 + 2 个未用码，形状与真机 state 一致 */
const FIXTURE = {
	actor: "harness",
	health: { ok: true, repo: "hzins-ops/ops-kb", registryVersion: 3, tls: true, pid: 4242, uptimeSec: 60 },
	ui: { on: true, identityHeader: "X-Auth-Username", configPath: "/root/.omo-kb/config.env" },
	config: {
		keys: { OMO_KB_API: "Gitea API", OMO_KB_REPO: "仓库（owner/name）", OMO_KB_TEAM: "团队名", OMO_KB_UI: "管理后台开关" },
		values: { OMO_KB_API: "https://example/api/v1", OMO_KB_REPO: "acme/kb", OMO_KB_TEAM: "t", OMO_KB_UI: "on" },
	},
	registry: {
		file: "/root/.omo-kb/registry.json",
		entries: [
			{ device: "logstash-124", login: "omo-bot-logstash-124", repo: "acme/kb", grant: "team", team: "t", permission: "write" },
			{ device: "node-121", login: "omo-bot-node-121", repo: "acme/kb", grant: "team", team: "t", permission: "write" },
			{ device: "node-122", login: "omo-bot-node-122", repo: "acme/kb", grant: "team", team: "t", permission: "write", revokedAt: "2026-09-21T00:00:00Z" },
		],
		pendingCodes: [{ op: "enroll", device: "node-123", expiresAt: "2026-09-21T12:00:00Z" }],
	},
	auditTail: [{ seq: 1, ts: "2026-09-21T00:00:00Z", event: "ui.code.issued", actor: "owner" }],
	gate: {
		mode: "warn", mainBranch: "main", webhookConfigured: true, webhookUrl: "https://example/kb/webhook",
		webhookSecret: { configured: true, previousActive: true, previousExpiresAt: "2026-10-31T00:00:00Z", rotatedAt: "2026-10-30T00:00:00Z", lastVerifiedAt: "2026-10-30T00:10:00Z" },
	},
	controlPlane: {
		installers: [{ version: "v1", channel: "stable", status: "available", manifest: { platforms: [{ os: "linux", arch: "x86_64" }] } }],
		installTokens: [{ installId: "ins_tok", version: "v1", device: "node-130", state: "completed", expiresAt: "2026-09-21T12:00:00Z" }],
		instances: [{
			installId: "ins_live", device: "node-130", status: "reported", version: "v1",
			lastSeen: "2026-10-30T01:00:00Z", lastSync: "2026-10-30T00:59:00Z", stale: true, online: false,
			reportToken: true, lastError: { stage: "installed", reason: "示例失败" },
		}],
	},
	content: { repo: "acme/kb", url: "https://example/acme/kb", provider: "gitea", management: true },
};
const AUDIT_FIXTURE = [
	{ seq: 10, ts: "2026-10-30T01:00:00Z", event: "install.manifest", installId: "ins_live", version: "v1" },
	{ seq: 11, ts: "2026-10-30T01:01:00Z", event: "install.script", installId: "ins_live" },
	{ seq: 12, ts: "2026-10-30T01:02:00Z", event: "install.artifact", installId: "ins_live", name: "pkg.tar.gz" },
	{ seq: 13, ts: "2026-10-30T01:03:00Z", event: "enroll.enroll", installId: "ins_live", actor: "install:ins_live" },
	{ seq: 14, ts: "2026-10-30T01:04:00Z", event: "install.report", installId: "ins_live", stage: "status" },
	{ seq: 15, ts: "2026-10-30T01:05:00Z", event: "install.failed", installId: "ins_live", stage: "downloaded", reason: "sha256 mismatch" },
];
globalThis.fetch = async (u) => {
	const s = String(u);
	if (s.includes("api/state")) return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } });
	if (s.includes("api/audit")) return new Response(JSON.stringify({ ok: true, audit: AUDIT_FIXTURE }), { status: 200, headers: { "Content-Type": "application/json" } });
	return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const mod = new Function(`${pageJs}\nreturn { loadState, loadAudit };`);
const { loadState, loadAudit } = mod();
await loadState();

const checks = [];
const P = (name, ok, detail) => checks.push([name, ok, detail]);
const reg = document.querySelector("#reg-entries").innerHTML;
const rows = (reg.match(/<tr>/g) ?? []).length;
P("页面 JS 可执行（语法/顶层逻辑正常）", true);
P("登记表渲染行数 = 表头 + 3 条登记", rows === 4, `实际 ${rows}`);
P("含来源路径", reg.includes("来源："), "");
P("含有效态与吊销态", reg.includes("● 有效") && reg.includes("已吊销"), "");
P("状态栏含 repo/PID", /PID 4242/.test(document.querySelector("#hdr-sub").textContent + document.querySelector("#hdr-sub").innerHTML), "");
P("配置表单字段 > 0（形状一致）", ((document.querySelector("#cfg-form").innerHTML.match(/data-k=/g) ?? []).length) === 4, `实际 ${(document.querySelector("#cfg-form").innerHTML.match(/data-k=/g) ?? []).length}`);
P("未用兑换码有渲染", document.querySelector("#reg-codes").innerHTML.includes("node-123"), "");
P("审计尾部有渲染", document.querySelector("#audit-pre").textContent.includes("ui.code.issued"), "");
const inst = document.querySelector("#instances-table").innerHTML;
P("实例表含上报令牌与 stale（不宣称在线）", inst.includes("已签发") && inst.includes("stale") && inst.includes("ins_live"), inst.slice(0, 120));
P("实例表含最近错误", inst.includes("installed: 示例失败"), "");
const gate = document.querySelector("#st-gate").innerHTML;
P("门禁显示双密钥宽限", gate.includes("旧密钥仍接受") && gate.includes("2026-10-31T00:00:00Z"), gate.slice(0, 160));
P("门禁含轮换入口", gate.includes("gate-rotate"), "");
P("门禁含最近验签与关闭宽限", gate.includes("2026-10-30T00:10:00Z") && gate.includes("gate-close-window"), "");
await loadAudit();
const hist = document.querySelector("#audit-installs").innerHTML;
P("安装历史按 installId 归组（含阶段）", hist.includes("ins_live") && hist.includes("install.manifest") && hist.includes("install.failed"), hist.slice(0, 160));
P("安装历史标注失败", hist.includes("失败"), "");
P("审计过滤条数回显", document.querySelector("#au-msg").textContent.includes("6"), document.querySelector("#au-msg").textContent);
const content = document.querySelector("#content-links").innerHTML;
P("内容入口只深链（不含编辑/评审表单）", content.includes("本后台不提供内容编辑器") && !content.includes("<textarea") && !content.includes("<form"), content.slice(0, 160));
P("内容入口指向 Gitea 仓库", content.includes("https://example/acme/kb"), "");
P("页面无 textarea（无第二套评审流）", !html.includes("<textarea"), "");

let failed = 0;
for (const [name, ok, detail] of checks) {
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（${detail}）`}`);
	if (!ok) failed++;
}
console.log(`渲染验收：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
