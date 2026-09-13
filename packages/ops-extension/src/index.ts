export { default } from "./extension.ts";
export { assertPlatformAtLoad, assertPlatformAtSessionStart, platformChecks } from "./platform.ts";
export { registerOpsTool } from "./approvals.ts";
export { assertToolRegistryIntegrity, onToolCall, assertAuthorized } from "./guards.ts";
export { setupHooks } from "./hooks.ts";
export { buildomoSystemPrompt, registerOpsCommands } from "./commands.ts";
