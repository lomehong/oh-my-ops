/** 模拟共载 Yuyi 适配器（仅注册 yuyi_* 前缀）——用于检测 ops_* 与 yuyi_* 不冲突 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "yuyi_test_tool",
		label: "Yuyi Test",
		description: "stub collision probe",
		parameters: { type: "object" } as unknown,
		execute: async () => ({ content: [{ type: "text", text: "yuyi-ok" }] }),
	});
}
