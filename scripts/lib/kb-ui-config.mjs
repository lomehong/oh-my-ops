/**
 * kb-ui-config.mjs —— /ui 配置面的纯函数库（解析/校验/渲染/原子写/掩码）
 *
 * 零依赖纪律：与 lib/ 其它模块同等——服务被装到私有域 `~/.omo-kb/service/`，那里没有
 * monorepo 的 node_modules（真机 `Cannot find module` 事故），因此只用 node 内置模块。
 *
 * 契约（方案 docs/designs/omo-kb-web-ui-design.md §4）：
 *   - UI 可写键走白名单（UI_CONFIG_KEYS），白名单外整单拒绝；
 *   - 写盘原子（tmp+mv，0600，保留一代 .bak）；
 *   - 一切给浏览器的视图不得含秘密（管理员凭据键只回「已配置/未配置」）。
 */
import * as fs from "node:fs";

/** UI 可写键白名单：key → 展示名 + 校验器（返回 true 或失败原因） */
export const UI_CONFIG_KEYS = {
	OMO_KB_API: { label: "Gitea API", validate: (v) => /^https?:\/\/\S+$/.test(v) || "需为 http(s) URL" },
	OMO_KB_REPO: { label: "仓库（owner/name）", validate: (v) => /^[^/\s]+\/[^/\s]+$/.test(v) || "需为 owner/name" },
	OMO_KB_TEAM: { label: "团队名", validate: (v) => /^[^\s]+$/.test(v) || "非空且无空白" },
	OMO_KB_PERMISSION: { label: "权限", validate: (v) => ["read", "write", "admin"].includes(v) || "read|write|admin" },
	OMO_KB_GRANT: { label: "授权方式", validate: (v) => ["team", "collab", "none"].includes(v) || "team|collab|none" },
	OMO_KB_HOST: { label: "监听地址", validate: (v) => /^[^\s]+$/.test(v) || "非空且无空白" },
	OMO_KB_PORT: { label: "端口", validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535) || "1-65535 整数" },
	OMO_KB_UI: { label: "管理后台开关", validate: (v) => ["on", "off"].includes(v) || "on|off" },
	OMO_KB_UI_IDENTITY_HEADER: { label: "身份头键名（yufu）", validate: (v) => /^[A-Za-z0-9-]+$/.test(v) || "仅字母/数字/连字符" },
	OMO_KB_TLS_CERT: { label: "TLS 证书路径", validate: (v) => v === "" || fs.existsSync(v) || "文件不存在" },
	OMO_KB_TLS_KEY: { label: "TLS 私钥路径", validate: (v) => v === "" || fs.existsSync(v) || "文件不存在" },
};

/** 管理员凭据类键（只回「已配置/未配置」，绝不回值） */
export const SECRET_KEYS = new Set(["OMO_KB_ADMIN_MODE", "OMO_KB_ADMIN_USER", "OMO_KB_ADMIN_TOKEN_FILE", "OMO_KB_ADMIN_PASSWORD_FILE", "OMO_KB_ADMIN_PW_FILE"]);

/** 解析 KEY=VALUE 文本：保留行序与注释，values 取最后出现的值 */
export function parseConfigEnv(text) {
	const lines = String(text ?? "").split("\n");
	const values = {};
	for (const line of lines) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (m) values[m[1]] = m[2];
	}
	return { lines, values };
}

/** 便捷读取：文件不存在/不可读返回 undefined */
export function readConfigEnv(file) {
	try {
		return parseConfigEnv(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * 校验待写入值：
 * - 白名单外的键 ⇒ 整单拒绝（防把 admin 令牌等从 UI 侧写进配置）；
 * - files=false 时跳过 TLS 路径存在性检查（沙箱/测试环境）。
 */
export function validateValues(values, { files = true } = {}) {
	const errors = [];
	const obj = values ?? {};
	const unknown = Object.keys(obj).filter((k) => !(k in UI_CONFIG_KEYS));
	if (unknown.length > 0) errors.push({ key: unknown.join(","), reason: "非白名单键，拒绝整单" });
	for (const [key, meta] of Object.entries(UI_CONFIG_KEYS)) {
		if (obj[key] === undefined) continue;
		const v = String(obj[key]);
		if (files === false && (key === "OMO_KB_TLS_CERT" || key === "OMO_KB_TLS_KEY")) continue;
		const verdict = meta.validate(v);
		if (verdict !== true) errors.push({ key, reason: String(verdict) });
	}
	return { ok: errors.length === 0, errors };
}

/** 用新值渲染配置文本：既有键原地替换（保留行序与注释），新键追加文末 */
export function renderConfigEnv(parsed, newValues) {
	const wanted = { ...newValues };
	const out = parsed.lines.map((line) => {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (m && wanted[m[1]] !== undefined) {
			const v = String(wanted[m[1]]);
			delete wanted[m[1]];
			return `${m[1]}=${v}`;
		}
		return line;
	});
	for (const [k, v] of Object.entries(wanted)) out.push(`${k}=${v}`);
	return `${out.join("\n").replace(/\n*$/, "\n")}`;
}

/** 原子写（tmp+mv，0600，保留一代 .bak） */
export function writeConfigEnvAtomic(file, text) {
	const tmp = `${file}.tmp.${process.pid}`;
	fs.writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
	try {
		fs.copyFileSync(file, `${file}.bak`);
	} catch {
		// 首次无原文件，忽略
	}
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 尽力而为
	}
	return { ok: true, bakPath: `${file}.bak` };
}

/** .bak 恢复（预检失败回滚用）；成功 true */
export function restoreConfigBackup(file) {
	try {
		fs.copyFileSync(`${file}.bak`, file);
		fs.chmodSync(file, 0o600);
		return true;
	} catch {
		return false;
	}
}

/** 掩码视图：白名单键出原值（均非秘密）；凭据类键只出「已配置/未配置」；其余键不展示 */
export function maskConfigForUi(values) {
	const out = {};
	for (const [k, v] of Object.entries(values ?? {})) {
		if (k in UI_CONFIG_KEYS) out[k] = v;
		else if (SECRET_KEYS.has(k) || /TOKEN|PASSWORD|SECRET/i.test(k)) out[k] = String(v ?? "").trim() === "" ? "（未配置）" : "（已配置，不回显）";
		else out[k] = "（不通过 UI 展示）";
	}
	return out;
}
