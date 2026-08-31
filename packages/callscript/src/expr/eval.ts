import type * as acorn from "acorn";
import { ExprError, FORBIDDEN_PROPS, parseExpr } from "./parse";

interface EvalCtx {
	nodes: number;
	maxNodes: number;
	depth: number;
}

type Scope = {
	vars: Map<string, unknown>;
	parent?: Scope;
};

const MAX_DEPTH = 200;

const SAFE_MATH = Object.freeze({
	abs: Math.abs,
	ceil: Math.ceil,
	floor: Math.floor,
	round: Math.round,
	trunc: Math.trunc,
	min: Math.min,
	max: Math.max,
	sqrt: Math.sqrt,
	pow: Math.pow,
	sign: Math.sign,
	log: Math.log,
	log2: Math.log2,
	log10: Math.log10,
	E: Math.E,
	PI: Math.PI,
});

const SAFE_JSON = Object.freeze({
	parse: (s: unknown) => JSON.parse(String(s)) as unknown,
	stringify: (v: unknown, _r?: unknown, space?: unknown) =>
		JSON.stringify(v, null, space as string | number | undefined),
});

const SAFE_DATE = Object.freeze({
	now: () => Date.now(),
	parse: (s: unknown) => Date.parse(String(s)),
});

const SAFE_OBJECT = Object.freeze({
	keys: (o: unknown) => Object.keys(asRecord(o)),
	values: (o: unknown) => Object.values(asRecord(o)),
	entries: (o: unknown) => Object.entries(asRecord(o)),
	fromEntries: (e: unknown) => {
		if (!Array.isArray(e))
			throw new ExprError("Object.fromEntries expects an array", "type");
		return Object.fromEntries(e as [string, unknown][]);
	},
	/** Standard since ES2024 and THE group-by primitive scripts need. */
	groupBy: (items: unknown, fn: unknown) => {
		if (!Array.isArray(items))
			throw new ExprError("Object.groupBy expects an array", "type");
		// Re-plain the null-prototype result so property reads stay uniform.
		return { ...Object.groupBy(items, (x, i) => String(asFn(fn)(x, i))) };
	},
});

const SAFE_ARRAY = Object.freeze({
	isArray: Array.isArray,
	from: (v: unknown, fn?: unknown) => {
		if (!Array.isArray(v) && typeof v !== "string") {
			throw new ExprError(
				"Array.from supports arrays and strings only",
				"type",
			);
		}
		return fn
			? Array.from(
					v as unknown[],
					asFn(fn) as (x: unknown, i: number) => unknown,
				)
			: Array.from(v as unknown[]);
	},
});

/**
 * Base64 codec - providers speak it constantly (Gmail bodies are base64url,
 * sending mail means base64url-encoding an RFC822 string) and expressions
 * had no way to touch it. Pure string→string, no host authority.
 */
const SAFE_BASE64 = Object.freeze({
	encode: (v: unknown) => Buffer.from(String(v), "utf8").toString("base64"),
	decode: (v: unknown) => Buffer.from(String(v), "base64").toString("utf8"),
	/** URL-safe alphabet, no padding - what Gmail's `raw`/`body.data` use. */
	encodeUrl: (v: unknown) =>
		Buffer.from(String(v), "utf8").toString("base64url"),
	decodeUrl: (v: unknown) =>
		Buffer.from(String(v), "base64url").toString("utf8"),
});

const SAFE_NUMBER = Object.freeze({
	isFinite: Number.isFinite,
	isInteger: Number.isInteger,
	isNaN: Number.isNaN,
	parseFloat: Number.parseFloat,
	parseInt: Number.parseInt,
	MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
	MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
});

const NAMESPACES: Record<string, unknown> = {
	Math: SAFE_MATH,
	JSON: SAFE_JSON,
	Date: SAFE_DATE,
	Object: SAFE_OBJECT,
	Array: SAFE_ARRAY,
	Number: SAFE_NUMBER,
	Base64: SAFE_BASE64,
	undefined,
};

