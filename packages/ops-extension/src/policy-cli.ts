import { ReloadableTargetPolicy, loadTokenStore } from "@ops-pi/core";
import { explainAuthorization, formatExplain, formatLint, parseExplainArgs, runPolicyLint } from "./policy-explain.ts";

/**
 * `omo policy` 子命令入口（宿主外运行：bun policy-cli.ts …）。
 * 与会话内 /ops-policy 共用 policy-explain.ts；路径取 OMO_POLICY_PATH / OMO_TOKEN_PATH（omo 启动器已导出），
 * 也可用 --policy / --token 覆盖。退出码：lint 有错误 → 1；explain 拒绝 → 2；用法错误 → 64。
 * 不依赖宿主 API（approvals.ts 对 @oh-my-pi 只有 type 导入），不做任何写操作。
 */
export interface CliIo {
	out(text: string): void;
	err(text: string): void;
}

const USAGE = [
	"用法：",
	"  omo policy lint                         静态检查 policy.json / approval-token.json",
	"  omo policy explain <ops_工具> [k=v …]    授权 dry-run（如 explain ops_service service=nginx action=restart）",
	"选项：--policy <path> --token <path>（缺省读 OMO_POLICY_PATH / OMO_TOKEN_PATH）",
].join("\n");

export function runPolicyCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): number {
	const args = [...argv];
	let policyPath = env.OMO_POLICY_PATH;
	let tokenPath = env.OMO_TOKEN_PATH;
	for (let i = 0; i < args.length; ) {
		if (args[i] === "--policy" && args[i + 1] !== undefined) {
			policyPath = args[i + 1];
			args.splice(i, 2);
		} else if (args[i] === "--token" && args[i + 1] !== undefined) {
			tokenPath = args[i + 1];
			args.splice(i, 2);
		} else i++;
	}
	if (!policyPath || !tokenPath) {
		io.err("✗ 缺少策略/令牌路径：请通过 omo 启动器运行，或显式传 --policy / --token");
		return 64;
	}
	const [sub, ...rest] = args;
	if (sub === undefined || sub === "lint") {
		const report = runPolicyLint(policyPath, tokenPath);
		io.out(formatLint(report));
		return report.summary.errors > 0 ? 1 : 0;
	}
	if (sub === "explain") {
		const parsed = parseExplainArgs(rest.join(" "));
		if (!parsed.ok) {
			io.err(`✗ ${parsed.reason}`);
			return 64;
		}
		const view = { targetPolicy: new ReloadableTargetPolicy(policyPath), tokens: loadTokenStore(tokenPath) };
		const report = explainAuthorization(view, parsed.tool, parsed.input);
		io.out(formatExplain(report));
		if (!report.registered || report.requestError !== undefined) return 64;
		if (report.contentGuard) return 2;
		return report.verdict !== undefined && !report.verdict.allowed ? 2 : 0;
	}
	io.err(`✗ 未知子命令：${sub}\n${USAGE}`);
	return 64;
}

if (import.meta.main) {
	process.exitCode = runPolicyCli(process.argv.slice(2), process.env, {
		out: (t) => console.log(t),
		err: (t) => console.error(t),
	});
}
