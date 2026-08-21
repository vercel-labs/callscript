import { type EvalOptions, evalExpr } from "./expr/eval";
import { collectRefs, parseExpr } from "./expr/parse";
import type { JsonValue } from "./types";

export function isExprString(value: string): boolean {
	return value.startsWith("=") && !value.startsWith("==");
}

export function exprSource(value: string): string {
	return value.slice(1);
}

export function resolveArgs(
	args: JsonValue | undefined,
	env: Record<string, unknown>,
	options: EvalOptions = {},
): unknown {
	if (args === undefined) return undefined;
	return walk(args);

	function walk(value: JsonValue): unknown {
		if (typeof value === "string") {
			if (isExprString(value)) return evalExpr(exprSource(value), env, options);
			if (value.startsWith("==")) return value.slice(1);
			return value;
		}
		if (Array.isArray(value)) return value.map(walk);
		if (value !== null && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = walk(v);
			return out;
		}
		return value;
	}
}

/** All expression strings embedded in an args value (for static validation). */
export function collectArgExprs(args: JsonValue | undefined): string[] {
	const out: string[] = [];
	if (args === undefined) return out;
	walk(args);
	return out;

	function walk(value: JsonValue): void {
		if (typeof value === "string") {
			if (isExprString(value)) out.push(exprSource(value));
			return;
		}
		if (Array.isArray(value)) for (const v of value) walk(v);
		else if (value !== null && typeof value === "object") {
			for (const v of Object.values(value)) walk(v);
		}
	}
}

/** Free references used by an args value. */
export function collectArgRefs(args: JsonValue | undefined): Set<string> {
	const refs = new Set<string>();
	for (const src of collectArgExprs(args)) {
		for (const ref of collectRefs(parseExpr(src))) refs.add(ref);
	}
	return refs;
}
