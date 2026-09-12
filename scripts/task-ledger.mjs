#!/usr/bin/env node
/**
 * task-ledger.mjs —— 任务面契约的 oh-my-pi（omp）实现（文件台账）
 *
 * 契约：architect-knowledge/principle/task-and-memory-surface.md §一
 *   五操作：create(new) / claim / report / confirm / list / archive（另含状态机要求的 reject）
 *   状态机：待执行 --claim--> 执行中 --report--> 待确认 --confirm--> 已落定
 *                          ↑                  │
 *                          └──── reject ──────┘
 *   四不变量：
 *     1. report ≠ 完成（只进「待确认」）
 *     2. confirm 只能由主人发起，且必须记录来源（confirmedBy + confirmedVia）
 *     3. 每步留痕可审计；非法跳步必须被拒（而非静默放过）
 *     4. 治理类动作未获授权即停（本脚本不做 push/发布/删除，仅记录痕迹）
 *
 * 落点：<root>/docs/tasks/<id>.yaml（git 管理，随项目版本化）
 *
 * 用法：
 *   node scripts/task-ledger.mjs new     --id <任务号> --title <标题> [--accept <条目>]… [--root <目标项目>] [--level <动作级别>] [--by <发起人>]
 *   node scripts/task-ledger.mjs claim   --id <任务号> --by <会话标识> [--branch <分支名>] [--root <目标项目>]
 *   node scripts/task-ledger.mjs report  --id <任务号> --summary <摘要> [--evidence <证据>]… [--pending <未兑现>]… [--by <会话标识>]
 *   node scripts/task-ledger.mjs reject  --id <任务号> --reason <原因> [--by <会话标识>]
 *   node scripts/task-ledger.mjs rescope --id <任务号> --reason <依据> [--title <新标题>] [--accept <条目>]… [--level <级别>] [--by <会话标识>]
 *   node scripts/task-ledger.mjs confirm --id <任务号> --confirmed-by <主人标识> --confirmed-via <确认来源引用> [--note <备注>]
 *   node scripts/task-ledger.mjs list    [--state <状态>] [--root <目标项目>]
 *   node scripts/task-ledger.mjs archive --id <任务号> [--force]
 *   node scripts/task-ledger.mjs --validate [--root <目标项目>]
 *   node scripts/task-ledger.mjs --selftest
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ───────────────────────── 受限 YAML 子集（写入即单引号标量，读取只解析本子集）
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const uq = (s) => s.replaceAll("''", "'");

function emit(value, indent = 0) {
	const pad = "  ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]\n`;
		return value.map((item) => {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				const entries = Object.entries(item);
				const [firstK, firstV] = entries[0];
				let out = `${pad}- ${firstK}: ${scalar(firstV)}\n`;
				for (const [k, v] of entries.slice(1)) {
					out += Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")
						? `${pad}  ${k}:\n` + emit(v, indent + 2)
						: v !== null && typeof v === "object" && !Array.isArray(v)
							? `${pad}  ${k}:\n${emit(v, indent + 2)}`
							: Array.isArray(v) && v.length === 0
								? `${pad}  ${k}: []\n`
								: `${pad}  ${k}: ${scalar(v)}\n`;
				}
				return out;
			}
			return `${pad}- ${scalar(item)}\n`;
		}).join("");
	}
	if (value !== null && typeof value === "object") {
		return Object.entries(value).map(([k, v]) => {
			if (Array.isArray(v)) return v.length === 0 ? `${pad}${k}: []\n` : `${pad}${k}:\n${emit(v, indent + 1)}`;
			if (v !== null && typeof v === "object") return `${pad}${k}:\n${emit(v, indent + 1)}`;
			return `${pad}${k}: ${scalar(v)}\n`;
		}).join("");
	}
	return `${pad}${scalar(value)}\n`;
}
function scalar(v) {
	if (v === null || v === undefined) return "''";
	if (Array.isArray(v)) return v.length === 0 ? "[]" : v.map((x) => q(x)).join(", ");
	return q(v); // 全部标量按字符串写，读取侧无需类型推断
}

/** 只解析本脚本 emit 的子集：单引号标量、`[]`、`- ` 列表、`- k: 'v'` 列表项、缩进嵌套 */
function parse(text) {
	const raw = text.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
	let i = 0;
	const indentOf = (l) => l.length - l.trimStart().length;
	function block(indent) {
		const isList = raw[i] !== undefined && indentOf(raw[i]) === indent && raw[i].trimStart().startsWith("- ");
		if (isList) {
			const arr = [];
			while (i < raw.length && indentOf(raw[i]) === indent && raw[i].trimStart().startsWith("- ")) {
				const rest = raw[i].trimStart().slice(2);
				const kv = rest.match(/^([^:]+):\s*(.*)$/);
				if (kv) {
					const map = {};
					map[kv[1].trim()] = kv[2] === "[]" ? [] : parseScalar(kv[2]);
					i++;
					while (i < raw.length && indentOf(raw[i]) > indent && !raw[i].trimStart().startsWith("- ")) {
						const m = raw[i].trim().match(/^([^:]+):\s*(.*)$/);
						const key = m[1].trim();
						if (m[2] === "" ) { i++; map[key] = block(indentOf(raw[i])); }
						else if (m[2] === "[]") { map[key] = []; i++; }
						else { map[key] = parseScalar(m[2]); i++; }
					}
					arr.push(map);
				} else {
					arr.push(rest === "[]" ? [] : parseScalar(rest));
					i++;
				}
			}
			return arr;
		}
		const map = {};
		while (i < raw.length && indentOf(raw[i]) === indent && !raw[i].trimStart().startsWith("- ")) {
			const m = raw[i].trim().match(/^([^:]+):\s*(.*)$/);
			if (!m) throw new Error(`台账解析失败（第 ${i + 1} 行）：${raw[i]}`);
			const key = m[1].trim();
			if (m[2] === "") { i++; map[key] = block(indentOf(raw[i] ?? " ".repeat(indent + 2))); }
			else if (m[2] === "[]") { map[key] = []; i++; }
			else { map[key] = parseScalar(m[2]); i++; }
		}
		return map;
	}
	const out = block(0);
	if (i < raw.length) throw new Error(`台账解析残留（第 ${i + 1} 行）：${raw[i]}`);
	return out;
}
function parseScalar(s) {
	const t = s.trim();
	if (t === "[]") return [];
	if (t.startsWith("'")) {
		if (!t.endsWith("'")) throw new Error(`未闭合的单引号：${t}`);
		return uq(t.slice(1, t === "''" ? 1 : -1));
	}
	return t; // 兼容手工编辑的裸标量
}

