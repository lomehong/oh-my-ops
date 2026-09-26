import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileOps, LogCollector, ProcessManager } from "@ops-pi/core";
import {
	builtinRules,
	compileCustomRules,
	compileTermRules,
	configFromRaw,
	createMaskMap,
	extractAliasEntries,
	finalizeConfig,
	isPlaceholderShape,
	loadStateSync,
	MAX_CUSTOM_RULES,
	maskDeep,
	maskText,
	MappingStore,
	restoreAll,
	restoreDeep,
	restoreText,
	saveStateSync,
} from "@ops-pi/core";
import { registerOpsTool } from "../src/approvals.ts";
import { loadRedactConfig, redactPaths, restoreToolInput, setupRedact } from "../src/redact.ts";
import { OpsContext } from "../src/context.ts";
import { registerReadOnlyTools } from "../src/tools/read-only.ts";
import { expectSecret0600 } from "./runtime/perm-mode.ts";

/**
 * 脱敏移植守卫：语义与 `omp-redact-extension.js`（移植自 dsh-redact）一致。
 *
 * ⚠️ 两条写测试的纪律（真机踩过）：
 *  1. 固定值**一律运行时拼接**——源码里若出现"看起来像秘密"的字面量，会被本机启用的脱敏插件改写；
 *  2. **期望值也一律运行时计算**（`ph(code,n)` 生成占位符），不要在断言里写占位符字面量——同样会被改写。
 */

const AT = String.fromCharCode(64);
const ph = (code: string, n: number): string => "[[".concat(code, "_", String(n), "]]");

/* ── 运行时构造的固定值 ── */
const secretA = "sk" + "-" + "a".repeat(24);
const secretB = "sk" + "-" + "z".repeat(24);
const bearerTok = "tok".repeat(8);
const assignVal = "pw".repeat(6);
const pemBody = "MII" + "E".repeat(24);
const pemBlock = "-----BEGIN ".concat("PRIVATE KEY-----", "\n", pemBody, "\n-----END ", "PRIVATE KEY-----");
const jwt = ["eyJ" + "a".repeat(12), "b".repeat(14), "c".repeat(14)].join(".");
const phone = "139" + "0000" + "1111";
const email = "alice" + AT + "example" + ".com";
const plainDigitRun = "9".repeat(19); // 非 Luhn ⇒ 不应脱敏

function luhnValid(length: number): string {
	const isLuhn = (s: string): boolean => {
		let sum = 0;
		let double = false;
		for (let i = s.length - 1; i >= 0; i--) {
			let d = Number(s[i]);
			if (double) {
				d *= 2;
				if (d > 9) d -= 9;
			}
			sum += d;
			double = !double;
		}
		return sum % 10 === 0;
	};
	const body = "4111".padEnd(length - 1, "3").slice(0, length - 1);
	for (let d = 0; d <= 9; d++) {
		const candidate = body + String(d);
		if (isLuhn(candidate)) return candidate;
	}
	throw new Error("无法构造 Luhn 有效值");
}

function validId18(): string {
	const body = "11010519491231002";
	const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
	const check = "10X98765432";
	let sum = 0;
	for (let i = 0; i < 17; i++) sum += Number(body[i]) * weights[i]!;
	return body + check[sum % 11]!;
}

const CATS = { secret: true, id: true, bank: true, phone: true, email: true };
const rules = () => finalizeConfig({ enabled: true, restore: true, categories: CATS, customRules: [], aliases: [] }, []).rules;

