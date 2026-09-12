#!/usr/bin/env node
/**
 * omo 品牌补丁：让 omp 产物的 APP_NAME / USER_AGENT 支持环境变量覆盖。
 *
 * 原理：dist/cli.js 是 Bun 打包产物，pi-utils 的 APP_NAME 被内联为
 *   var <N>="omp",<D>=".omp"   （N/D 为压缩后的标识符名）
 *   <UA>=`omp/${<V>}`          （USER_AGENT，V 为版本常量名）
 * 补丁把两处改为读取 process.env.OMO_APP_NAME（缺省回退 "omp"）。
 * 结果：omo 导出 OMO_APP_NAME=OpsPi → 欢迎横幅显示 ` OpsPi v18.1.18 `；
 *       直接运行 omp 不设该变量 → 一切照旧，零影响。
 *
 * 幂等：已打补丁（含 OMO_APP_NAME 字样）则跳过。
 * 注意：omp 升级（npm i -g）会重写 cli.js，需重跑本脚本（install.sh 已挂接）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CANDIDATES = [
	"/usr/local/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
	`${process.env.HOME}/.omp/local/pi-coding-agent/dist/cli.js`,
];

const targets = CANDIDATES.filter(existsSync);
if (targets.length === 0) {
	console.log("[patch-omp-brand] 未找到 omp 产物，跳过（不影响安装）");
	process.exit(0);
}

for (const file of targets) {
	const src = readFileSync(file, "utf8");
	if (src.includes("OMO_APP_NAME")) {
		console.log(`[patch-omp-brand] 已打补丁，跳过：${file}`);
		continue;
	}

	// ① APP_NAME 声明：var <N>="omp",<D>=".omp"
	const m1 = src.match(/var ([\w$]+)="omp",([\w$]+)="\.omp"/);
	if (!m1) {
		console.error(`[patch-omp-brand] ✗ ${file}：未找到 APP_NAME 锚点（omp 版本变更？）`);
		process.exitCode = 1;
		continue;
	}
	const appNameVar = m1[1];
	let out = src.replace(
		/var ([\w$]+)="omp",([\w$]+)="\.omp"/,
		`var $1=(process.env.OMO_APP_NAME||"omp"),$2=".omp"`,
	);

	// ② USER_AGENT：<UA>=`omp/${<V>}`（紧跟 APP_NAME 声明之后同一模块内）
	const uaRe = new RegExp(`([\\w$]+)=\`omp\\/\\$\\{([\\w$]+)\\}\``);
	const m2 = out.match(uaRe);
	if (m2) {
		out = out.replace(uaRe, `$1=\`\${${appNameVar}}/$2\``);
	}

	writeFileSync(file, out);
	console.log(`[patch-omp-brand] ✓ ${file}`);
	console.log(`  APP_NAME → \${OMO_APP_NAME||omp}（var ${appNameVar}）`);
	if (m2) console.log(`  USER_AGENT → \${APP_NAME}/<version>`);
}