const NAMESPACE_VALUES = new Set<unknown>([
	SAFE_MATH,
	SAFE_JSON,
	SAFE_DATE,
	SAFE_OBJECT,
	SAFE_ARRAY,
	SAFE_NUMBER,
	SAFE_BASE64,
]);

/** Globals callable as bare functions: Number("3"), String(4), Boolean(x). */
const CALLABLE_GLOBALS: Record<string, (...args: unknown[]) => unknown> = {
	Number: (v: unknown) => Number(v),
	String: (v: unknown) => String(v),
	Boolean: (v: unknown) => Boolean(v),
};

/* --------------------------- method whitelists ---------------------------- */

function asFn(v: unknown): (...args: unknown[]) => unknown {
	if (typeof v !== "function") {
		throw new ExprError(
			"Expected a function argument (arrow function)",
			"type",
		);
	}
	return v as (...args: unknown[]) => unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) {
		throw new ExprError("Expected an object", "type");
	}
	return v as Record<string, unknown>;
}

// Full callback fidelity: (element, index, array) - models write standard
// idioms like `filter((x, i, a) => a.indexOf(x) === i)` and they must work.
const ARRAY_METHODS: Record<
	string,
	(a: unknown[], args: unknown[]) => unknown
> = {
	map: (a, [f]) => a.map((x, i, arr) => asFn(f)(x, i, arr)),
	filter: (a, [f]) => a.filter((x, i, arr) => asFn(f)(x, i, arr)),
	find: (a, [f]) => a.find((x, i, arr) => asFn(f)(x, i, arr)),
	findIndex: (a, [f]) => a.findIndex((x, i, arr) => asFn(f)(x, i, arr)),
	some: (a, [f]) => a.some((x, i, arr) => asFn(f)(x, i, arr)),
	every: (a, [f]) => a.every((x, i, arr) => asFn(f)(x, i, arr)),
	flatMap: (a, [f]) => a.flatMap((x, i, arr) => asFn(f)(x, i, arr)),
	reduce: (a, [f, ...init]) =>
		init.length > 0
			? a.reduce((acc, x, i, arr) => asFn(f)(acc, x, i, arr), init[0])
			: a.reduce((acc, x, i, arr) => asFn(f)(acc, x, i, arr)),
	includes: (a, [v]) => a.includes(v),
	indexOf: (a, [v]) => a.indexOf(v),
	slice: (a, [s, e]) => a.slice(s as number, e as number | undefined),
	concat: (a, args) => a.concat(...(args as unknown[][])),
	join: (a, [sep]) => a.join(sep as string | undefined),
	flat: (a, [d]) => a.flat((d as number) ?? 1),
	// Non-mutating variants: script data is immutable.
	sort: (a, [f]) =>
		[...a].sort(f === undefined ? undefined : (x, y) => Number(asFn(f)(x, y))),
	reverse: (a) => [...a].reverse(),
};

const STRING_METHODS: Record<string, (s: string, args: unknown[]) => unknown> =
	{
		includes: (s, [v]) => s.includes(String(v)),
		startsWith: (s, [v]) => s.startsWith(String(v)),
		endsWith: (s, [v]) => s.endsWith(String(v)),
		slice: (s, [a, b]) => s.slice(a as number, b as number | undefined),
		split: (s, [sep, n]) => s.split(String(sep), n as number | undefined),
		toLowerCase: (s) => s.toLowerCase(),
		toUpperCase: (s) => s.toUpperCase(),
		trim: (s) => s.trim(),
		replace: (s, [pat, rep]) => s.replace(String(pat), String(rep)),
		replaceAll: (s, [pat, rep]) => s.replaceAll(String(pat), String(rep)),
		padStart: (s, [n, fill]) =>
			s.padStart(n as number, fill as string | undefined),
		padEnd: (s, [n, fill]) => s.padEnd(n as number, fill as string | undefined),
		indexOf: (s, [v]) => s.indexOf(String(v)),
		charAt: (s, [i]) => s.charAt(i as number),
		repeat: (s, [n]) => {
			const count = n as number;
			if (count > 10_000)
				throw new ExprError("repeat count too large", "budget");
			return s.repeat(count);
		},
		localeCompare: (s, [v]) => s.localeCompare(String(v)),
	};