describe("脱敏引擎：内置五类（含校验位/Luhn）", () => {
	test("★ 密钥类：直连键 / Bearer 只掩码令牌 / 赋值式只掩码值 / PEM 块 / JWT", () => {
		const a = maskText("key=".concat(secretA), rules(), createMaskMap());
		expect(a.text).toBe("key=" + ph("SECRET", 1)); // 键名保留 ⇒ 模型仍可读结构
		expect(a.hits[0]!.code).toBe("SECRET");

		const b = maskText("Authorization: Bearer ".concat(bearerTok), rules(), createMaskMap());
		expect(b.text).toBe("Authorization: Bearer " + ph("SECRET", 1)); // 前缀保留

		const c = maskText("password=".concat(assignVal), rules(), createMaskMap());
		expect(c.text).toBe("password=" + ph("SECRET", 1));

		expect(maskText(pemBlock, rules(), createMaskMap()).text).toBe(ph("SECRET", 1));
		expect(maskText("t=".concat(jwt), rules(), createMaskMap()).text).toBe("t=" + ph("SECRET", 1));
	});

	test("★ 同一真实值全程同一占位符；还原可回到原文", () => {
		const map = createMaskMap();
		expect(maskText("a=".concat(secretA), rules(), map).text).toBe("a=" + ph("SECRET", 1));
		expect(maskText("b=".concat(secretA), rules(), map).text).toBe("b=" + ph("SECRET", 1)); // 同值同号
		expect(maskText("c=".concat(secretB), rules(), map).text).toBe("c=" + ph("SECRET", 2));
		expect(restoreAll("c=" + ph("SECRET", 2) + " a=" + ph("SECRET", 1), map.reverse)).toBe("c=" + secretB + " a=" + secretA);
	});

	test("★ 证件号：校验位正确才脱敏（错一位不脱敏）；银行卡走 Luhn", () => {
		const good = validId18();
		expect(maskText("id=".concat(good), rules(), createMaskMap()).text).toBe("id=" + ph("ID", 1));
		const bad = good.slice(0, 17) + (good[17] === "0" ? "1" : "0");
		expect(maskText("id=".concat(bad), rules(), createMaskMap()).text).toBe("id=" + bad);

		const card = luhnValid(16);
		expect(maskText("card=".concat(card), rules(), createMaskMap()).text).toBe("card=" + ph("BANK", 1));
		expect(maskText("raw=".concat(plainDigitRun), rules(), createMaskMap()).text).toBe("raw=" + plainDigitRun);
	});

	test("手机号与邮箱；10 位数字不误伤", () => {
		expect(maskText("tel=".concat(phone), rules(), createMaskMap()).text).toBe("tel=" + ph("TEL", 1));
		expect(maskText("mail=".concat(email), rules(), createMaskMap()).text).toBe("mail=" + ph("EMAIL", 1));
		const tenDigits = phone.slice(0, 10);
		expect(maskText("x=".concat(tenDigits), rules(), createMaskMap()).text).toBe("x=" + tenDigits);
	});

	test("★ 重叠按优先级取先到者（整段只掩码一次）", () => {
		const mixed = "sk" + "-" + "1".repeat(30);
		const r = maskText(mixed, rules(), createMaskMap());
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0]!.code).toBe("SECRET");
	});

	test("分类开关：关闭即不脱敏，其余类别不受影响", () => {
		const off = finalizeConfig({ enabled: true, restore: true, categories: { ...CATS, phone: false }, customRules: [], aliases: [] }, []);
		expect(maskText("tel=".concat(phone), off.rules, createMaskMap()).text).toBe("tel=" + phone);
		expect(maskText("mail=".concat(email), off.rules, createMaskMap()).text).toBe("mail=" + ph("EMAIL", 1));
	});
});

describe("脱敏引擎：自定义规则与别名", () => {
	test("自定义规则：编码派生、非法正则、超上限", () => {
		const ok = compileCustomRules([{ name: "WO", pattern: "WO-" + "\\d{6}" }]);
		expect(ok.errors).toEqual([]);
		expect(ok.rules[0]!.code).toBe("WO");
		const bad = compileCustomRules([{ name: "x", pattern: "(" }]);
		expect(bad.rules).toEqual([]);
		expect(bad.errors.some((e) => e.includes("正则非法"))).toBe(true);
		const many = compileCustomRules(Array.from({ length: MAX_CUSTOM_RULES + 2 }, (_, i) => ({ name: `r${i}`, pattern: `X${i}` })));
		expect(many.rules).toHaveLength(MAX_CUSTOM_RULES);
		expect(many.errors.some((e) => e.includes("上限"))).toBe(true);
	});

	test("★ 别名：替换为固定词、可反向还原、长词优先", () => {
		const short = "核心库";
		const long = short + "备库";
		const { rules: termRules, errors } = compileTermRules([
			{ term: short, replacement: "CORE" },
			{ term: long, replacement: "COREDR" },
		]);
		expect(errors).toEqual([]);
		const map = createMaskMap();
		const out = maskText(`连 ${long} 与 ${short}`, termRules, map);
		expect(out.text).toContain("COREDR");
		expect(restoreAll(out.text, map.reverse, extractAliasEntries(map.reverse))).toBe(`连 ${long} 与 ${short}`);
	});

	test("别名校验：同词 / 占位符形态 / 超长 各自报错", () => {
		const r = compileTermRules([
			{ term: "aa", replacement: "aa" },
			{ term: ph("TEL", 1), replacement: "X" },
			{ term: "x".repeat(70), replacement: "Y" },
		]);
		expect(r.rules).toEqual([]);
		expect(r.errors.some((e) => e.includes("相同"))).toBe(true);
		expect(r.errors.some((e) => e.includes("占位符形态"))).toBe(true);
		expect(r.errors.some((e) => e.includes("上限"))).toBe(true);
	});
});

