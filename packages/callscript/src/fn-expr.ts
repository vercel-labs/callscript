/**
 * JS-native expression AUTHORING. Expression fields (`let`, `if`,
 * `return`, `each`, `output`, and `=expr` arg positions) accept a
 * real arrow at the door:
 *
 *   { id: "stale", let: ({ issues }) => issues.filter(i => i.stale) }
 *
 * The arrow is TRANSPILED, never executed: its source is parsed with the
 * same grammar as expression strings, its body becomes the stored
 * expression, and the script stays 100% inert data - serializable,
 * hashable, renderable, model-emittable.
 *
 * The parameter is the scope contract, enforced: the body may read ONLY
 * what the destructuring names (plus the frozen globals). A captured
 * outer variable - the thing a native closure cannot be prevented from
 * reaching - is a free name here, and free names are REJECTED at the
 * door. That is what makes this JS-like form as sound as the strings.
 */
import type * as acorn from "acorn";
import { collectRefs, ExprError, parseExpr, patternNames } from "./expr/parse";
import { ScriptValidationError } from "./validate";

type AnyFn = (scope?: any) => unknown;

const reject = (path: string, message: string): never => {
	throw new ScriptValidationError([{ path, message }]);
};

/**
 * Transpile one authoring arrow into an expression string. The rules:
 * expression body only, at most one parameter, and that parameter a plain
 * shorthand object destructuring naming EVERYTHING the body reads
 * (`input` and `$calls` included - the parameter is the whole contract).
 */
export function fnToExpr(fn: AnyFn, path: string): string {
	const source = fn.toString();
	let arrow: ReturnType<typeof parseExpr>;
	try {
		arrow = parseExpr(source);
	} catch (err) {
		return reject(
			path,
			`this function is not expressible as a script expression - ` +
				`${err instanceof ExprError ? err.message : String(err)}`,
		);
	}
	if (arrow.type !== "ArrowFunctionExpression") {
		return reject(
			path,
			"use an arrow function with an expression body: ({ issues }) => issues.length",
		);
	}
	if (arrow.params.length > 1) {
		return reject(
			path,
			"one parameter only - destructure every name the body reads: ({ issues, input }) => ...",
		);
	}
	const param = arrow.params[0];
	// local binding -> env name. The KEY is the env name, the value a local
	// alias - `({ issues: list }) => list` reads `issues`. Transpilers
	// produce this shape too (esbuild renames shadowed bindings), so
	// aliases must round-trip: alias references rewrite back to the key.
	const aliases = new Map<string, string>();
	if (param !== undefined) {
		if (param.type !== "ObjectPattern") {
			return reject(
				path,
				"destructure the names you read - ({ issues }) => issues.length, " +
					"not (c) => c.issues.length (the parameter IS the scope contract)",
			);
		}
		for (const prop of param.properties) {
			if (
				prop.type !== "Property" ||
				prop.computed ||
				prop.value.type !== "Identifier"
			) {
				return reject(
					path,
					"plain destructuring only - ({ issues }) => ..., no defaults, nesting, or rest",
				);
			}
			const envName =
				prop.key.type === "Identifier"
					? prop.key.name
					: prop.key.type === "Literal"
						? String(prop.key.value)
						: undefined;
			if (envName === undefined) {
				return reject(path, "destructuring keys must be plain names");
			}
			if (envName !== prop.value.name) aliases.set(prop.value.name, envName);
		}
	}
	// Free names of the WHOLE arrow are names the parameter did not bind:
	// captured variables, or in-scope names the author forgot to declare.
	// Either way they are rejected - a script expression reads only what
	// its parameter names, and a captured value never crosses.
	const free = collectRefs(arrow);
	if (free.size > 0) {
		const names = [...free].join(", ");
		return reject(
			path,
			`"${names}" is not in the expression's scope - destructure it ` +
				`(({ ${names} }) => ...) if it is a step/session name, or pipe it ` +
				"through `input`, a step, or a var if it is a captured variable " +
				"(closures never cross into a script)",
		);
	}
	// The body IS the expression. Parenthesized object bodies keep their
	// parens (preserveParens), so the slice re-parses as-is.
	const body = source.slice(arrow.body.start, arrow.body.end);
	if (aliases.size === 0) return body;
	return renameIdentifiers(
		body,
		arrow.body as acorn.AnyNode,
		arrow.body.start,
		aliases,
	);
}

/**
 * Rewrite alias references in the body source back to their env names,
 * scope-aware: a name rebound by an inner arrow parameter is left alone,
 * and a shorthand property expands (`{ list }` -> `{ list: issues }`) so
 * the KEY the author wrote survives the rename.
 */
