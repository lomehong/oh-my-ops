/** @ops-pi/core —— 运维原子能力（L1）：不依赖 omp / Yuyi / 任何宿主（方案 §7.1） */
export { OpsError } from "./errors.ts";
export type { OpsErrorCode } from "./errors.ts";
export { ShellExec } from "./exec.ts";
export type { ExecResult, ExecOptions } from "./exec.ts";
export { FileOps } from "./files.ts";
export type { FileReadOptions } from "./files.ts";
export { ProcessManager, parsePsOutput } from "./process.ts";
export type { ProcessInfo, ProcessListOptions } from "./process.ts";
export { criticalReason } from "./content-guard.ts";
export { LogCollector } from "./log.ts";
export type { TailResult, JournalctlResult, GrepResult } from "./log.ts";
export { loadTargetPolicy, DefaultDenyPolicy } from "./policy.ts";
export type { TargetPolicy, TargetRule, PolicyFile, PolicyRequest } from "./policy.ts";
export { loadTokenStore, StaticTokenStore } from "./tokens.ts";
export type { ApprovalToken, TokenFile, TokenStore } from "./tokens.ts";
export { READ, WRITE, EXEC, byAction, tierOf, needsOwnerAuth, createAuthorizedExec } from "./approvals.ts";
export type { Tier, ApprovalDecision } from "./approvals.ts";