describe("脱敏引擎：深遍历与账本", () => {
	test("★ 深遍历惰性克隆：未变更子树保持原引用；还原可逆", () => {
		const map = createMaskMap();
		const untouched = { keep: "nothing sensitive" };
		const payload = { a: "k=".concat(secretA), b: [untouched, "tel=".concat(phone)], n: 7, nil: null };
		const masked = maskDeep(payload, rules(), map) as { value: typeof payload; changed: boolean; hits: unknown[] };
		expect(masked.changed).toBe(true);
		expect(masked.value.a).toBe("k=" + ph("SECRET", 1));
		expect(masked.value.b[1]).toBe("tel=" + ph("TEL", 1));
		expect(masked.value.b[0]).toBe(untouched);
		expect(masked.hits).toHaveLength(2);

		const back = restoreDeep(masked.value, map.reverse) as { value: typeof payload; changed: boolean };
		expect(back.value.a).toBe("k=" + secretA);
		expect(back.value.b[1]).toBe("tel=" + phone);
	});

	test("无命中：changed=false 且保持原引用（零干预）", () => {
		const payload = { x: "plain text", y: [1, 2] };
		const r = maskDeep(payload, rules(), createMaskMap()) as { value: unknown; changed: boolean };
		expect(r.changed).toBe(false);
		expect(r.value).toBe(payload);
	});

	test("账本：重启后编号接着涨（不撞号），老值保持同号", () => {
		const store = new MappingStore();
		maskText("k=".concat(secretA), rules(), store.sessionMap("s1", 1));
		const store2 = new MappingStore();
		store2.loadPersistable(store.toPersistable(), 2);
		const map2 = store2.sessionMap("s1", 3);
		expect(maskText("k=".concat(secretA), rules(), map2).text).toBe("k=" + ph("SECRET", 1));
		expect(maskText("k=".concat(secretB), rules(), map2).text).toBe("k=" + ph("SECRET", 2));
	});

	test("账本：TTL 与上限裁剪", () => {
		const store = new MappingStore();
		store.sessionMap("old", 0);
		store.sessionMap("new", 10_000);
		expect(store.prune(10_000, 5_000)).toBe(1);
		for (let i = 0; i < 5; i++) store.sessionMap(`s${i}`, 20_000 + i);
		store.prune(20_010, 10_000_000, 3);
		expect(store.sessionCount()).toBe(3);
	});
});

describe("脱敏：状态落盘与配置", () => {
	test("★ 原子写 + 0600；无临时残留；损坏文件按全新状态处理", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-redact-"));
		try {
			const file = path.join(dir, "nested", "state.json");
			const state = { version: 1 as const, maps: { sessions: { s1: { lastActive: 1, reverse: { [ph("TEL", 1)]: phone } } } } };
			expect(saveStateSync(file, state).ok).toBe(true);
			expectSecret0600(file);
			expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"))).toEqual([]);
			expect(loadStateSync(file)).toEqual(state);
			fs.writeFileSync(file, "{ broken");
			expect(loadStateSync(file)).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("配置：缺省全开；覆盖生效；非法项告警；文件缺失走缺省", () => {
		const def = configFromRaw(undefined);
		expect(def.enabled && def.restore).toBe(true);
		expect(def.rules.length).toBeGreaterThan(0);

		const custom = configFromRaw({
			enabled: false,
			categories: { phone: false },
			customRules: [{ name: "X", pattern: "XY\\d+" }],
			aliases: [{ term: "T", replacement: "R" }],
		});
		expect(custom.enabled).toBe(false);
		expect(custom.rules.some((r) => r.code === "ALIAS")).toBe(true);
		expect(configFromRaw({ customRules: "not-array" }).warnings.some((w) => w.includes("customRules"))).toBe(true);
		expect(loadRedactConfig(path.join(os.tmpdir(), "no-such-config.json")).enabled).toBe(true);
	});
});

/* ── 钩子装配（fake host） ── */

interface Handlers {
	session_start?: (event: unknown, ctx: unknown) => unknown;
	before_provider_request?: (event: { type: "before_provider_request"; payload: unknown }) => unknown;
}

function zodStub(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	chain.describe = () => chain;
	chain.optional = () => chain;
	return chain;
}

function fakeHost(): {
	pi: { on: (name: string, handler: unknown) => void; registerTool: (d: unknown) => void; zod: Record<string, unknown>; tools: Map<string, unknown> };
	handlers: Handlers;
} {
	const handlers: Handlers = {};
	const tools = new Map<string, unknown>();
	return {
		pi: {
			on: (name: string, handler: unknown) => void ((handlers as Record<string, unknown>)[name] = handler),
			registerTool: (d: unknown) => void tools.set((d as { name: string }).name, d),
			zod: { object: () => zodStub(), string: () => zodStub(), number: () => zodStub(), array: () => zodStub(), boolean: () => zodStub(), enum: () => zodStub() },
			tools,
		},
		handlers,
	};
}

function makeCtx(omo: string): OpsContext {
	return new OpsContext(
		{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json") },
		{ policyPath: path.join(omo, "policy.json"), tokenPath: path.join(omo, "approval-token.json"), configPath: path.join(omo, "proj", ".ops-pi", "config.json") },
		{
			files: new FileOps(),
			process: new ProcessManager(),
			log: new LogCollector(),
			shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0, truncated: false }) } as never,
		},
	);
}

