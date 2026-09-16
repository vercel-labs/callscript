import * as acorn from "acorn";

export type ExprErrorCode =
	| "parse"
	| "syntax"
	| "reference"
	| "type"
	| "budget"
	| "forbidden";

export class ExprError extends Error {
	readonly code: ExprErrorCode;

	constructor(message: string, code: ExprErrorCode) {
		super(message);
		this.name = "ExprError";
		this.code = code;
	}
}

export const FORBIDDEN_PROPS = new Set([
	"constructor",
	"__proto__",
	"prototype",
]);

/** Namespaced globals available to every expression. */
export const GLOBAL_NAMES = new Set([
	"Math",
	"JSON",
	"Date",
	"Object",
	"Array",
	"Number",
	"String",
	"Boolean",
	"Base64",
	"undefined",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"encodeURIComponent",
	"decodeURIComponent",
	"encodeURI",
	"decodeURI",
]);

const ALLOWED_BINARY = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"<",
	">",
	"<=",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"in",
]);

const ALLOWED_LOGICAL = new Set(["&&", "||", "??"]);
const ALLOWED_UNARY = new Set(["!", "-", "+", "typeof"]);

export function parseExpr(source: string): acorn.Expression {
	let node: acorn.Expression;
	try {
		node = acorn.parseExpressionAt(source, 0, {
			ecmaVersion: 2022,
			sourceType: "script",
			// Keep `(expr)` spans intact so the whole-string-consumed check below
			// works for parenthesized object literals like `({ a: 1 })`.
			preserveParens: true,
		}) as acorn.Expression;
	} catch (err) {
		throw new ExprError(
			`Invalid expression: ${err instanceof Error ? err.message : String(err)}`,
			"parse",
		);
	}
	// Ensure the whole string was consumed (reject `a; b`, trailing junk).
	const rest = source.slice(node.end).trim();
	if (rest.length > 0) {
		throw new ExprError(
			`Unexpected trailing input after expression: "${rest.slice(0, 20)}"`,
			"parse",
		);
	}
	validateNode(node);
	return node;
}

function fail(node: acorn.AnyNode, what?: string): never {
	throw new ExprError(
		`Unsupported syntax: ${what ?? node.type}. Expressions are a pure subset of JS (no statements, assignment, new, regex, or await).`,
		"syntax",
	);
}

function validateProp(name: string, _node: acorn.AnyNode): void {
	if (FORBIDDEN_PROPS.has(name)) {
		throw new ExprError(`Access to "${name}" is not allowed`, "forbidden");
	}
}

/** Recursively enforce the syntax whitelist. */
export function validateNode(node: acorn.AnyNode): void {
	switch (node.type) {
		case "Literal": {
			if ("regex" in node && node.regex) fail(node, "regex literal");
			return;
		}
		case "TemplateLiteral":
			for (const e of node.expressions) validateNode(e);
			return;
		case "Identifier":
			return;
		case "ArrayExpression":
			for (const el of node.elements) {
				if (!el) fail(node, "array holes");
				validateNode(el);
			}
			return;
		case "ObjectExpression":
			for (const prop of node.properties) {
				if (prop.type === "SpreadElement") {
					validateNode(prop.argument);
					continue;
				}
				if (prop.kind !== "init") fail(prop, "getter/setter");
				if (prop.computed) {
					validateNode(prop.key);
				} else if (prop.key.type === "Identifier") {
					validateProp(prop.key.name, prop);
				}
				validateNode(prop.value);
			}
			return;
		case "SpreadElement":
			validateNode(node.argument);
			return;
		case "MemberExpression": {
			validateNode(node.object);
			if (node.computed) {
				validateNode(node.property);
			} else if (node.property.type === "Identifier") {
				validateProp(node.property.name, node);
			} else {
				fail(node.property);
			}
			return;
		}
		case "ChainExpression":
		case "ParenthesizedExpression":
			validateNode(node.expression);
			return;
		case "CallExpression": {
			const callee = node.callee;
			if (callee.type === "MemberExpression") {
				validateNode(callee);
			} else if (callee.type === "Identifier") {
				// Callable globals only (Number("3") etc.) — checked at eval time too.
			} else {
				fail(callee, "computed callee");
			}
			for (const arg of node.arguments) {
				// `Math.max(...xs)` spreads a script array - pure, so allowed.
				validateNode(arg.type === "SpreadElement" ? arg.argument : arg);
			}
			return;
		}
		case "ArrowFunctionExpression": {
			if (node.async) fail(node, "async arrow function");
			if (node.body.type === "BlockStatement") {
				fail(node, "arrow function with a block body (use an expression body)");
			}
			for (const param of node.params) validatePattern(param);
			validateNode(node.body);
			return;
		}
		case "ConditionalExpression":
			validateNode(node.test);
			validateNode(node.consequent);
			validateNode(node.alternate);
			return;
		case "LogicalExpression":
			if (!ALLOWED_LOGICAL.has(node.operator)) fail(node, node.operator);
			validateNode(node.left);
			validateNode(node.right);
			return;
		case "BinaryExpression":
			if (!ALLOWED_BINARY.has(node.operator)) fail(node, node.operator);
			if (node.left.type === "PrivateIdentifier") fail(node.left);
			validateNode(node.left);
			validateNode(node.right);
			return;
		case "UnaryExpression":
			if (!ALLOWED_UNARY.has(node.operator)) fail(node, node.operator);
			validateNode(node.argument);
			return;
		case "NewExpression": {
			// Ban `new` with the alternative for what the author reached for,
			// not just the rule, so the retry converges in one round trip.
			const what =
				node.callee.type === "Identifier" ? node.callee.name : undefined;
			switch (what) {
				case "Date":
					throw new ExprError(
						"Unsupported syntax: new Date. Compare timestamps instead: " +
							"Date.parse(s) for a date string, Date.now() for the current time.",
						"syntax",
					);
				case "RegExp":
					throw new ExprError(
						"Unsupported syntax: new RegExp. Match with s.includes(...), " +
							"s.startsWith(...), s.endsWith(...), or s.toLowerCase() === ...",
						"syntax",
					);
				case "Set":
				case "Map":
					// `new Set(...)` is THE dedupe idiom.
					throw new ExprError(
						`Unsupported syntax: new ${what}. Dedupe with xs.filter((x, i, a) => a.indexOf(x) === i); ` +
							"group with Object.groupBy(xs, x => x.key).",
						"syntax",
					);
				case "Error":
					throw new ExprError(
						"Unsupported syntax: new Error. A failed call already fails the run; " +
							"to end it yourself, guard: if (cond) return { ... }",
						"syntax",
					);
				default:
					throw new ExprError(
						`Unsupported syntax: new${what ? ` ${what}` : ""}. Build plain objects and arrays with literals; ` +
							"dedupe with xs.filter((x, i, a) => a.indexOf(x) === i).",
						"syntax",
					);
			}
		}
		default:
			fail(node);
	}
}