const NUMBER_METHODS: Record<string, (n: number, args: unknown[]) => unknown> =
	{
		toFixed: (n, [d]) => n.toFixed(d as number | undefined),
		toString: (n: number) => n.toString(),
	};

export interface EvalOptions {
	maxNodes?: number;
}

/**
 * Evaluate an expression against an environment of script values.
 * `env` keys are step ids (and forEach item bindings).
 */
export function evalExpr(
	source: string | acorn.Expression,
	env: Record<string, unknown>,
	options: EvalOptions = {},
): unknown {
	const node = typeof source === "string" ? parseExpr(source) : source;
	const ctx: EvalCtx = {
		nodes: 0,
		maxNodes: options.maxNodes ?? 100_000,
		depth: 0,
	};
	const root: Scope = { vars: new Map(Object.entries(env)) };
	return evaluate(node, root, ctx);
}

function budget(ctx: EvalCtx): void {
	if (++ctx.nodes > ctx.maxNodes) {
		throw new ExprError(
			`Expression exceeded its evaluation budget (${ctx.maxNodes} nodes)`,
			"budget",
		);
	}
}

function lookup(scope: Scope, name: string): unknown {
	let s: Scope | undefined = scope;
	while (s) {
		if (s.vars.has(name)) return s.vars.get(name);
		s = s.parent;
	}
	if (name in NAMESPACES) return NAMESPACES[name];
	throw new ExprError(`Unknown reference "${name}"`, "reference");
}

function readProp(obj: unknown, key: unknown): unknown {
	const name = typeof key === "number" ? key : String(key);
	if (typeof name === "string" && FORBIDDEN_PROPS.has(name)) {
		throw new ExprError(`Access to "${name}" is not allowed`, "forbidden");
	}
	if (obj === null || obj === undefined) {
		throw new ExprError(
			`Cannot read property "${String(name)}" of ${obj === null ? "null" : "undefined"}`,
			"type",
		);
	}
	if (typeof obj === "string") {
		if (name === "length") return obj.length;
		if (typeof name === "number" || /^\d+$/.test(name))
			return obj[Number(name)];
		return undefined;
	}
	if (Array.isArray(obj)) {
		if (name === "length") return obj.length;
		if (typeof name === "number" || /^\d+$/.test(String(name)))
			return obj[Number(name)];
		return undefined;
	}
	if (NAMESPACE_VALUES.has(obj)) {
		return (obj as Record<string, unknown>)[String(name)];
	}
	if (typeof obj === "object") {
		const rec = obj as Record<string, unknown>;
		return Object.hasOwn(rec, String(name)) ? rec[String(name)] : undefined;
	}
	return undefined;
}

function callMethod(obj: unknown, method: string, args: unknown[]): unknown {
	if (FORBIDDEN_PROPS.has(method)) {
		throw new ExprError(`Access to "${method}" is not allowed`, "forbidden");
	}
	// Frozen namespace functions (Math.min, JSON.parse, ...): trusted natives.
	if (NAMESPACE_VALUES.has(obj)) {
		const fn = (obj as Record<string, unknown>)[method];
		if (typeof fn !== "function") {
			throw new ExprError(`Unknown function "${method}"`, "reference");
		}
		return (fn as (...a: unknown[]) => unknown)(...args);
	}
	if (Array.isArray(obj)) {
		const impl = ARRAY_METHODS[method];
		if (!impl)
			throw new ExprError(
				`Array method "${method}" is not allowed`,
				"forbidden",
			);
		return impl(obj, args);
	}
	if (typeof obj === "string") {
		const impl = STRING_METHODS[method];
		if (!impl)
			throw new ExprError(
				`String method "${method}" is not allowed`,
				"forbidden",
			);
		return impl(obj, args);
	}
	if (typeof obj === "number") {
		const impl = NUMBER_METHODS[method];
		if (!impl)
			throw new ExprError(
				`Number method "${method}" is not allowed`,
				"forbidden",
			);
		return impl(obj, args);
	}
	throw new ExprError(
		`Cannot call method "${method}" on ${obj === null ? "null" : typeof obj}`,
		"type",
	);
}

