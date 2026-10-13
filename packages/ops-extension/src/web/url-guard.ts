/**
 * ops_web_verify 的出站目标校验（SSRF / 云元数据凭据窃取防护）。
 *
 * 背景：ops_web_verify 是 **read 档自动放行**工具，可导航到任意 URL。若 Agent 被诱导
 * （prompt injection：日志/页面内容里的「去访问 X」），可借本机浏览器内网可达性探测网络，
 * 最危险的是**云厂商元数据端点**——169.254.169.254 上挂着实例角色临时凭据，
 * 一次 GET 即可窃取 IAM 角色密钥。
 *
 * 取舍：不阻断内网地址本身。omo 是运维智能体，验证 10.x/172.16.x 上的内部 web 系统是**核心用例**
 * （工具描述本身举例 http://127.0.0.1:5173/）。一刀切封内网会让工具失去存在意义。
 * 因此只做两类精确阻断：
 *   1. 云元数据端点（含各厂商变体与 IPv6 等价地址）—— 无合法运维用途；
 *   2. 非 http/https 协议（file://、ftp:// 等）—— 浏览器可借以读本机文件。
 * 其余内网地址放行，但显式记录 note，让审计可见「本次验证访问的是内网目标」。
 */

/** 云元数据端点（IPv4 链路本地 + 厂商专用；IPv6 等价地址一并覆盖） */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
	"169.254.169.254", // AWS / Azure / GCP / OpenStack / 阿里云 / 腾讯云 通用
	"169.254.170.2", // AWS ECS 任务元数据
	"100.100.100.200", // 阿里云 ECS 元数据
	"192.0.0.192", // Oracle Cloud
	"fd00:ec2::254", // AWS IMDSv6
]);

/** 允许的协议：浏览器可达且对运维有意义 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export interface UrlGuardVerdict {
	allowed: boolean;
	/** 拒绝原因（allowed=false 时） */
	reason?: string;
	/** 放行但值得记录的提示（如目标为内网地址） */
	note?: string;
}

/** 私网/环回/链路本地判定（仅用于生成 note，不阻断） */
function isInternalHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h === "::1" || h === "0.0.0.0") return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (v4 === null) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if (a === 127 || a === 10 || a === 0) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true; // 链路本地（含元数据）
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10（含阿里元数据）
	return false;
}

/**
 * 校验 ops_web_verify 的目标 URL。
 * @throws OpsError("POLICY_DENIED") 命中元数据端点或非法协议
 */
export function assertVerifiableUrl(raw: string): UrlGuardVerdict {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`[INTERNAL] 非法 URL：'${raw}'（需含协议，如 http://127.0.0.1:8080/）`);
	}
	if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
		throw new Error(
			`[ERR_POLICY] 拒绝非 http(s) 协议：'${u.protocol}'（file:// 等可借浏览器读取本机文件，不属运维验证用途）`,
		);
	}
	const hostname = u.hostname.replace(/^\[|\]$/g, "");
	if (METADATA_HOSTS.has(hostname.toLowerCase())) {
		throw new Error(
			`[ERR_POLICY] 拒绝访问云元数据端点：${hostname}——该端点挂着实例角色的临时凭据，一次 GET 即可窃取 IAM 密钥，不属运维验证用途`,
		);
	}
	return isInternalHost(hostname)
		? { allowed: true, note: `目标为内网/环回地址（${hostname}）——内网 web 验证属预期用途，已记入审计` }
		: { allowed: true };
}