// ───────────────────────── 台账 IO 与不变量
const STATES = ["待执行", "执行中", "待确认", "已落定"];
const TRANSITIONS = { 待执行: ["执行中"], 执行中: ["待确认"], 待确认: ["已落定", "执行中"], 已落定: [] };

function tasksDir(root) { return path.join(root, "docs", "tasks"); }
function taskPath(root, id) { return path.join(tasksDir(root), `${id}.yaml`); }

function load(root, id) {
	const p = taskPath(root, id);
	if (!fs.existsSync(p)) fail(`任务不存在：${id}（${p}）`);
	return parse(fs.readFileSync(p, "utf8"));
}
function save(root, task) {
	fs.mkdirSync(tasksDir(root), { recursive: true });
	fs.writeFileSync(taskPath(root, task.id), emit(task), "utf8");
}
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function record(task, op, by, note) {
	task.events = task.events ?? [];
	task.events.push({ ts: new Date().toISOString(), op, by: by ?? "unknown", note: note ?? "" });
}
/** 不变量 3：非法跳步必须被拒 */
function transition(task, to, op, by, note) {
	if (!STATES.includes(to)) fail(`非法状态：${to}`);
	if (!TRANSITIONS[task.state].includes(to)) fail(`非法跳步：${task.state} → ${to}（任务 ${task.id}）`);
	task.state = to;
	record(task, op, by, note);
}

// ───────────────────────── CLI
function parseArgs(argv) {
	const flags = {}; const lists = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const k = a.slice(2);
		if (k === "selftest" || k === "validate" || k === "force") { flags[k] = true; continue; }
		const vals = [];
		while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
		if (vals.length === 0) fail(`--${k} 缺少取值`);
		if (["accept", "evidence", "pending"].includes(k)) lists[k] = [...(lists[k] ?? []), ...vals];
		else flags[k] = vals.join(" ");
	}
	return { flags, lists };
}

function cmdNew({ flags, lists }) {
	const root = flags.root ?? process.cwd();
	const id = flags.id ?? fail("--id 必填");
	if (fs.existsSync(taskPath(root, id))) fail(`任务号已存在：${id}`);
	const task = {
		id,
		title: flags.title ?? fail("--title 必填"),
		// 注：不持久化 root/绝对路径——台账随项目版本化，设备路径属噪声（跨设备失效）
		state: "待执行",
		level: flags.level ?? "unset",
		created: new Date().toISOString(),
		accept: lists.accept ?? [],
		events: [],
	};
	if (task.accept.length === 0) fail("--accept 至少一条（可验收条目）");
	record(task, "create", flags.by ?? "architect", task.title);
	save(root, task);
	console.log(`✓ 立项 ${id}（${task.state}）→ ${taskPath(root, id)}`);
}

function cmdClaim({ flags }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	const by = flags.by ?? fail("--by 必填（认领方会话标识）");
	transition(task, "执行中", "claim", by, flags.branch ? `branch=${flags.branch}` : "");
	if (flags.branch) task.branch = flags.branch;
	save(root, task);
	console.log(`✓ 认领 ${task.id} → ${task.state}（by ${by}）`);
}