export const renameIdentifiers = (
	body: string,
	root: acorn.AnyNode,
	offset: number,
	aliases: Map<string, string>,
): string => {
	const edits: { start: number; end: number; text: string }[] = [];
	walk(root, new Set());
	return edits
		.sort((a, b) => b.start - a.start)
		.reduce(
			(out, edit) =>
				out.slice(0, edit.start - offset) +
				edit.text +
				out.slice(edit.end - offset),
			body,
		);

	function ref(node: acorn.Identifier, bound: Set<string>, shorthand: boolean) {
		const envName = aliases.get(node.name);
		if (envName === undefined || bound.has(node.name)) return;
		edits.push({
			start: node.start,
			end: node.end,
			text: shorthand ? `${node.name}: ${envName}` : envName,
		});
	}

	function walk(n: acorn.AnyNode, bound: Set<string>): void {
		switch (n.type) {
			case "Identifier":
				ref(n, bound, false);
				return;
			case "TemplateLiteral":
				for (const e of n.expressions) walk(e, bound);
				return;
			case "ArrayExpression":
				for (const el of n.elements) if (el) walk(el, bound);
				return;
			case "ObjectExpression":
				for (const prop of n.properties) {
					if (prop.type === "SpreadElement") walk(prop.argument, bound);
					else if (prop.shorthand && prop.value.type === "Identifier") {
						ref(prop.value, bound, true);
					} else {
						if (prop.computed) walk(prop.key, bound);
						walk(prop.value, bound);
					}
				}
				return;
			case "SpreadElement":
				walk(n.argument, bound);
				return;
			case "MemberExpression":
				walk(n.object, bound);
				if (n.computed) walk(n.property, bound);
				return;
			case "ChainExpression":
			case "ParenthesizedExpression":
				walk(n.expression, bound);
				return;
			case "CallExpression":
				if (n.callee.type === "MemberExpression") walk(n.callee, bound);
				for (const arg of n.arguments) walk(arg as acorn.AnyNode, bound);
				return;
			case "ArrowFunctionExpression": {
				const inner = new Set(bound);
				for (const p of n.params)
					for (const name of patternNames(p)) inner.add(name);
				walk(n.body as acorn.AnyNode, inner);
				return;
			}
			case "ConditionalExpression":
				walk(n.test, bound);
				walk(n.consequent, bound);
				walk(n.alternate, bound);
				return;
			case "LogicalExpression":
			case "BinaryExpression":
				walk(n.left as acorn.AnyNode, bound);
				walk(n.right, bound);
				return;
			case "UnaryExpression":
				walk(n.argument, bound);
				return;
			default:
				return;
		}
	}
};

const isFunction = (value: unknown): value is AnyFn =>
	typeof value === "function";

/** Deep-resolve arrows inside `args`: a function anywhere becomes an
 * `=expr` string, everything else passes through untouched. */
const resolveArgFns = (value: unknown, path: string): unknown => {
	if (isFunction(value)) return `=${fnToExpr(value, path)}`;
	if (Array.isArray(value)) {
		return value.map((entry, index) =>
			resolveArgFns(entry, `${path}[${index}]`),
		);
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				resolveArgFns(entry, `${path}.${key}`),
			]),
		);
	}
	return value;
};

/**
 * Normalize a raw script-ish object: every arrow in an expression
 * position transpiles to its string form. Pure - the input is never
 * mutated - and idempotent: strings pass through untouched, so validated
 * and re-validated scripts cost nothing extra. Non-script shapes pass
 * through for validateScript to report properly.
 */
export function resolveFnExprs<T>(input: T): T {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return input;
	}
	const raw = input as Record<string, unknown>;
	if (!Array.isArray(raw.steps)) return input;

	const resolveStep = (step: unknown, path: string): unknown => {
		if (typeof step !== "object" || step === null) return step;
		const out = { ...(step as Record<string, unknown>) };
		for (const field of ["if", "return", "let", "each"] as const) {
			if (isFunction(out[field])) {
				out[field] = fnToExpr(out[field] as AnyFn, `${path}.${field}`);
			}
		}
		if ("args" in out) out.args = resolveArgFns(out.args, `${path}.args`);
		return out;
	};

	return {
		...raw,
		steps: raw.steps.map((step, index) => resolveStep(step, `steps[${index}]`)),
		...(isFunction(raw.output)
			? { output: fnToExpr(raw.output as AnyFn, "output") }
			: {}),
	} as T;
}