function validatePattern(pattern: acorn.Pattern): void {
	switch (pattern.type) {
		case "Identifier":
			return;
		case "ArrayPattern":
			for (const el of pattern.elements) {
				if (!el) continue;
				if (el.type !== "Identifier") {
					fail(el, "nested destructuring in arrow params");
				}
			}
			return;
		case "ObjectPattern":
			for (const prop of pattern.properties) {
				if (prop.type !== "Property" || prop.value.type !== "Identifier") {
					fail(prop, "nested destructuring in arrow params");
				}
				validateProp(prop.value.name, prop);
			}
			return;
		default:
			fail(pattern, "arrow param pattern");
	}
}

/** Names bound by an arrow-function parameter pattern. */
export function patternNames(pattern: acorn.Pattern): string[] {
	switch (pattern.type) {
		case "Identifier":
			return [pattern.name];
		case "ArrayPattern":
			return pattern.elements.flatMap((el) => (el ? patternNames(el) : []));
		case "ObjectPattern":
			return pattern.properties.flatMap((prop) =>
				prop.type === "Property"
					? patternNames(prop.value as acorn.Pattern)
					: patternNames(prop.argument),
			);
		case "AssignmentPattern":
			return patternNames(pattern.left);
		case "RestElement":
			return patternNames(pattern.argument);
		default:
			return [];
	}
}

/**
 * Free identifiers referenced by an expression (excluding globals and
 * arrow-bound params). These must resolve to earlier step ids.
 */
export function collectRefs(node: acorn.AnyNode): Set<string> {
	const refs = new Set<string>();
	walk(node, new Set());
	return refs;

	function walk(n: acorn.AnyNode, bound: Set<string>): void {
		switch (n.type) {
			case "Identifier":
				if (!bound.has(n.name) && !GLOBAL_NAMES.has(n.name)) refs.add(n.name);
				return;
			case "Literal":
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
					else {
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
				// Identifier callees are globals (Number, String, Boolean) — not refs.
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
}

/**
 * Static reads of the `$errors` namespace: `$errors.close` (or
 * `$errors["close"]`) selects step "close"'s recorded failure - UCAN's
 * `await/error` branch, spelled with a name. `names` is every step id so
 * selected; `dynamic` flags any OTHER use of `$errors` (bare reference,
 * computed access) - rejected, because the schedule needs the dependency
 * to be static.
 */
export function errorSelectors(node: acorn.AnyNode): {
	names: Set<string>;
	dynamic: boolean;
} {
	const names = new Set<string>();
	let dynamic = false;
	walk(node, new Set());
	return { names, dynamic };

	function walk(n: acorn.AnyNode, bound: Set<string>): void {
		switch (n.type) {
			case "Identifier":
				if (n.name === "$errors" && !bound.has(n.name)) dynamic = true;
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
					else {
						if (prop.computed) walk(prop.key, bound);
						walk(prop.value, bound);
					}
				}
				return;
			case "SpreadElement":
				walk(n.argument, bound);
				return;
			case "MemberExpression": {
				if (
					n.object.type === "Identifier" &&
					n.object.name === "$errors" &&
					!bound.has("$errors")
				) {
					if (!n.computed && n.property.type === "Identifier") {
						names.add(n.property.name);
					} else if (
						n.computed &&
						n.property.type === "Literal" &&
						typeof n.property.value === "string"
					) {
						names.add(n.property.value);
					} else {
						dynamic = true;
						if (n.computed) walk(n.property, bound);
					}
					return;
				}
				walk(n.object, bound);
				if (n.computed) walk(n.property, bound);
				return;
			}
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
}
