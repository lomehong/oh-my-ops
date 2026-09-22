/** kb-lint.mjs 类型契约（零依赖引擎的实现见同名 .mjs） */
export declare function parseDomainsYml(text: string): {
	domains: string[] | undefined;
	fallback: string;
	rootAllowlist: string[];
};
export declare function bigrams(text: string): Set<string>;
export declare function jaccard(a: string, b: string): number;
export declare interface LintViolation {
	path: string;
	rule: string;
	reason: string;
}
export declare function lintStructure(p: {
	changedPaths?: string[];
	contents?: { path: string; text: string }[];
	domainsText?: string;
}): { hard: LintViolation[]; warnings: string[]; touchedDomains: Set<string> };
export declare function stripEntryHeader(text: string): string;
export declare function sectionsOf(text: string): { heading: string; body: string }[];
export declare function lintSimilarity(p: {
	contents?: { path: string; text: string }[];
	existing?: { domain: string; path: string; text: string }[];
	thresholds?: { block: number; warn: number };
}): { hard: LintViolation[]; warnings: string[]; pairs: { a: string; b: string; score: number }[] };
export declare function buildComment(p: { mode: string; hard: LintViolation[]; warnings: string[] }): string;
export declare function verifyHmac(secret: string, body: string, signatureHex: string): boolean;