function evaluate(node: acorn.AnyNode, scope: Scope, ctx: EvalCtx): unknown {
	budget(ctx);
	if (ctx.depth > MAX_DEPTH) {
		throw new ExprError("Expression nesting too deep", "budget");
	}
	switch (node.type) {
		case "Literal":
			return node.value;

		case "TemplateLiteral": {
			let out = "";
			for (let i = 0; i < node.quasis.length; i++) {
				out += node.quasis[i]?.value.cooked ?? "";
				if (i < node.expressions.length) {
					const expr = node.expressions[i];
					if (expr) out += toTemplateString(evaluate(expr, scope, ctx));
				}
			}
			return out;
		}

		case "Identifier":
			return lookup(scope, node.name);

		case "ArrayExpression": {
			const out: unknown[] = [];
			for (const el of node.elements) {
				if (!el) continue;
				if (el.type === "SpreadElement") {
					const v = evaluate(el.argument, scope, ctx);
					if (!Array.isArray(v)) {
						throw new ExprError("Spread expects an array", "type");
					}
					out.push(...v);
				} else {
					out.push(evaluate(el, scope, ctx));
				}
			}
			return out;
		}

		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties) {
				if (prop.type === "SpreadElement") {
					const v = evaluate(prop.argument, scope, ctx);
					if (v !== null && typeof v === "object" && !Array.isArray(v)) {
						for (const [k, val] of Object.entries(v)) {
							if (!FORBIDDEN_PROPS.has(k)) out[k] = val;
						}
					}
					continue;
				}
				let key: string;
				if (prop.computed) {
					key = String(evaluate(prop.key, scope, ctx));
				} else if (prop.key.type === "Identifier") {
					key = prop.key.name;
				} else if (prop.key.type === "Literal") {
					key = String(prop.key.value);
				} else {
					throw new ExprError("Unsupported object key", "syntax");
				}
				if (FORBIDDEN_PROPS.has(key)) {
					throw new ExprError(`Key "${key}" is not allowed`, "forbidden");
				}
				out[key] = evaluate(prop.value, scope, ctx);
			}
			return out;
		}

		case "MemberExpression": {
			const obj = evaluate(node.object, scope, ctx);
			if (node.optional && (obj === null || obj === undefined))
				return undefined;
			const key = node.computed
				? evaluate(node.property, scope, ctx)
				: (node.property as acorn.Identifier).name;
			return readProp(obj, key);
		}

		case "ChainExpression":
			return evaluateChain(node.expression, scope, ctx);

		case "ParenthesizedExpression":
			return evaluate(node.expression, scope, ctx);

		case "CallExpression":
			return evaluateCall(node, scope, ctx);

		case "ArrowFunctionExpression": {
			const params = node.params;
			const body = node.body as acorn.Expression;
			const captured = scope;
			return (...args: unknown[]) => {
				const vars = new Map<string, unknown>();
				params.forEach((param, i) => {
					bindPattern(param, args[i], vars);
				});
				ctx.depth++;
				try {
					return evaluate(body, { vars, parent: captured }, ctx);
				} finally {
					ctx.depth--;
				}
			};
		}

		case "ConditionalExpression":
			return evaluate(node.test, scope, ctx)
				? evaluate(node.consequent, scope, ctx)
				: evaluate(node.alternate, scope, ctx);

		case "LogicalExpression": {
			const left = evaluate(node.left, scope, ctx);
			if (node.operator === "&&")
				return left ? evaluate(node.right, scope, ctx) : left;
			if (node.operator === "||")
				return left ? left : evaluate(node.right, scope, ctx);
			return left ?? evaluate(node.right, scope, ctx); // "??" (whitelist guarantees)
		}

		case "BinaryExpression": {
			const l = evaluate(node.left as acorn.Expression, scope, ctx);
			const r = evaluate(node.right, scope, ctx);
			return binary(node.operator, l, r);
		}

		case "UnaryExpression": {
			const v = evaluate(node.argument, scope, ctx);
			switch (node.operator) {
				case "!":
					return !v;
				case "-":
					return -(v as number);
				case "+":
					return +(v as number);
				case "typeof":
					return typeof v;
				default:
					throw new ExprError("Unsupported unary operator", "syntax");
			}
		}

		default:
			throw new ExprError(`Unsupported syntax: ${node.type}`, "syntax");
	}
}

