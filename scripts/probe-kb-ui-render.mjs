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
};
globalThis.navigator = { clipboard: { writeText: async () => {} } };
globalThis.location = { pathname: "/ui/", reload() {} };
globalThis.alert = () => {};

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
};
globalThis.fetch = async (u) => {
	const s = String(u);
	if (s.includes("api/state")) return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } });
	return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const mod = new Function(`${pageJs}\nreturn { loadState };`);
const { loadState } = mod();
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

let failed = 0;
for (const [name, ok, detail] of checks) {
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `（${detail}）`}`);
	if (!ok) failed++;
}
console.log(`渲染验收：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
