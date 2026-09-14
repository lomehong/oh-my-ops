#!/usr/bin/env node
/**
 * omo 品牌补丁 v2：让 omp 产物的品牌显示支持环境变量覆盖（增量、逐面幂等）。
 *
 * 覆盖面（均为 TUI 用户可见字符串，锚点已对 dist/cli.js 实测）：
 *   A. APP_NAME   "omp" → ${OMO_APP_NAME||omp}        （横幅标题/进程名/shell 提示符/resume 提示）
 *   B. USER_AGENT `omp/<v>` → `${APP_NAME}/<v>`
 *   C. 欢迎框 tips 整段 → ${OMO_TIPS||原文}            （welcome box Tip 行）
 *   D. 插件面板命令提示 "omp plugin install …"（2 处）→ ${OMO_BIN||APP_NAME}（可执行命令名）
 *   E. 更新提示与示例 "omp update"/"--check"/"--canary"（4 处）→ ${OMO_BIN||APP_NAME}
 *   F. 模型错误提示 Run "omp models" to see（3 处）→ ${OMO_BIN||APP_NAME}
 *   G. 审批摘要 "omp wants to run <tool>" → APP_NAME（品牌展示，非命令）
 * 语义：D/E/F 是用户要照着敲的命令 → 用 CLI 名（omo 包装器导出 OMO_BIN=omo）；
 *       G 是身份展示 → 用品牌名。
 *
 * 不动（有意）：PREVIEW_TITLE（调试预览组件）、settings-schema 描述、
 *   CLI 子命令 examples 全量数组、compress 文档注释——可见度低或含结构性风险。
 *
 * 幂等：每个面独立检测；重复执行安全。omp 升级重写 cli.js 后重跑即可。
 * 权限：产物 root 所有，需 sudo 执行本脚本（install.sh 无权限时会提示本命令）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argTarget = process.argv[process.argv.indexOf("--target") + 1];
const CANDIDATES = argTarget ? [argTarget]
	: [
		"/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
		`${process.env.HOME}/.ops-pi/omp/dist/cli.js`,
	];

const targets = CANDIDATES.filter(existsSync);
for (const file of targets) {
	let src = readFileSync(file, "utf8");
	const before = src;
	const log = [];
	// --require-hits：任一面锚点缺失（⚠）即构建失败——防上游漂移导致品牌静默漏面
	const REQUIRE_HITS = process.argv.includes("--require-hits");
	let V; // APP_NAME 的压缩变量名

	// ── A. APP_NAME ──
	const vm = src.match(/var ([\w$]+)=\(process\.env\.OMO_APP_NAME\|\|"omp"\)/);
	if (vm) {
		V = vm[1];
		log.push("⏭ A. APP_NAME（已打）");
	} else {
		const m = src.match(/var ([\w$]+)="omp",([\w$]+)="\.omp"/);
		if (!m) {
			console.error(`[patch-omp-brand] ✗ ${file}：未找到 APP_NAME 锚点（omp 大版本变更？停止以免写坏）`);
			process.exitCode = 1;
			continue;
		}
		V = m[1];
		src = src.replace(/var ([\w$]+)="omp",([\w$]+)="\.omp"/, `var $1=(process.env.OMO_APP_NAME||"omp"),$2=".omp"`);
		log.push("✓ A. APP_NAME → ${OMO_APP_NAME||omp}");
	}
	// 命令提示用 CLI 名（可执行），品牌展示用 APP_NAME
	const BIN = `(process.env.OMO_BIN||${V})`;

	// ── B. USER_AGENT ──
	if (src.includes("=`${" + V + "}/")) {
		log.push("⏭ B. USER_AGENT（已打）");
	} else {
		const ua = new RegExp("([\\w$]+)=`omp\\/\\$\\{([\\w$]+)\\}`");
		if (ua.test(src)) {
			src = src.replace(ua, `$1=\`\${${V}}/$2\``);
			log.push("✓ B. USER_AGENT → ${APP_NAME}/<version>");
		} else log.push("⚠ B. USER_AGENT 锚点未找到，跳过");
	}

	// ── C. 欢迎框 tips → OMO_TIPS 可覆盖 ──
	if (src.includes("OMO_TIPS")) {
		log.push("⏭ C. tips 覆盖（已打）");
	} else {
		const tipsRe = /([\w$]+)="((?:[^"\\]|\\.)*Tired of typing(?:[^"\\]|\\.)*esc cancels(?:[^"\\]|\\.)*)"/;
		const tips = src.match(tipsRe);
		if (tips) {
			src = src.replace(tipsRe, `$1=(process.env.OMO_TIPS??"$2")`);
			log.push("✓ C. 欢迎框 tips → ${OMO_TIPS||原文}");
		} else log.push("⚠ C. tips 锚点未找到，跳过");
	}

	// ── D. 插件面板命令提示 ──
	const panels = [
		[`"Install npm plugins:        omp plugin install <package>"`, "`Install npm plugins:        ${" + BIN + "} plugin install <package>`"],
		[`"Install marketplace plugins: omp plugin install <name>@<marketplace>"`, "`Install marketplace plugins: ${" + BIN + "} plugin install <name>@<marketplace>`"],
	];
	let dHit = 0;
	for (const [from, to] of panels) {
		if (src.includes(from)) { src = src.split(from).join(to); dHit++; }
	}
	if (dHit === panels.length) log.push("✓ D. 插件面板提示（2 处）");
	else {
		const dFrom = "${" + V + "} plugin install";
		const dTo = "${" + BIN + "} plugin install";
		if (src.includes(dFrom)) { src = src.split(dFrom).join(dTo); log.push("↺ D. 插件面板提示升级为 OMO_BIN 形态"); }
		else log.push("⏭ D. 插件面板提示（已打）");
	}

	// ── E. omp update 字面量（通知命令 + examples 数组）──
	const upRe = /"omp update([^"]*)"/g;
	const upHits = (src.match(upRe) || []).length;
	if (upHits > 0) {
		src = src.replace(upRe, "`${" + BIN + "} update$1`");
		log.push(`✓ E. update 提示（${upHits} 处）`);
	} else {
		// v2 旧形态升级（字符串替换，避免 $ 变量名在正则里被当锚点）
		const eFrom = "`${" + V + "} update";
		const eTo = "`${" + BIN + "} update";
		if (src.includes(eFrom)) { src = src.split(eFrom).join(eTo); log.push("↺ E. update 提示升级为 OMO_BIN 形态"); }
		else log.push("⏭ E. update 提示（已打）");
	}

	// ── F. 模型错误提示 ──
	const fFrom = `Run "omp models" to see`;
	const fTo = `Run "\${${BIN}} models" to see`;
	const fHits = src.split(fFrom).length - 1;
	if (fHits > 0) { src = src.split(fFrom).join(fTo); log.push(`✓ F. 模型错误提示（${fHits} 处）`); }
	else {
		const fOld = `Run "\${${V}} models" to see`;
		if (src.includes(fOld)) { src = src.split(fOld).join(fTo); log.push("↺ F. 模型错误提示升级为 OMO_BIN 形态"); }
		else log.push("⏭ F. 模型错误提示（已打）");
	}

	// ── G. 审批摘要 ──
	const gFrom = "`omp wants to run ${";
	const gTo = "`${" + V + "} wants to run ${";
	if (src.includes(gFrom)) { src = src.split(gFrom).join(gTo); log.push("✓ G. 审批摘要"); }
	else if (src.includes(gTo)) log.push("⏭ G. 审批摘要（已打）");
	else log.push("⚠ G. 审批摘要锚点未找到，跳过");

	if (REQUIRE_HITS) {
		const missing = log.filter((l) => l.startsWith("⚠"));
		if (missing.length > 0) {
			console.error(`[patch-omp-brand] ✗ 品牌面锚点缺失（上游漂移，禁止带病出包）\n  ${missing.join("\n  ")}`);
			process.exit(1);
		}
	}

	if (src === before) {
		console.log(`[patch-omp-brand] ${file}\n  （全部已打，无改动）\n  ${log.join("\n  ")}`);
		continue;
	}
	writeFileSync(file, src);
	console.log(`[patch-omp-brand] ✓ ${file}\n  ${log.join("\n  ")}`);
}