describe("脱敏装配：出站掩码 + 工具层还原（保证生效）", () => {
	test("★ 出站把真实值换成占位符；工具层把占位符还原为真实值；未启用零干预", async () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-redact-wire-"));
		try {
			const host = fakeHost();
			const r = setupRedact(host.pi as never, makeCtx(omo), {} as NodeJS.ProcessEnv);
			expect(r.config.enabled).toBe(true);
			expect(host.handlers.before_provider_request).toBeDefined();
			host.handlers.session_start?.({}, { sessionManager: { sessionId: "sess-1" } });

			// 出站：模型侧看不到真实值
			const masked = host.handlers.before_provider_request?.({
				type: "before_provider_request",
				payload: { c: "tel=".concat(phone) },
			}) as { c: string };
			expect(masked.c).toBe("tel=" + ph("TEL", 1));

			// 入站（工具层）：占位符 → 真实值
			expect(restoreToolInput({ command: "echo " + ph("TEL", 1) })).toEqual({ command: "echo " + phone });

			// 端到端：经 registerOpsTool 注册的工具，执行前自动还原
			const seen: unknown[] = [];
			registerOpsTool(host.pi as never, {
				name: "ops_probe_restore",
				label: "probe",
				description: "probe",
				loadMode: "essential",
				approval: "read",
				parameters: {},
				execute: async (_id: string, params: unknown) => {
					seen.push(params);
					return { content: [] } as never;
				},
			} as never);
			await (host.pi.tools.get("ops_probe_restore") as { execute: (id: string, p: unknown, s: undefined, u: undefined, c: unknown) => Promise<unknown> }).execute(
				"t1",
				{ command: "echo " + ph("TEL", 1) },
				undefined,
				undefined,
				undefined,
			);
			expect(seen).toEqual([{ command: "echo " + phone }]);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ enabled=false：不掩码、还原为 no-op", () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-redact-off-"));
		try {
			const cfgPath = redactPaths(omo).config;
			fs.mkdirSync(path.dirname(cfgPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false }), { mode: 0o600 });
			const host = fakeHost();
			setupRedact(host.pi as never, makeCtx(omo), {} as NodeJS.ProcessEnv);
			host.handlers.session_start?.({}, { sessionManager: { sessionId: "s" } });
			const p = { c: "tel=".concat(phone) };
			expect(host.handlers.before_provider_request?.({ type: "before_provider_request", payload: p })).toBeUndefined();
			const input = { command: "echo " + ph("TEL", 1) };
			expect(restoreToolInput(input)).toEqual(input);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("★ 账本落在 omo 私有 HOME 内，且被 PathGuard 拒绝（含真实敏感值）", async () => {
		const omo = fs.mkdtempSync(path.join(os.tmpdir(), "omo-redact-guard-"));
		try {
			const paths = redactPaths(omo);
			expect(paths.state.startsWith(path.join(omo, "home", ".omp", "redact"))).toBe(true);
			fs.mkdirSync(path.dirname(paths.state), { recursive: true, mode: 0o700 });
			fs.writeFileSync(paths.state, JSON.stringify({ version: 1, maps: { sessions: {} } }), { mode: 0o600 });

			const host = fakeHost();
			registerReadOnlyTools(host.pi as never, makeCtx(omo));
			const tool = host.pi.tools.get("ops_file_read") as { execute: (id: string, p: unknown) => Promise<unknown> };
			await expect(tool.execute("p1", { path: paths.state })).rejects.toThrow(/机密根/);
		} finally {
			fs.rmSync(omo, { recursive: true, force: true });
		}
	});

	test("占位符工具函数与默认配置", () => {
		expect(isPlaceholderShape(ph("TEL", 1))).toBe(true);
		expect(isPlaceholderShape(ph("tel", 1))).toBe(false);
		expect(isPlaceholderShape(ph("TEL", 1) + " extra")).toBe(false);
		const reverse = new Map([[ph("TEL", 1), phone]]);
		expect(restoreText("a " + ph("TEL", 1) + " b " + ph("TEL", 9), reverse)).toBe("a " + phone + " b " + ph("TEL", 9));
		expect(builtinRules(CATS).length).toBeGreaterThanOrEqual(5);
		expect(maskText("plain", rules(), createMaskMap()).hits).toEqual([]);
	});
});