/** Optional chaining: short-circuit the whole chain when a link is nullish. */
function evaluateChain(
	node: acorn.Expression,
	scope: Scope,
	ctx: EvalCtx,
): unknown {
	try {
		return evaluate(node, scope, ctx);
	} catch (err) {
		if (err instanceof ChainShortCircuit) return undefined;
		throw err;
	}
}

class ChainShortCircuit extends Error {}

function evaluateCall(
	node: acorn.CallExpression,
	scope: Scope,
	ctx: EvalCtx,
): unknown {
	const callee = node.callee;
	const args = node.arguments.map((a) =>
		evaluate(a as acorn.Expression, scope, ctx),
	);

	if (callee.type === "Identifier") {
		const fn = CALLABLE_GLOBALS[callee.name];
		if (!fn) {
			throw new ExprError(
				`"${callee.name}" is not callable (only Number, String, Boolean)`,
				"reference",
			);
		}
		return fn(...args);
	}

	if (callee.type === "MemberExpression") {
		const obj = evaluate(callee.object, scope, ctx);
		if (
			(callee.optional || node.optional) &&
			(obj === null || obj === undefined)
		) {
			throw new ChainShortCircuit();
		}
		const method = callee.computed
			? String(evaluate(callee.property, scope, ctx))
			: (callee.property as acorn.Identifier).name;
		return callMethod(obj, method, args);
	}

	throw new ExprError("Unsupported call target", "syntax");
}

function bindPattern(
	pattern: acorn.Pattern,
	value: unknown,
	vars: Map<string, unknown>,
): void {
	switch (pattern.type) {
		case "Identifier":
			vars.set(pattern.name, value);
			return;
		case "ArrayPattern": {
			const arr = Array.isArray(value) ? value : [];
			pattern.elements.forEach((el, i) => {
				if (el && el.type === "Identifier") vars.set(el.name, arr[i]);
			});
			return;
		}
		case "ObjectPattern": {
			const rec =
				value !== null && typeof value === "object" && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: {};
			for (const prop of pattern.properties) {
				if (prop.type === "Property" && prop.value.type === "Identifier") {
					const name = prop.value.name;
					vars.set(name, Object.hasOwn(rec, name) ? rec[name] : undefined);
				}
			}
			return;
		}
		default:
			throw new ExprError("Unsupported arrow param pattern", "syntax");
	}
}

function toTemplateString(v: unknown): string {
	if (v === null || v === undefined) return String(v);
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function binary(op: string, l: unknown, r: unknown): unknown {
	switch (op) {
		case "+":
			return (l as number) + (r as number);
		case "-":
			return (l as number) - (r as number);
		case "*":
			return (l as number) * (r as number);
		case "/":
			return (l as number) / (r as number);
		case "%":
			return (l as number) % (r as number);
		case "**":
			return (l as number) ** (r as number);
		case "<":
			return (l as number) < (r as number);
		case ">":
			return (l as number) > (r as number);
		case "<=":
			return (l as number) <= (r as number);
		case ">=":
			return (l as number) >= (r as number);
		case "==":
			// biome-ignore lint/suspicious/noDoubleEquals: implements the script DSL's own == operator
			return l == r;
		case "!=":
			// biome-ignore lint/suspicious/noDoubleEquals: implements the script DSL's own != operator
			return l != r;
		case "===":
			return l === r;
		case "!==":
			return l !== r;
		default:
			throw new ExprError(`Unsupported operator ${op}`, "syntax");
	}
}
