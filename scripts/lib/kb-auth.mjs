/**
 * kb-auth.mjs —— /ui 管理后台认证（一期：yufu 网关信任模式）
 *
 * 架构（主人 2026-09-21 拍板）：kb 服务部署在 yufu 之后——
 *   - TLS 由 yufu 终结（服务无需自备 UI 证书）；
 *   - 认证与角色权限由 yufu 负责，服务只消费 yufu 注入的**身份头**；
 *   - 身份头缺失 ⇒ 401：直连服务端口绕过网关的管理平面不可达。
 *
 * 二期接 yufu 时只需扩展本文件（如改用 yufu 的 token 校验接口），路由层不感知。
 * 依赖纪律：零依赖（私有域无 monorepo node_modules）。
 */

/** 从请求提取 yufu 身份；缺失/空白 ⇒ null */
export function identityFromRequest(req, headerName) {
	const v = req.headers.get(headerName);
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t === "" ? null : t;
}

/** 401 响应（纯文本，中文提示；不含任何内部信息） */
export function unauthorizedResponse() {
	return new Response("401 需经 yufu 网关访问管理后台（缺少身份头）\n", {
		status: 401,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