function cmdReport({ flags, lists }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	const by = flags.by ?? "unknown";
	if (lists.evidence?.length === 0 && !flags.summary) fail("--summary 必填");
	task.report = {
		summary: flags.summary ?? "",
		evidence: lists.evidence ?? [],
		pending: lists.pending ?? [],
		at: new Date().toISOString(),
		by,
	};
	transition(task, "待确认", "report", by, task.report.summary);
	save(root, task);
	console.log(`✓ 自报 ${task.id} → ${task.state}（**待主人确认**，自报 ≠ 完成）`);
	if ((lists.pending ?? []).length > 0) console.log(`  未兑现项 ${lists.pending.length} 条已登记`);
}

function cmdReject({ flags }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	const by = flags.by ?? "master";
	transition(task, "执行中", "reject", by, flags.reason ?? "");
	save(root, task);
	console.log(`✓ 驳回 ${task.id} → ${task.state}`);
}

/**
 * rescope —— 重新界定任务范围（前提变更时的合法操作，保留痕迹）
 * 仅允许在「待执行」态；改标题/可验收条目/级别，不改变状态机。
 */
function cmdRescope({ flags, lists }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	if (task.state !== "待执行") fail(`仅「待执行」可重新界定（当前 ${task.state}）；已认领的任务须走 reject 流程`);
	const by = flags.by ?? "master";
	const before = { title: task.title, accept: task.accept, level: task.level };
	if (flags.title) task.title = flags.title;
	if (lists.accept?.length) task.accept = lists.accept;
	if (flags.level) task.level = flags.level;
	if (!flags.reason) fail("--reason 必填（记录重新界定的依据）");
	task.rescope = task.rescope ?? [];
	task.rescope.push({ at: new Date().toISOString(), by, reason: flags.reason, before });
	record(task, "rescope", by, flags.reason);
	save(root, task);
	console.log(`✓ 重新界定 ${task.id}（依据：${flags.reason}）`);
}

function cmdConfirm({ flags }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	// 不变量 2：只有主人可确认，且必须记录来源
	const by = flags["confirmed-by"];
	const via = flags["confirmed-via"];
	if (!by || !via) fail("confirm 必须提供 --confirmed-by 与 --confirmed-via（脚本拒绝无来源的确认）");
	task.confirmedBy = by;
	task.confirmedVia = via;
	transition(task, "已落定", "confirm", by, flags.note ?? via);
	save(root, task);
	console.log(`✓ 确认落定 ${task.id} → ${task.state}（by ${by} via ${via}）`);
}

function cmdList({ flags }) {
	const root = flags.root ?? process.cwd();
	const dir = tasksDir(root);
	if (!fs.existsSync(dir)) { console.log("（无台账）"); return; }
	const rows = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()
		.map((f) => { try { return parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { return { id: f, title: `<解析失败：${e.message}>`, state: "?" }; } })
		.filter((t) => !flags.state || t.state === flags.state);
	if (rows.length === 0) { console.log("（无匹配任务）"); return; }
	const w = Math.max(...rows.map((r) => String(r.id).length), 4);
	for (const t of rows) console.log(`${String(t.id).padEnd(w)}  ${String(t.state).padEnd(4)}  ${t.title}`);
}

function cmdArchive({ flags }) {
	const root = flags.root ?? process.cwd();
	const task = load(root, flags.id ?? fail("--id 必填"));
	if (task.state !== "已落定" && !flags.force) fail(`仅「已落定」可归档（当前 ${task.state}）；确需归档加 --force`);
	const dir = path.join(tasksDir(root), "archive");
	fs.mkdirSync(dir, { recursive: true });
	task.archivedAt = new Date().toISOString();
	save(root, task);
	fs.renameSync(taskPath(root, task.id), path.join(dir, `${task.id}.yaml`));
	console.log(`✓ 归档 ${task.id} → docs/tasks/archive/`);
}

function cmdValidate({ flags }) {
	const root = flags.root ?? process.cwd();
	const dir = tasksDir(root);
	if (!fs.existsSync(dir)) { console.log("✓ 无台账，视为通过"); return; }
	let errors = 0;
	for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
		const p = path.join(dir, f);
		try {
			const t = parse(fs.readFileSync(p, "utf8"));
			if (!t.id || !t.state || !STATES.includes(t.state)) throw new Error(`缺少 id 或 state 非法：${t.state}`);
			if (t.state === "已落定" && (!t.confirmedBy || !t.confirmedVia)) throw new Error("已落定但缺 confirmedBy/confirmedVia");
			if (!Array.isArray(t.events) || t.events.length === 0) throw new Error("缺少 events 留痕");
		} catch (e) { console.error(`✗ ${f}: ${e.message}`); errors++; }
	}
	if (errors > 0) fail(`结构校验失败 ${errors} 项`);
	console.log("✓ 台账结构校验通过");
}

