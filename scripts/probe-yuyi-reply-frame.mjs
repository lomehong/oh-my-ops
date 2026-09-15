#!/usr/bin/env node
/**
 * probe-yuyi-reply-frame.mjs —— 桩宿主 + 桩 Hub，驱动 vendor/yuyi-omp-extension.js
 * 的「入站 notify（无 replyTo）→ turn 末自动回信」路径，并按真实 Hub 的回信校验规则裁决回信帧。
 *
 * 覆盖 OMOBRIDGE-2 的 T2/T3/T4/T5/T6/T7：改动前报红（回信目标=裸会话别名、from.device 为空、
 * 手工回信不抑制），改动后全绿。规则与生产实测一致（2026-09-15，Hub ws://172.20.10.91:7377）：
 *   · 带 replyTo 的消息 → 目标必须解析到「原请求发送方 agent」；裸别名 / device:别名 → 未解析（拒）
 *   · device:sessionID、agent_name、agentId → 可解析（接受）
 * 用法：node scripts/probe-yuyi-reply-frame.mjs [--bundle <path>]   退出码 0=全绿
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const argIdx = process.argv.indexOf("--bundle");
const BUNDLE = argIdx > 0 ? process.argv[argIdx + 1] : new URL("../vendor/yuyi-omp-extension.js", import.meta.url).pathname;
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuyi-probe-"));
const LOG_FILE = join(STATE_DIR, "omp-plugin.log");

process.env.YUYI_STATE_DIR = STATE_DIR;
process.env.YUYI_DEVICE = "HARNESS-DEV";
process.env.YUYI_HUB = "ws://fake-hub:7377";
process.env.YUYI_TOKEN = "harness-token";
process.env.YUYI_AUTO_RESPOND = "true";
delete process.env.YUYI_AGENT_GATE_STRICT;

const PEER = { device: "PEER-DEV", sessionID: "omp_peer1", name: "PEER-DEV-omp", agentId: "peer-agent-id", ownerUsername: "hz0704027" };
const SELF = { device: "HARNESS-DEV", alias: "HARNESS-DEV-omp", agentId: "harness-agent-id", agentName: "harness-omp" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (fn()) return true;
		await sleep(100);
	}
	return false;
}
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ───────── 桩 Hub（含回信校验复刻）
const hub = { connections: 0, sockets: [], outbound: [], acks: [] };
const delivered = new Map(); // msgId → 原消息（回信校验用）

function resolveAgent(to = {}) {
	if (to.target === SELF.agentName) return SELF.agentId;
	if (to.target === PEER.agentId) return PEER.agentId;
	if (to.device === PEER.device && to.target === PEER.sessionID) return PEER.agentId;
	return null; // 裸别名 / device:别名 / 裸 sessionID → 未解析（与生产实测一致）
}
function judgeReply(msg) {
	if (!msg.replyTo) return { ok: true };
	const src = delivered.get(msg.replyTo);
	if (!src) return { ok: false, detail: `replyTo "${msg.replyTo}" 引用的消息不存在或未投递给本 agent（防伪造关联）` };
	const agent = resolveAgent(msg.to ?? {});
	if (agent !== src.from.agentId) {
		return {
			ok: false,
			detail: `回信去向与原请求发送方不符：目标 "${(msg.to ?? {}).target}" 归属 agent ${agent ?? "(未解析)"}，原请求发送方为 ${src.from.agentId}`,
		};
	}
	return { ok: true };
}
function handleOutbound(ws, frame) {
	if (frame.type === "hello") {
		ws.gotWelcome = true;
		ws.push({
			type: "welcome",
			protocolVersion: 2,
			agentId: SELF.agentId,
			agentName: SELF.agentName,
			ownerUsername: "hz0704027",
			role: "coder",
			features: ["inbox", "capabilities", "identity", "task", "trace"],
		});
		return;
	}
	if (frame.type === "send") {
		const verdict = judgeReply(frame.message);
		hub.acks.push({ id: frame.id, ok: verdict.ok, detail: verdict.detail, msgId: frame.message?.id });
		ws.push({ type: "ack", id: frame.id, ok: verdict.ok, ...(verdict.ok ? { deliveredAs: "notify" } : { detail: verdict.detail }) });
	}
}
class FakeWS {
	constructor(url) {
		this.url = url;
		this.closed = false;
		this.gotWelcome = false;
		hub.connections += 1;
		hub.sockets.push(this);
		setTimeout(() => !this.closed && this.onopen?.(), 0);
	}
	send(raw) {
		const frame = JSON.parse(raw);
		hub.outbound.push(frame);
		handleOutbound(this, frame);
	}
	close(code = 1000, reason = "") {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.({ code, reason });
	}
	serverClose(code, reason = "") {
		this.close(code, reason);
	}
	push(frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	deliver(message) {
		this.lastDeliverAt = Date.now();
		delivered.set(message.id, message);
		this.push({ type: "deliver", id: message.id, message });
	}
}
globalThis.WebSocket = FakeWS;

// ───────── 桩宿主 pi
const anySchema = new Proxy(function () {}, {
	get: (_t, k) => (k === "describe" || k === "optional" || k === "default" || k === "array" || k === "refine" ? () => anySchema : undefined),
	apply: () => anySchema,
});
const z = { object: () => anySchema, string: () => anySchema, boolean: () => anySchema, number: () => anySchema, array: () => anySchema, enum: () => anySchema, any: () => anySchema, optional: () => anySchema };
const handlers = new Map();
const tools = new Map();
const injected = [];
const pi = {
	zod: z,
	setLabel: () => {},
	on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
	registerTool: (def) => tools.set(def.name, def),
	sendUserMessage: (text) => injected.push(String(text)),
};
async function emit(name, ...args) {
	for (const fn of handlers.get(name) ?? []) await fn(...args);
}
const sendsOf = (msgId) => hub.outbound.filter((f) => f.type === "send" && f.message?.replyTo === msgId).map((f) => f.message);
const logText = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "");

// ───────── 场景
console.log(`bundle: ${BUNDLE}`);
console.log(`state : ${STATE_DIR}`);
const mod = await import(pathToFileURL(BUNDLE).href);
mod.default(pi);
await emit("session_start", {}, { cwd: process.cwd(), sessionManager: { getSessionFile: () => "/tmp/omp_abc123.jsonl" } });
await sleep(400);
const ws = () => hub.sockets.filter((s) => s.gotWelcome && !s.closed).at(-1);
check("桩握手：收到 hello 并回 welcome", Boolean(ws()), `connections=${hub.connections}`);

// 场景 A：入站 notify（无 replyTo）→ 自动回信（T2/T3/T4）
console.log("\n[场景 A] 跨设备 notify 入站（无 replyTo）→ turn 末自动回信");
const msg1 = { id: "msg_peer_1", mode: "notify", text: "请回执", taskId: "task_peer_1", from: { ...PEER }, to: { target: SELF.alias }, time: Date.now() };
ws().deliver(msg1);
await sleep(200);
check("入站已注入宿主会话", injected.length > 0, `injected=${injected.length}`);
await emit("message_end", { message: { role: "assistant", content: "回执：已收到，通道正常。" } });
await emit("turn_end", {});
await sleep(4200);
const replies = sendsOf("msg_peer_1");
const reply = replies.at(-1);
if (reply) console.log(`  回信帧: ${JSON.stringify({ from: reply.from, to: reply.to, replyTo: reply.replyTo, taskId: reply.taskId })}`);
check("T2 回信目标为 agent 级（device + sessionID）", Boolean(reply) && reply.to?.device === PEER.device && reply.to?.target === PEER.sessionID, reply ? `to=${JSON.stringify(reply.to)}` : "未发出回信");
check("T3 回信帧 from.device 非空", Boolean(reply) && Boolean(reply.from?.device), reply ? `from.device=${JSON.stringify(reply.from.device)}` : "未发出回信");
const finalAck = hub.acks.filter((a) => replies.some((r) => r.id === a.msgId)).at(-1);
check("桩 Hub 回信校验接受（agent 级解析）", Boolean(finalAck?.ok), finalAck ? `ok=${finalAck.ok} ${finalAck.detail ?? ""}` : "无 ack");
const t4ok = /回信已投递/.test(logText());
check("T4 成功投递有日志（可观测）", t4ok, t4ok ? "命中「回信已投递」" : "日志无成功明细");

// 场景 B：手工别名回信 → 自动补 replyTo + 抑制自动回信（T5/T6）
console.log("\n[场景 B] 第二条入站 → 用对端别名手工回信（yuyi_send）");
const msg2 = { id: "msg_peer_2", mode: "notify", text: "第二条", taskId: "task_peer_2", from: { ...PEER }, to: { target: SELF.alias }, time: Date.now() };
ws().deliver(msg2);
await sleep(200);
const sendTool = tools.get("yuyi_send");
const manual = await sendTool.execute("call1", { to: PEER.name, message: "手工回执", classification: "info" });
const manualFrame = hub.outbound.filter((f) => f.type === "send" && f.message?.text === "手工回执").at(-1)?.message;
const manualAck = hub.acks.filter((a) => a.msgId === manualFrame?.id).at(-1);
check(
	"T6 别名寻址的手工回信：自动补 replyTo 且目标归一到 agent 级",
	Boolean(manualFrame) && manualFrame.replyTo === "msg_peer_2" && manualFrame.to?.device === PEER.device && manualFrame.to?.target === PEER.sessionID && manualAck?.ok === true,
	manualFrame ? `replyTo=${manualFrame.replyTo} to=${JSON.stringify(manualFrame.to)} ack=${manualAck?.ok ? "ok" : String(manual?.content?.[0]?.text)}` : "未发出",
);
const t5log = /手工回信检测/.test(logText());
check("T5 手工回信抑制生效（日志命中）", t5log, t5log ? "命中「手工回信检测」" : "日志无抑制记录");
await emit("message_end", { message: { role: "assistant", content: "第二条回执。" } });
await emit("turn_end", {});
await sleep(4200);
const dup = sendsOf("msg_peer_2").filter((m) => m.id !== manualFrame?.id);
check("T5b 抑制后不再自动回信（无重复）", dup.length === 0, `重复回信数=${dup.length}`);

// 场景 C：close 码（T7）—— 先对照 1006（应重连），再 4008（应不重连）
// 注：插件初始化会 connect() 两次（工厂末尾 + session_start），因此存在僵尸连接；
// 用「收到过 deliver 的那条 socket」锁定当前 client，避免误测僵尸。
console.log("\n[场景 C] close 码语义：1006 重连（对照）→ 4008 不重连");
const live = () => hub.sockets.filter((s) => s.lastDeliverAt && !s.closed).at(-1) ?? ws();
const before = hub.connections;
live()?.serverClose(1006, "abnormal");
const reconnected = await waitFor(() => hub.connections > before, 8000);
check("T7a 对照：1006 触发重连", reconnected, `connections ${before} → ${hub.connections}`);
const before2 = hub.connections;
live()?.serverClose(4008, "kicked by admin");
await sleep(5000);
check("T7b 4008 不重连（防连接风暴）", hub.connections === before2, `connections ${before2} → ${hub.connections}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) console.log(`未通过：${failed.map((f) => f.name).join("；")}`);
console.log(`插件日志：${LOG_FILE}`);
process.exit(failed.length ? 1 : 0);
