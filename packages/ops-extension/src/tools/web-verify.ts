import { READ } from "@ops-pi/core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalFn } from "../approvals.ts";
import { registerOpsTool } from "../approvals.ts";
import { assertAuthorized } from "../guards.ts";
import type { OpsContext } from "../context.ts";
import { verifyPage } from "../web/verify.ts";

/**
 * ops_web_verify —— 部署后用「真实无头浏览器」验证 web 系统（read-only：只访问与截图，不提交表单、不改远端）。
 *
 * 为什么需要它：部署完只有"服务起来了"（进程/端口/healthz）≠"页面真的能用"。
 * 本工具补上最后一环：真人式访问——导航、等待 SPA 渲染、断言标题/文本/选择器、
 * 采集控制台错误与失败请求、留证截图；SSO 场景可注入 cookie 复用登录态。
 *
 * 浏览器从哪来：CDP 端点（OMO_BROWSER_CDP，缺省 http://127.0.0.1:9222）。
 * 端点不可达时返回结构化指引（含 el7 机器可直接用的 docker 起法），不静默降级。
 */
export function registerWebVerifyTools(pi: ExtensionAPI, ctx: OpsContext, _approval: (name: string) => ApprovalFn): void {
	const z = pi.zod;
	registerOpsTool(pi, {
		name: "ops_web_verify",
		label: "Web Verify",
		loadMode: "essential",
		approval: READ,
		description:
			"用无头浏览器真实访问 URL 并验证：截图 + 断言（标题/文本/选择器，支持等待 SPA 渲染）+ 控制台错误 + 失败请求。" +
			"部署 web 系统后必须执行（这是交付与验收的唯一真相）；也用于排查'页面空白/跳转异常/接口 404'。" +
			"受保护页面可注入 cookie 复用登录态。需要无头浏览器 CDP 端点（OMO_BROWSER_CDP，缺省 127.0.0.1:9222）。",
		parameters: z.object({
			url: z.string().describe("要访问的 URL（含协议，如 http://127.0.0.1:5173/ 或 https://svc.internal/app）"),
			waitFor: z.string().optional().describe("等待该 CSS 选择器出现（SPA 必需，如 '#rows'）"),
			waitForText: z.string().optional().describe("等待页面文本包含该串"),
			expectTitle: z.string().optional().describe("期望标题包含"),
			expectText: z.string().optional().describe("期望页面可见文本包含"),
			expectSelector: z.string().optional().describe("期望该 CSS 选择器存在"),
			cookies: z
				.array(z.object({ name: z.string(), value: z.string(), domain: z.string().optional(), path: z.string().optional(), url: z.string().optional() }))
				.optional()
				.describe("登录态注入（SSO/受保护页面）"),
			screenshotPath: z.string().optional().describe("截图落盘路径（缺省 /tmp/omo-web-verify-<时间戳>.png）"),
			timeoutMs: z.number().optional().describe("超时（毫秒，缺省 20000）"),
			failOnErrors: z.boolean().optional().describe("为 true 时要求无控制台错误/失败请求才判 ok（缺省 false：报错仅作为证据列出）"),
			cdpUrl: z.string().optional().describe("CDP 端点地址（覆盖 OMO_BROWSER_CDP）"),
		}),
		async execute(_toolCallId, params, _signal) {
			const p = params as Record<string, unknown>;
			const authz = assertAuthorized("ops_web_verify", p, ctx.authzView);
			const verdict = await verifyPage({
				url: String(p.url ?? ""),
				waitFor: p.waitFor === undefined ? undefined : String(p.waitFor),
				waitForText: p.waitForText === undefined ? undefined : String(p.waitForText),
				expectTitle: p.expectTitle === undefined ? undefined : String(p.expectTitle),
				expectText: p.expectText === undefined ? undefined : String(p.expectText),
				expectSelector: p.expectSelector === undefined ? undefined : String(p.expectSelector),
				cookies: Array.isArray(p.cookies) ? (p.cookies as { name: string; value: string; domain?: string; path?: string; url?: string }[]) : undefined,
				screenshotPath: p.screenshotPath === undefined ? undefined : String(p.screenshotPath),
				timeoutMs: p.timeoutMs === undefined ? undefined : Number(p.timeoutMs),
				failOnErrors: p.failOnErrors === true,
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }],
				details: { authz, ok: verdict.ok, assertions: verdict.assertions.length, failedRequests: verdict.failedRequests.length },
			};
		},
	});
}