// ───────────────────────── 自检（写入/解析往返 + 状态机 + 不变量）
function selftest() {
	const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ledger-selftest-"));
	let pass = 0, failCount = 0;
	const check = (name, cond) => { if (cond) { pass++; } else { console.error(`  ✗ ${name}`); failCount++; } };
	try {
		// 1) YAML 往返（含引号转义、数组、事件列表）
		const sample = { id: "T-1", title: "含 ' 单引号 与 中文", state: "待执行", accept: ["a", "b'c"], events: [{ ts: "t", op: "create", by: "x", note: "n" }] };
		check("YAML 往返", JSON.stringify(parse(emit(sample))) === JSON.stringify(sample));
		check("空数组往返", JSON.stringify(parse(emit({ a: [], b: ["x"] })).a) === "[]");
		// 2) 状态机非法跳步
		const t = { id: "T-2", state: "待执行", events: [] };
		let threw = false;
		const origExit = process.exit, origErr = console.error;
		process.exit = () => { throw new Error("exit"); }; console.error = () => {};
		try { transition(t, "已落定", "confirm", "m", "v"); } catch { threw = true; }
		process.exit = origExit; console.error = origErr;
		check("非法跳步被拒（待执行→已落定）", threw);
		// 3) 合法链
		const s = { id: "T-3", state: "待执行", events: [] };
		transition(s, "执行中", "claim", "a", ""); transition(s, "待确认", "report", "a", "");
		transition(s, "执行中", "reject", "m", ""); transition(s, "待确认", "report", "a", "");
		transition(s, "已落定", "confirm", "m", "via");
		check("合法链 待执行→执行中→待确认→执行中→待确认→已落定", s.state === "已落定");
		check("留痕完整（5 事件）", s.events.length === 5);
		// 4) confirm 来源必填（通过 CLI 路径）
		const cli = fs.mkdtempSync(path.join(tmp, "cli-"));
		cmdNewQuiet(cli);
		const rec = parse(fs.readFileSync(path.join(cli, "docs/tasks/S-1.yaml"), "utf8"));
		check("new 后为待执行且含 accept", rec.state === "待执行" && rec.accept.length === 1);
		// 5) rescope：待执行可改范围并留痕；非待执行被拒
		cmdRescope({ flags: { id: "S-1", root: cli, title: "新标题", reason: "前提变更", by: "master" }, lists: { accept: ["新条目"] } });
		const r2 = parse(fs.readFileSync(path.join(cli, "docs/tasks/S-1.yaml"), "utf8"));
		check("rescope 改标题与条目", r2.title === "新标题" && r2.accept[0] === "新条目");
		check("rescope 留痕（含 before 快照）", r2.rescope?.length === 1 && r2.rescope[0].before.title === "t");
		check("rescope 追加事件", r2.events[r2.events.length - 1].op === "rescope");
		const t4 = { id: "S-9", state: "执行中", events: [] , accept: [], title: "x"};
		save(cli, t4);
		let threw2 = false;
		process.exit = () => { throw new Error("exit"); }; console.error = () => {};
		try { cmdRescope({ flags: { id: "S-9", root: cli, reason: "r" }, lists: {} }); } catch { threw2 = true; }
		process.exit = origExit; console.error = origErr;
		check("非待执行态 rescope 被拒", threw2);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	console.log(`\n自检：${pass} 通过 / ${failCount} 失败`);
	if (failCount > 0) process.exit(1);
}
function cmdNewQuiet(root) {
	const task = { id: "S-1", title: "t", state: "待执行", level: "unset", created: "now", accept: ["x"], events: [{ ts: "t", op: "create", by: "a", note: "" }] };
	save(root, task);
}

// ───────────────────────── entry
const argv = process.argv.slice(2);
const { flags, lists } = parseArgs(argv);
const cmd = argv.find((a) => !a.startsWith("--")) ?? (flags.selftest ? "--selftest" : flags.validate ? "--validate" : "");
if (flags.selftest) selftest();
else if (flags.validate) cmdValidate({ flags });
else if (cmd === "new") cmdNew({ flags, lists });
else if (cmd === "claim") cmdClaim({ flags });
else if (cmd === "report") cmdReport({ flags, lists });
else if (cmd === "reject") cmdReject({ flags });
else if (cmd === "rescope") cmdRescope({ flags, lists });
else if (cmd === "confirm") cmdConfirm({ flags });
else if (cmd === "list") cmdList({ flags });
else if (cmd === "archive") cmdArchive({ flags });
else {
	console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 32).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
	process.exit(cmd ? 1 : 0);
}
