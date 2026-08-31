export const isInternalName = (name: string): boolean => /(^|\.)\$/.test(name);

export const isWildcardName = (name: string): boolean =>
	/^[^*.\s]+(\.[^*.\s]+)*\.\*$/.test(name);

export type WildcardMatch = {
	/** The registered pattern that matched, e.g. "github.*". */
	pattern: string;
	/** The suffix after the matched prefix, e.g. "listIssues" or "issues.list". */
	op: string;
};

/**
 * Build a matcher over a name list; non-pattern names are ignored. A call
 * containing "*" never matches (patterns are not themselves callable), and
 * the matched `op` is never empty. Longest prefix wins.
 */
export function createWildcardMatcher(
	names: Iterable<string>,
): (call: string) => WildcardMatch | undefined {
	const prefixes = [...names]
		.filter(isWildcardName)
		.map((pattern) => ({ pattern, prefix: pattern.slice(0, -1) })) // keep the trailing "."
		.sort((a, b) => b.prefix.length - a.prefix.length);
	if (prefixes.length === 0) return () => undefined;
	return (call) => {
		if (call.includes("*")) return undefined;
		for (const { pattern, prefix } of prefixes) {
			if (call.length > prefix.length && call.startsWith(prefix)) {
				return { pattern, op: call.slice(prefix.length) };
			}
		}
		return undefined;
	};
}
