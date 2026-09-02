/**
 * The JS SURFACE: a callscript authored as plain JavaScript statements,
 * COMPILED (never executed) into the same inert Script IR every other
 * door produces. The model writes the language it already knows:
 *
 *   // close stale issues
 *   const issues = await github.listIssues({ repo: "api" });
 *   const stale = issues.filter(i => i.stale);
 *   if (stale.length === 0) return { closed: 0 };
 *   const closed = await Promise.all(
 *     stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
 *   return { count: closed.length };
 *
 * and the parser desugars statement by statement - `const x = await
 * tool(...)` is a call step, `const x = expr` a let step, `if (c) return v`
 * a guard, `Promise.all(list.map(...))` a bounded fan-out, `try/catch` the
 * error branch. What is stored, hashed, validated, and executed is ALWAYS
 * the JSON plan, so nothing about inertness, static checking, bounds, or
 * resumability changes - this file is a frontend, not a runtime.
 *
 * Anything outside the recognized grammar is rejected with the message
 * that names the callscript spelling, so the up-front instruction stays
 * tiny and the retry loop teaches the rest.
 */
import * as acorn from "acorn";
import { collectArgExprs } from "./args";
import { collectRefs, ExprError, parseExpr, patternNames } from "./expr/parse";
import { renameIdentifiers } from "./fn-expr";
import type {
	CallStep,
	JsonValue,
	LetStep,
	ReturnStep,
	Script,
	Step,
} from "./types";
import { type ScriptIssue, ScriptValidationError } from "./validate";
import { createWildcardMatcher, isInternalName } from "./wildcard";

export interface ParseJsOptions {
	/**
	 * Mounted tool names. Optional - the grammar is registry-independent -
	 * but required for DETACHED calls (`const job = svc.export({...})`
	 * with no await): without the registry an un-awaited call is
	 * indistinguishable from a pure method expression, so it compiles as
	 * a `let` instead. `validateScript` passes its `tools` through.
	 */
	tools?: Iterable<string>;
}

/** Options a call's second argument may carry, all literal values. */
const CALL_OPTIONS = [
	"reason",
	"onError",
	"suspend",
	"await",
	"max",
	"after",
] as const;

type Ctx = {
	/** Composed `if` condition (already renamed and parse-checked). */
	cond?: string;
	/** Identifier renames in force (catch params -> `$errors.<id>`). */
	renames?: Map<string, string>;
	/** True only for the program's own statement list - where a trailing
	 * `return` is the script's `output` rather than a guard step. */
	topLevel: boolean;
	/** Inside a fan-out's own arrow/body: a nested await cannot be hoisted
	 * out (the step would read the per-element binding), so it is rejected
	 * with the bind-first fix instead. */
	noHoist?: boolean;
};

/**
 * Compile JS surface text into a Script. Throws `ScriptValidationError`
 * with every issue found, each at its source line. The result still goes
 * through `validateScript` like any other script input.
 */
export function parseJsScript(
	source: string,
	options: ParseJsOptions = {},
): Script {
	const issues: ScriptIssue[] = [];
	const comments: { text: string; start: number }[] = [];
	let program: acorn.Program;
	try {
		program = acorn.parse(source, {
			ecmaVersion: 2022,
			sourceType: "script",
			locations: true,
			allowReturnOutsideFunction: true,
			allowAwaitOutsideFunction: true,
			onComment: (_block, text, start) => comments.push({ text, start }),
		});
	} catch (err) {
		const loc = (err as { loc?: { line: number } }).loc;
		throw new ScriptValidationError([
			{
				path: loc ? `line ${loc.line}` : "(script)",
				message: `Not parseable as JavaScript: ${err instanceof Error ? err.message : String(err)}`,
			},
		]);
	}

	const toolNames = options.tools ? new Set(options.tools) : undefined;
	const wildcardOf = toolNames ? createWildcardMatcher(toolNames) : undefined;
	const isMountedTool = (name: string): boolean =>
		toolNames !== undefined &&
		((!name.includes("*") && toolNames.has(name)) ||
			(!isInternalName(name) && wildcardOf!(name) !== undefined));

	const steps: Step[] = [];
	let output: string | undefined;
	/** Ids of the most recent awaited call step(s) - the effect frontier.
	 * JS text reads sequentially, so awaited calls chain via `after`
	 * unless data already orders them; `Promise.all` is the (equally
	 * JS-native) spelling for "these run concurrently". */
	let frontier: string[] = [];

	/* ------------------------------ plumbing ------------------------------- */

	const lineOf = (node: acorn.AnyNode): string =>
		`line ${(node as { loc?: acorn.SourceLocation | null }).loc?.start.line ?? "?"}`;
	const issue = (node: acorn.AnyNode, message: string): undefined => {
		issues.push({ path: lineOf(node), message });
		return undefined;
	};

	// Every binding name, pre-scanned, so minted ids (s1, s2, ...) never
	// collide with a const declared later in the program.
	const usedIds = new Set<string>();
	const scanNames = (stmts: readonly acorn.AnyNode[]): void => {
		for (const stmt of stmts) {
			switch (stmt.type) {
				case "VariableDeclaration":
					for (const d of stmt.declarations) {
						for (const name of patternNames(d.id)) usedIds.add(name);
					}
					break;
				case "BlockStatement":
					scanNames(stmt.body);
					break;
				case "IfStatement":
					scanNames([stmt.consequent]);
					if (stmt.alternate) scanNames([stmt.alternate]);
					break;
				case "TryStatement":
					scanNames(stmt.block.body);
					if (stmt.handler) scanNames(stmt.handler.body.body);
					break;
				default:
					break;
			}
		}
	};
	scanNames(program.body);
	let mintCounter = 0;
	const mint = (): string => {
		let id: string;
		do {
			mintCounter++;
			id = `s${mintCounter}`;
		} while (usedIds.has(id));
		usedIds.add(id);
		return id;
	};

	/** `a.b.c` as a dotted name; undefined for anything computed/optional. */
	const dottedName = (node: acorn.AnyNode): string | undefined => {
		if (node.type === "Identifier") return node.name;
		if (
			node.type === "MemberExpression" &&
			!node.computed &&
			!node.optional &&
			node.property.type === "Identifier"
		) {
			const obj = dottedName(node.object);
			return obj === undefined ? undefined : `${obj}.${node.property.name}`;
		}
		return undefined;
	};

	/** An await buried in an expression position gets the bind-first fix,
	 * not a generic parse error. */
	const containsAwait = (node: unknown): boolean => {
		if (node === null || typeof node !== "object") return false;
		const n = node as Record<string, unknown> & { type?: string };
		if (n.type === "AwaitExpression") return true;
		for (const [key, value] of Object.entries(n)) {
			if (key === "loc") continue;
			if (Array.isArray(value)) {
				if (value.some(containsAwait)) return true;
			} else if (
				value !== null &&
				typeof value === "object" &&
				typeof (value as { type?: unknown }).type === "string" &&
				containsAwait(value)
			) {
				return true;
			}
		}
		return false;
	};

	/**
	 * HOISTING: an awaited tool call nested in an expression - `return {
	 * issues: await repo.list({}) }`, `tool({ id: (await other({})).id })`
	 * - compiles into its own call step first, and the expression reads
	 * the step where the await stood: exactly what the author gets by
	 * binding it, so the plan is the same one. Statement order holds -
	 * hoisted calls join the effect frontier like any awaited call, in
	 * source order. Not hoistable: an await inside an arrow (a closure
	 * runs per element - that is the fan-out's job) and any await inside
	 * a fan-out's own arguments (`noHoist`). Returns the expression text
	 * with every hoisted span replaced by its step id.
	 */
	const hoistAwaits = (node: acorn.AnyNode, ctx: Ctx): string | undefined => {
		const awaits: acorn.AwaitExpression[] = [];
		const collect = (n: unknown): void => {
			if (n === null || typeof n !== "object") return;
			const v = n as Record<string, unknown> & { type?: string };
			if (
				v.type === "ArrowFunctionExpression" ||
				v.type === "FunctionExpression"
			) {
				return;
			}
			if (v.type === "AwaitExpression") {
				// outermost only - an await inside this call's own arguments
				// hoists when the call compiles its args
				awaits.push(n as acorn.AwaitExpression);
				return;
			}
			for (const [key, value] of Object.entries(v)) {
				if (key === "loc") continue;
				if (Array.isArray(value)) value.forEach(collect);
				else if (
					value !== null &&
					typeof value === "object" &&
					typeof (value as { type?: unknown }).type === "string"
				) {
					collect(value);
				}
			}
		};
		collect(node);
		awaits.sort((a, b) => a.start - b.start);
		if (ctx.noHoist) {
			return issue(
				node,
				"a fan-out's arguments cannot await - compute the value before the fan-out (const x = await tool.name({ ... })), then read x",
			);
		}
		if (awaits.length === 0) {
			return issue(
				node,
				"await inside an arrow cannot run - fan out instead: await Promise.all(list.map(item => tool.name({ ... })))",
			);
		}
		const edits: { start: number; end: number; text: string }[] = [];
		for (const a of awaits) {
			const arg = a.argument;
			const callee =
				arg.type === "CallExpression" ? dottedName(arg.callee) : undefined;
			if (callee === "Promise.all") {
				return issue(
					a,
					"bind a fan-out first: const results = await Promise.all(...), then read results",
				);
			}
			if (arg.type !== "CallExpression" || callee === undefined) {
				return issue(
					a,
					"await belongs directly on a tool call - bind it first (const x = await tool.name({ ... })), then derive from x",
				);
			}
			const step = compileCall(arg, mint(), ctx);
			if (step === undefined) return undefined;
			pushCall(step, ctx);
			edits.push({ start: a.start, end: a.end, text: step.id });
		}
		let text = source.slice(node.start, node.end);
		for (const e of edits.sort((x, y) => y.start - x.start)) {
			text =
				text.slice(0, e.start - node.start) +
				e.text +
				text.slice(e.end - node.start);
		}
		if (ctx.renames !== undefined && ctx.renames.size > 0) {
			// the spans are gone, so rename against a fresh parse of the text
			const reparsed = acorn.parseExpressionAt(text, 0, {
				ecmaVersion: 2022,
				sourceType: "script",
			});
			text = renameIdentifiers(text, reparsed as acorn.AnyNode, 0, ctx.renames);
		}
		return text;
	};

	/** Slice a node as an expression string: nested awaits hoisted,
	 * renames applied, grammar checked (the checker's messages teach the
	 * pure-JS subset). */
	const exprSrc = (node: acorn.AnyNode, ctx: Ctx): string | undefined => {
		let text: string;
		if (containsAwait(node)) {
			const hoisted = hoistAwaits(node, ctx);
			if (hoisted === undefined) return undefined;
			text = hoisted;
		} else {
			text = source.slice(node.start, node.end);
			if (ctx.renames !== undefined && ctx.renames.size > 0) {
				text = renameIdentifiers(text, node, node.start, ctx.renames);
			}
		}
		try {
			parseExpr(text);
		} catch (err) {
			return issue(node, err instanceof ExprError ? err.message : String(err));
		}
		return text;
	};

	const composeCond = (outer: string | undefined, inner: string): string =>
		outer === undefined ? inner : `(${outer}) && (${inner})`;

	/** Renames minus the names an inner arrow/loop param rebinds. */
	const shadowRenames = (
		renames: Map<string, string> | undefined,
		params: readonly acorn.Pattern[],
	): Map<string, string> | undefined => {
		if (renames === undefined || renames.size === 0) return renames;
		const bound = new Set(params.flatMap((p) => patternNames(p)));
		const out = new Map([...renames].filter(([name]) => !bound.has(name)));
		return out;
	};

	/* ----------------------------- destructuring --------------------------- */

	/** `src.key`, or `src["odd key"]` when the key is not an identifier. */
	const memberSrc = (src: string, key: string): string =>
		/^[A-Za-z_$][\w$]*$/.test(key)
			? `${src}.${key}`
			: `${src}[${JSON.stringify(key)}]`;

	/** A pattern property's static key; undefined when computed. */
	const propertyKey = (prop: acorn.AssignmentProperty): string | undefined => {
		if (prop.computed) return undefined;
		if (prop.key.type === "Identifier") return prop.key.name;
		if (
			prop.key.type === "Literal" &&
			(typeof prop.key.value === "string" || typeof prop.key.value === "number")
		) {
			return String(prop.key.value);
		}
		return undefined;
	};

	/** A derivation the desugar generated: grammar-checked (a forbidden
	 * key like `constructor` surfaces here, at the pattern's line). */
	const pushLet = (
		node: acorn.AnyNode,
		id: string,
		text: string,
		ctx: Ctx,
	): void => {
		try {
			parseExpr(text);
		} catch (err) {
			issue(node, err instanceof ExprError ? err.message : String(err));
			return;
		}
		pushStep({ id, let: text }, ctx);
	};

	/**
	 * DESTRUCTURING: `const { items, total = 0 } = x` and `const [head,
	 * ...tail] = xs` desugar into one `let` step per bound name - a field
	 * read off the source (`items = x.items`), which is exactly the
	 * "bind to one name and read fields off it" spelling the plan already
	 * has. `src` is always a cheap path off a step id, so a default may
	 * repeat it (`x.total === undefined ? 0 : x.total`); a nested pattern
	 * under a default reads from one minted id instead. Object rest keeps
	 * every key the pattern did not name. Nothing here changes the plan
	 * format: the steps are the ones the author could have written.
	 */
	const bindPattern = (pattern: acorn.Pattern, src: string, ctx: Ctx): void => {
		switch (pattern.type) {
			case "Identifier":
				pushLet(pattern, pattern.name, src, ctx);
				return;
			case "AssignmentPattern": {
				const fallback = exprSrc(pattern.right as acorn.AnyNode, ctx);
				if (fallback === undefined) return;
				const value = `${src} === undefined ? (${fallback}) : ${src}`;
				if (pattern.left.type === "Identifier") {
					pushLet(pattern, pattern.left.name, value, ctx);
					return;
				}
				const id = mint();
				pushLet(pattern, id, value, ctx);
				bindPattern(pattern.left, id, ctx);
				return;
			}
			case "ObjectPattern": {
				const named: string[] = [];
				for (const prop of pattern.properties) {
					if (prop.type === "RestElement") {
						const keep =
							named.length === 0
								? "true"
								: named
										.map((k) => `e[0] !== ${JSON.stringify(k)}`)
										.join(" && ");
						bindPattern(
							prop.argument,
							`Object.fromEntries(Object.entries(${src}).filter(e => ${keep}))`,
							ctx,
						);
						continue;
					}
					const key = propertyKey(prop);
					if (key === undefined) {
						issue(
							prop,
							"destructure with plain keys - a computed key ([k]) is not a static binding",
						);
						continue;
					}
					named.push(key);
					bindPattern(prop.value as acorn.Pattern, memberSrc(src, key), ctx);
				}
				return;
			}
			case "ArrayPattern": {
				pattern.elements.forEach((el, index) => {
					if (el === null) return; // a hole skips the element
					if (el.type === "RestElement") {
						bindPattern(el.argument, `${src}.slice(${index})`, ctx);
						return;
					}
					bindPattern(el, `${src}[${index}]`, ctx);
				});
				return;
			}
			default:
				issue(pattern, `unsupported binding pattern (${pattern.type})`);
		}
	};

	/* ----------------------------- args & opts ----------------------------- */

	/** A node that is pure JSON - embeddable as literal args. */
	const literalJson = (
		node: acorn.AnyNode,
	): { ok: true; value: JsonValue } | { ok: false } => {
		switch (node.type) {
			case "Literal": {
				if ("regex" in node && node.regex) return { ok: false };
				const v = node.value;
				if (
					v === null ||
					typeof v === "string" ||
					typeof v === "number" ||
					typeof v === "boolean"
				) {
					return { ok: true, value: v };
				}
				return { ok: false };
			}
			case "TemplateLiteral":
				if (node.expressions.length === 0 && node.quasis.length === 1) {
					return { ok: true, value: node.quasis[0]!.value.cooked ?? "" };
				}
				return { ok: false };
			case "UnaryExpression":
				if (
					node.operator === "-" &&
					node.argument.type === "Literal" &&
					typeof node.argument.value === "number"
				) {
					return { ok: true, value: -node.argument.value };
				}
				return { ok: false };
			case "ArrayExpression": {
				const out: JsonValue[] = [];
				for (const el of node.elements) {
					if (!el || el.type === "SpreadElement") return { ok: false };
					const r = literalJson(el);
					if (!r.ok) return r;
					out.push(r.value);
				}
				return { ok: true, value: out };
			}
			case "ObjectExpression": {
				const out: Record<string, JsonValue> = {};
				for (const p of node.properties) {
					if (p.type !== "Property" || p.computed || p.kind !== "init") {
						return { ok: false };
					}
					const key =
						p.key.type === "Identifier"
							? p.key.name
							: p.key.type === "Literal"
								? String(p.key.value)
								: undefined;
					if (key === undefined) return { ok: false };
					const r = literalJson(p.value);
					if (!r.ok) return r;
					out[key] = r.value;
				}
				return { ok: true, value: out };
			}
			default:
				return { ok: false };
		}
	};

	/** In stored args, a literal string starting with "=" needs the "=="
	 * escape so resolveArgs reads it back as the literal it was. */
	const escapeStrings = (value: JsonValue): JsonValue => {
		if (typeof value === "string") {
			return value.startsWith("=") ? `=${value}` : value;
		}
		if (Array.isArray(value)) return value.map(escapeStrings);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, escapeStrings(v)]),
			);
		}
		return value;
	};

	/** Compile a call's args node: literals stay literal JSON, anything
	 * else becomes an "=expr" string - per property, so a mixed object
	 * keeps its literal parts inspectable. */
	const compileArgs = (
		node: acorn.AnyNode,
		ctx: Ctx,
	): JsonValue | undefined => {
		const lit = literalJson(node);
		if (lit.ok) return escapeStrings(lit.value);
		if (node.type === "ObjectExpression") {
			const plain = node.properties.every(
				(p) =>
					p.type === "Property" &&
					!p.computed &&
					p.kind === "init" &&
					(p.key.type === "Identifier" ||
						(p.key.type === "Literal" && typeof p.key.value === "string")),
			);
			if (plain) {
				const out: Record<string, JsonValue> = {};
				for (const p of node.properties) {
					const prop = p as acorn.Property;
					const key =
						prop.key.type === "Identifier"
							? prop.key.name
							: String((prop.key as acorn.Literal).value);
					const v = compileArgs(prop.value, ctx);
					if (v === undefined) return undefined;
					out[key] = v;
				}
				return out;
			}
		}
		if (
			node.type === "ArrayExpression" &&
			node.elements.every((el) => el !== null && el.type !== "SpreadElement")
		) {
			const out: JsonValue[] = [];
			for (const el of node.elements) {
				const v = compileArgs(el as acorn.AnyNode, ctx);
				if (v === undefined) return undefined;
				out.push(v);
			}
			return out;
		}
		const text = exprSrc(node, ctx);
		return text === undefined ? undefined : `=${text}`;
	};

	/** The call's second argument: literal step options. */
	const applyOpts = (step: CallStep, node: acorn.AnyNode): void => {
		const lit = literalJson(node);
		if (
			node.type !== "ObjectExpression" ||
			!lit.ok ||
			typeof lit.value !== "object" ||
			lit.value === null ||
			Array.isArray(lit.value)
		) {
			issue(
				node,
				'call options must be an object of literals, like { reason: "why", suspend: true }',
			);
			return;
		}
		for (const [key, value] of Object.entries(lit.value)) {
			switch (key) {
				case "reason":
					if (typeof value === "string") step.reason = value;
					else issue(node, '"reason" must be a string');
					break;
				case "onError":
					if (value === "skip" || value === "fail") step.onError = value;
					else issue(node, '"onError" is "skip" or "fail"');
					break;
				case "suspend":
					if (typeof value === "boolean") step.suspend = value;
					else issue(node, '"suspend" must be a boolean');
					break;
				case "await":
					if (typeof value === "boolean") step.await = value;
					else issue(node, '"await" must be a boolean');
					break;
				case "max":
					if (typeof value === "number") step.max = value;
					else issue(node, '"max" must be a number');
					break;
				case "after":
					if (
						Array.isArray(value) &&
						value.every((v) => typeof v === "string")
					) {
						step.after = [...(step.after ?? []), ...(value as string[])];
					} else issue(node, '"after" must be an array of step ids');
					break;
				default:
					issue(
						node,
						`unknown call option "${key}" - the options are ${CALL_OPTIONS.map((o) => `"${o}"`).join(", ")}`,
					);
			}
		}
	};

	/* ------------------------- step push & ordering ------------------------ */

	/** Per pushed step: every earlier name it is ordered after, directly
	 * or transitively - so the chaining below never adds an `after` edge
	 * the dataflow already implies. */
	const closures = new Map<string, Set<string>>();

	/** Free names a compiled step's expressions read. */
	const stepRefs = (step: Step): Set<string> => {
		const refs = new Set<string>();
		const add = (src: string | undefined) => {
			if (src === undefined) return;
			try {
				for (const r of collectRefs(parseExpr(src))) refs.add(r);
			} catch {
				// unparseable slices already produced their issue
			}
		};
		add(step.if);
		if ("return" in step) add(step.return);
		if ("let" in step && typeof step.let === "string") add(step.let);
		if ("call" in step) {
			add(step.each);
			if (step.args !== undefined) {
				for (const src of collectArgExprs(step.args)) add(src);
			}
		}
		return refs;
	};

	/** The transitive ordering set: the refs plus everything they close over. */
	const closureOf = (refs: Iterable<string>): Set<string> => {
		const out = new Set(refs);
		for (const ref of out) {
			const inner = closures.get(ref);
			if (inner) for (const name of inner) out.add(name);
		}
		return out;
	};

	/** Record a non-call step so later closures see through it. */
	const pushStep = <T extends LetStep | ReturnStep>(step: T, ctx: Ctx): T => {
		if (ctx.cond !== undefined) step.if = ctx.cond;
		steps.push(step);
		closures.set(step.id, closureOf(stepRefs(step)));
		return step;
	};

	/** JS reads sequentially: an awaited call runs after the previous
	 * awaited call unless data already orders them (directly or through
	 * derivations). Detached calls take the edge (they fire "here") but
	 * never become the frontier. */
	const pushCall = (step: CallStep, ctx: Ctx): CallStep => {
		if (ctx.cond !== undefined) step.if = ctx.cond;
		const closure = closureOf([...stepRefs(step), ...(step.after ?? [])]);
		if (frontier.length > 0) {
			const after = frontier.filter((id) => !closure.has(id));
			if (after.length > 0) {
				step.after = [...new Set([...(step.after ?? []), ...after])];
				for (const id of after) {
					closure.add(id);
					const inner = closures.get(id);
					if (inner) for (const name of inner) closure.add(name);
				}
			}
		}
		steps.push(step);
		closures.set(step.id, closure);
		if (step.await !== false) frontier = [step.id];
		return step;
	};

	/* ------------------------------ call forms ----------------------------- */

	/** One tool call expression -> a CallStep (not yet pushed). */
	const compileCall = (
		node: acorn.CallExpression,
		id: string,
		ctx: Ctx,
	): CallStep | undefined => {
		const name = dottedName(node.callee);
		if (name === undefined) {
			return issue(
				node,
				"a tool call is a plain dotted name - tool.name({ ... }) - nothing computed",
			);
		}
		if (node.arguments.length > 2) {
			return issue(
				node,
				"a tool takes (args, options?) - one args object, plus an optional literal options object",
			);
		}
		const step: CallStep = { id, call: name };
		const [argsNode, optsNode] = node.arguments;
		if (argsNode !== undefined) {
			if (argsNode.type === "SpreadElement") {
				return issue(argsNode, "no spread in a tool call's arguments");
			}
			const args = compileArgs(argsNode, ctx);
			if (args === undefined) return undefined;
			step.args = args;
		}
		if (optsNode !== undefined) {
			if (optsNode.type === "SpreadElement") {
				return issue(optsNode, "no spread in a tool call's arguments");
			}
			applyOpts(step, optsNode);
		}
		return step;
	};

	/** `.slice(0, N)` at the end of the fan-out list -> the declared max. */
	const sliceBound = (listNode: acorn.AnyNode): number | undefined => {
		if (
			listNode.type === "CallExpression" &&
			listNode.callee.type === "MemberExpression" &&
			!listNode.callee.computed &&
			listNode.callee.property.type === "Identifier" &&
			listNode.callee.property.name === "slice" &&
			listNode.arguments.length === 2 &&
			listNode.arguments[0]!.type === "Literal" &&
			(listNode.arguments[0] as acorn.Literal).value === 0 &&
			listNode.arguments[1]!.type === "Literal" &&
			typeof (listNode.arguments[1] as acorn.Literal).value === "number"
		) {
			return (listNode.arguments[1] as acorn.Literal).value as number;
		}
		return undefined;
	};

	/** `await Promise.all(list.map(i => tool.name(args)))` -> an `each`
	 * fan-out step. The body may be `async i => await tool(...)` too. */
	const compileFanOut = (
		listNode: acorn.AnyNode,
		cb: acorn.AnyNode,
		id: string,
		ctx: Ctx,
	): CallStep | undefined => {
		if (cb.type !== "ArrowFunctionExpression") {
			return issue(
				cb,
				"fan out with an arrow: Promise.all(list.map(item => tool.name({ ... })))",
			);
		}
		let body: acorn.AnyNode = cb.body as acorn.AnyNode;
		if (body.type === "BlockStatement") {
			return issue(
				cb,
				"the fan-out arrow must be a single call - list.map(item => tool.name({ ... })), no block body",
			);
		}
		if (body.type === "AwaitExpression") body = body.argument;
		if (body.type !== "CallExpression") {
			return issue(
				cb,
				"the fan-out arrow must BE the tool call - compute the list first (const items = ...), then map each item to one call",
			);
		}
		const innerCtx: Ctx = {
			...ctx,
			renames: shadowRenames(ctx.renames, cb.params),
			noHoist: true,
		};
		const step = compileCall(body, id, innerCtx);
		if (step === undefined) return undefined;
		const listSrc = exprSrc(listNode, ctx);
		if (listSrc === undefined) return undefined;
		const paramsSrc =
			cb.params.length === 0
				? "_"
				: source.slice(
						cb.params[0]!.start,
						cb.params[cb.params.length - 1]!.end,
					);
		const argsNode = body.arguments[0];
		const argsSrc =
			argsNode === undefined
				? "{}"
				: exprSrc(argsNode as acorn.AnyNode, innerCtx);
		if (argsSrc === undefined) return undefined;
		delete step.args;
		step.each = `(${listSrc}).map((${paramsSrc}) => (${argsSrc}))`;
		try {
			parseExpr(step.each);
		} catch (err) {
			return issue(cb, err instanceof ExprError ? err.message : String(err));
		}
		const bound = sliceBound(listNode);
		if (bound !== undefined && step.max === undefined) step.max = bound;
		return step;
	};

	/**
	 * An awaited statement/initializer. Returns the call step it pushed
	 * when the form maps to ONE step (single call or fan-out) - what
	 * try/catch wraps; tuple and join forms return undefined after
	 * pushing their steps.
	 */
	const compileAwaited = (
		awaitNode: acorn.AwaitExpression,
		binding: acorn.Pattern | undefined,
		ctx: Ctx,
		where: "statement" | "try",
	): CallStep | undefined => {
		const bindingName =
			binding?.type === "Identifier" ? binding.name : undefined;
		const arg = awaitNode.argument;

		// `await job` - join a run detached earlier (a session concern).
		if (arg.type === "Identifier") {
			if (binding !== undefined && bindingName === undefined) {
				return issue(binding, "bind a join to one name: const r = await job");
			}
			if (where === "try") {
				return issue(awaitNode, "a join cannot be wrapped in try/catch");
			}
			pushCall({ id: bindingName ?? mint(), call: `await.${arg.name}` }, ctx);
			return undefined;
		}
		if (arg.type !== "CallExpression") {
			return issue(
				awaitNode,
				"await belongs directly on a tool call - bind it first (const x = await tool.name({ ... })), then derive from x",
			);
		}
		const calleeName = dottedName(arg.callee);

		if (calleeName === "Promise.all") {
			if (arg.arguments.length !== 1) {
				return issue(arg, "Promise.all takes exactly one argument");
			}
			const inner = arg.arguments[0]!;
			// Fan-out: Promise.all(list.map(item => tool.name(args)))
			if (
				inner.type === "CallExpression" &&
				inner.callee.type === "MemberExpression" &&
				!inner.callee.computed &&
				inner.callee.property.type === "Identifier" &&
				inner.callee.property.name === "map" &&
				inner.arguments.length >= 1
			) {
				if (binding !== undefined && bindingName === undefined) {
					return issue(
						binding,
						"bind a fan-out to one name - its value is the array of results",
					);
				}
				const step = compileFanOut(
					inner.callee.object,
					inner.arguments[0] as acorn.AnyNode,
					bindingName ?? mint(),
					ctx,
				);
				if (step === undefined) return undefined;
				return pushCall(step, ctx);
			}
			// Tuple: Promise.all([tool.a({...}), tool.b({...})]) - the calls
			// run concurrently; destructure to name them.
			if (inner.type === "ArrayExpression") {
				if (where === "try") {
					return issue(
						arg,
						"one tool call per try - give each risky call its own try/catch",
					);
				}
				// `const [a, b] = ...` names the calls; a nested pattern in an
				// element (`[{ closed }, b]`) reads off its own minted call.
				const elements =
					binding?.type === "ArrayPattern" ? binding.elements : undefined;
				if (
					elements !== undefined &&
					elements.length !== inner.elements.length
				) {
					return issue(
						binding!,
						"destructure one name per call: const [a, b] = await Promise.all([...])",
					);
				}
				const names: (string | undefined)[] = inner.elements.map((_, i) => {
					const el = elements?.[i];
					return el && el.type === "Identifier" ? el.name : undefined;
				});
				const compiled: CallStep[] = [];
				const byIndex: (CallStep | undefined)[] = [];
				for (const [index, el] of inner.elements.entries()) {
					if (!el || el.type === "SpreadElement") {
						issue(inner, "Promise.all takes plain tool calls, no holes/spread");
						continue;
					}
					let callNode: acorn.AnyNode = el;
					if (callNode.type === "AwaitExpression") callNode = callNode.argument;
					if (callNode.type !== "CallExpression") {
						issue(
							el,
							"each Promise.all element must be a tool call - tool.name({ ... })",
						);
						continue;
					}
					const step = compileCall(callNode, names[index] ?? mint(), ctx);
					byIndex[index] = step;
					if (step !== undefined) compiled.push(step);
				}
				// All elements chain after the SAME prior frontier, then the
				// awaited ones become the frontier together - that is the
				// concurrency the author asked for.
				const before = frontier;
				const nextFrontier: string[] = [];
				for (const step of compiled) {
					frontier = before;
					pushCall(step, ctx);
					if (step.await !== false) nextFrontier.push(step.id);
				}
				frontier = nextFrontier.length > 0 ? nextFrontier : before;
				if (elements !== undefined) {
					// Nested patterns in the tuple read off their own call step.
					elements.forEach((el, index) => {
						const step = byIndex[index];
						if (el === null || el.type === "Identifier" || step === undefined) {
							return;
						}
						if (el.type === "RestElement") {
							issue(
								el,
								"destructure one name per call: const [a, b] = await Promise.all([...])",
							);
							return;
						}
						bindPattern(el, step.id, ctx);
					});
				} else if (binding !== undefined) {
					// Any other binding gets the tuple as a value - a name
					// directly, a pattern through a minted tuple step.
					const tuple = `[${compiled.map((s) => s.id).join(", ")}]`;
					if (binding.type === "Identifier") {
						pushStep({ id: binding.name, let: tuple }, ctx);
					} else {
						const id = mint();
						pushStep({ id, let: tuple }, ctx);
						bindPattern(binding, id, ctx);
					}
				}
				return undefined;
			}
			return issue(
				arg,
				"Promise.all takes list.map(item => tool.name({ ... })) or an array of tool calls",
			);
		}

		// Plain awaited tool call. A destructured binding reads its fields
		// off the call step: `const { items } = await t()` is the call under
		// a minted id plus `items = <id>.items` - inside a try, only when
		// the call succeeded (the catch branch owns the failure).
		const step = compileCall(arg, bindingName ?? mint(), ctx);
		if (step === undefined) return undefined;
		pushCall(step, ctx);
		if (binding !== undefined && bindingName === undefined) {
			bindPattern(
				binding,
				step.id,
				where === "try"
					? { ...ctx, cond: composeCond(ctx.cond, `!($errors.${step.id})`) }
					: ctx,
			);
		}
		return step;
	};

	/* ------------------------------ statements ----------------------------- */

	const compileDeclaration = (node: acorn.VariableDeclaration, ctx: Ctx) => {
		for (const decl of node.declarations) {
			if (decl.init === null || decl.init === undefined) {
				issue(decl, "give the binding a value: const x = ...");
				continue;
			}
			if (decl.init.type === "AwaitExpression") {
				compileAwaited(decl.init, decl.id, ctx, "statement");
				continue;
			}
			// Un-awaited call to a MOUNTED tool -> detached (fire-and-forget).
			if (decl.init.type === "CallExpression") {
				const name = dottedName(decl.init.callee);
				if (name !== undefined && isMountedTool(name)) {
					if (decl.id.type !== "Identifier") {
						issue(
							decl.id,
							"bind a detached call to one name - const job = tool.name({ ... }); a later script joins it with await job",
						);
						continue;
					}
					const step = compileCall(decl.init, decl.id.name, ctx);
					if (step !== undefined) {
						step.await = false;
						pushCall(step, ctx);
					}
					continue;
				}
			}
			const text = exprSrc(decl.init, ctx);
			if (text === undefined) continue;
			if (decl.id.type !== "Identifier") {
				// Destructuring a pure value: read the fields straight off a
				// name/path source; anything else is derived once first.
				let src = text;
				if (dottedName(decl.init) === undefined) {
					src = mint();
					pushStep({ id: src, let: text }, ctx);
				}
				bindPattern(decl.id, src, ctx);
				continue;
			}
			pushStep({ id: decl.id.name, let: text }, ctx);
		}
	};

	const compileReturn = (node: acorn.ReturnStatement, ctx: Ctx) => {
		if (!node.argument) {
			issue(
				node,
				"return a value - it becomes the run's result: return { done: true }",
			);
			return;
		}
		// `return await tool(...)` - the dominant "make the last call and
		// return its result" idiom. Desugar: the call becomes its own
		// (guard-inheriting) step under a minted id, and the return hands
		// that id back - identical to binding first, so accept it.
		if (
			node.argument.type === "AwaitExpression" &&
			node.argument.argument.type === "CallExpression"
		) {
			const id = mint();
			const binding = {
				type: "Identifier",
				name: id,
				start: node.argument.start,
				end: node.argument.end,
				loc: node.argument.loc,
			} as unknown as acorn.Pattern;
			const step = compileAwaited(node.argument, binding, ctx, "statement");
			if (step === undefined) return;
			if (ctx.topLevel && ctx.cond === undefined) {
				output = id;
				return;
			}
			pushStep(
				{ id: mint(), return: id },
				ctx.cond === undefined ? { ...ctx, cond: "true" } : ctx,
			);
			return;
		}
		const text = exprSrc(node.argument, ctx);
		if (text === undefined) return;
		if (ctx.topLevel && ctx.cond === undefined) {
			output = text;
			return;
		}
		// A guard step: the `if` decides whether the run ends - JS semantics
		// exactly, the value may be falsy. An unconditional return inside a
		// bare block still guards, on `true`.
		pushStep(
			{ id: mint(), return: text },
			ctx.cond === undefined ? { ...ctx, cond: "true" } : ctx,
		);
	};

	const compileIf = (node: acorn.IfStatement, ctx: Ctx) => {
		const condSrc = exprSrc(node.test, ctx);
		if (condSrc === undefined) return;
		compileBranch(node.consequent, {
			...ctx,
			cond: composeCond(ctx.cond, condSrc),
			topLevel: false,
		});
		if (node.alternate) {
			compileBranch(node.alternate, {
				...ctx,
				cond: composeCond(ctx.cond, `!(${condSrc})`),
				topLevel: false,
			});
		}
	};

	const compileBranch = (node: acorn.Statement, ctx: Ctx) => {
		compileStatements(node.type === "BlockStatement" ? node.body : [node], ctx);
	};

	const compileTry = (node: acorn.TryStatement, ctx: Ctx) => {
		if (node.finalizer) {
			issue(
				node.finalizer,
				"finally is unnecessary - statements after the try/catch always run",
			);
		}
		const [inner, ...rest] = node.block.body;
		if (inner === undefined) {
			issue(
				node.block,
				"an empty try does nothing - put the risky awaited tool call in it",
			);
			return;
		}
		let step: CallStep | undefined;
		if (
			inner.type === "VariableDeclaration" &&
			inner.declarations.length === 1 &&
			inner.declarations[0]!.init?.type === "AwaitExpression"
		) {
			step = compileAwaited(
				inner.declarations[0]!.init as acorn.AwaitExpression,
				inner.declarations[0]!.id,
				ctx,
				"try",
			);
			for (const name of patternNames(inner.declarations[0]!.id)) {
				usedIds.add(name);
			}
		} else if (
			inner.type === "ExpressionStatement" &&
			inner.expression.type === "AwaitExpression"
		) {
			step = compileAwaited(inner.expression, undefined, ctx, "try");
		} else {
			issue(
				inner,
				"a try block starts with its one awaited tool call - move pure derivations before the try",
			);
			return;
		}
		if (step === undefined) return;
		step.onError ??= "skip";
		// statements after the call inside the try run only on SUCCESS -
		// derivations and returns of the happy path. A second awaited call
		// stays rejected: this catch would not cover its failure the way
		// a real JS catch would, so each risky call gets its own try.
		const risky = rest.find((s) => containsAwait(s));
		if (risky !== undefined) {
			issue(
				risky,
				"one tool call per try - give each risky call its own try/catch",
			);
			return;
		}
		if (rest.length > 0) {
			compileStatements(rest, {
				cond: composeCond(ctx.cond, `!($errors.${step.id})`),
				renames: ctx.renames,
				topLevel: false,
			});
		}
		if (node.handler) {
			const param = node.handler.param;
			if (
				param !== null &&
				param !== undefined &&
				param.type !== "Identifier"
			) {
				issue(param, "catch one plain name: catch (e) { ... }");
				return;
			}
			const errRef = `$errors.${step.id}`;
			const renames = new Map(ctx.renames ?? []);
			if (param) renames.set(param.name, errRef);
			compileStatements(node.handler.body.body, {
				cond: composeCond(ctx.cond, errRef),
				renames,
				topLevel: false,
			});
		}
	};

	/**
	 * `for (const item of list) { ... }` fans out exactly like
	 * `Promise.all(list.map(...))`, so the body may carry what a map arrow
	 * can express: pure local consts (inlined into the call - `const n =
	 * i.number` is a rename to `(i.number)`), `if (cond) continue` and
	 * `if (cond) { ... }` guards around the call (a `.filter` on the
	 * list), and exactly one awaited tool call, bound or bare. A second
	 * call, an else branch, a return: that is a real loop body, and the
	 * message names the fan-out spelling.
	 */
	const compileForOf = (node: acorn.ForOfStatement, ctx: Ctx) => {
		if (node.await) {
			issue(node, "for await is not needed - a plain for..of fans out");
		}
		const left = node.left;
		if (left.type !== "VariableDeclaration" || left.declarations.length !== 1) {
			return issue(left, "loop with one binding: for (const item of list)");
		}
		const param = left.declarations[0]!.id;
		const listSrc = exprSrc(node.right, ctx);
		if (listSrc === undefined) return;
		const paramSrc = source.slice(param.start, param.end);

		const reject = (at: acorn.AnyNode): false => {
			issue(
				at,
				"a for..of body is one awaited tool call, optionally behind local consts and an if guard - or spell the fan-out directly: await Promise.all(list.map(item => tool.name({ ... })))",
			);
			return false;
		};

		let renames = new Map(shadowRenames(ctx.renames, [param]) ?? []);
		const filters: string[] = [];
		let call: acorn.CallExpression | undefined;

		const walk = (stmts: readonly acorn.Statement[]): boolean => {
			for (const [index, stmt] of stmts.entries()) {
				const last = index === stmts.length - 1;
				if (stmt.type === "EmptyStatement") continue;
				// Pure locals: inlined wherever the body reads them.
				if (
					stmt.type === "VariableDeclaration" &&
					stmt.declarations.every(
						(d) => d.init != null && d.init.type !== "AwaitExpression",
					)
				) {
					for (const d of stmt.declarations) {
						if (d.id.type !== "Identifier") return reject(d.id);
						const text = exprSrc(d.init as acorn.AnyNode, {
							...ctx,
							renames,
							noHoist: true,
						});
						if (text === undefined) return false;
						renames = new Map(renames);
						renames.set(d.id.name, `(${text})`);
					}
					continue;
				}
				// Guards: `if (cond) continue;` skips the item, `if (cond) {
				// ... }` ending the body keeps only the items that pass.
				if (stmt.type === "IfStatement" && !stmt.alternate) {
					const cond = exprSrc(stmt.test, { ...ctx, renames, noHoist: true });
					if (cond === undefined) return false;
					const inner =
						stmt.consequent.type === "BlockStatement"
							? stmt.consequent.body
							: [stmt.consequent];
					if (inner.length === 1 && inner[0]!.type === "ContinueStatement") {
						filters.push(`!(${cond})`);
						continue;
					}
					if (!last) return reject(stmt);
					filters.push(cond);
					return walk(inner);
				}
				// The one awaited tool call ends the body.
				const awaited: acorn.Expression | undefined =
					stmt.type === "ExpressionStatement" &&
					stmt.expression.type === "AwaitExpression"
						? stmt.expression.argument
						: stmt.type === "VariableDeclaration" &&
								stmt.declarations.length === 1 &&
								stmt.declarations[0]!.init?.type === "AwaitExpression"
							? stmt.declarations[0]!.init.argument
							: undefined;
				if (
					awaited === undefined ||
					awaited.type !== "CallExpression" ||
					!last
				) {
					return reject(stmt);
				}
				call = awaited;
				return true;
			}
			return reject(node);
		};
		const body =
			node.body.type === "BlockStatement" ? node.body.body : [node.body];
		if (!walk(body) || call === undefined) return;

		const innerCtx: Ctx = { ...ctx, renames, noHoist: true };
		const step = compileCall(call, mint(), innerCtx);
		if (step === undefined) return;
		const argsNode = call.arguments[0];
		const argsSrc =
			argsNode === undefined
				? "{}"
				: exprSrc(argsNode as acorn.AnyNode, innerCtx);
		if (argsSrc === undefined) return;
		delete step.args;
		const list =
			filters.length === 0
				? `(${listSrc})`
				: `(${listSrc}).filter((${paramSrc}) => ${filters.map((f) => `(${f})`).join(" && ")})`;
		step.each = `${list}.map((${paramSrc}) => (${argsSrc}))`;
		try {
			parseExpr(step.each);
		} catch (err) {
			return issue(node, err instanceof ExprError ? err.message : String(err));
		}
		const bound = sliceBound(node.right);
		if (bound !== undefined && step.max === undefined) step.max = bound;
		pushCall(step, ctx);
	};

	/**
	 * The dominant model idiom for a conditional value:
	 *
	 *   let label = "none";                       // or  let label;
	 *   if (issues.length > 0) label = "some";    // optionally: else label = "other";
	 *
	 * is one derivation, `label = cond ? "some" : "none"`, so desugar it
	 * to that single-assignment let. Deliberately narrow: a non-const
	 * binding with a pure (or missing) initializer, followed by an `if`
	 * whose branches are exactly one assignment to that name each, and
	 * no await anywhere in it - a call in a branch would hoist out
	 * unconditionally, so it keeps the reassignment message instead.
	 * Returns true when the pair was consumed.
	 */
	const ifAssignDesugar = (
		decl: acorn.VariableDeclaration,
		next: acorn.AnyNode | undefined,
		ctx: Ctx,
	): boolean => {
		if (decl.kind === "const" || decl.declarations.length !== 1) return false;
		const d = decl.declarations[0]!;
		if (d.id.type !== "Identifier") return false;
		const name = d.id.name;
		if (next?.type !== "IfStatement" || containsAwait(next)) return false;
		if (d.init != null && containsAwait(d.init)) return false;
		/** The one `name = expr` a branch holds, else undefined. */
		const assigned = (
			branch: acorn.Statement,
		): acorn.Expression | undefined => {
			const stmt =
				branch.type === "BlockStatement"
					? branch.body.length === 1
						? branch.body[0]
						: undefined
					: branch;
			if (
				stmt?.type !== "ExpressionStatement" ||
				stmt.expression.type !== "AssignmentExpression" ||
				stmt.expression.operator !== "=" ||
				stmt.expression.left.type !== "Identifier" ||
				stmt.expression.left.name !== name
			) {
				return undefined;
			}
			return stmt.expression.right;
		};
		const whenTrue = assigned(next.consequent);
		if (whenTrue === undefined) return false;
		const whenFalse =
			next.alternate == null ? undefined : assigned(next.alternate);
		if (next.alternate != null && whenFalse === undefined) return false;

		const cond = exprSrc(next.test, ctx);
		const a = exprSrc(whenTrue, ctx);
		const b =
			whenFalse !== undefined
				? exprSrc(whenFalse, ctx)
				: d.init != null
					? exprSrc(d.init, ctx)
					: "undefined";
		if (cond === undefined || a === undefined || b === undefined) return true;
		pushStep({ id: name, let: `(${cond}) ? (${a}) : (${b})` }, ctx);
		return true;
	};

	/**
	 * The dominant model idiom for a fallible call:
	 *
	 *   let r;            // or  let r = null / undefined
	 *   try { r = await tool(args); } catch (e) { ... }
	 *
	 * Semantically identical to the canonical form, so desugar it to
	 * `try { const r = await tool(args) } catch (e) { ... }` - the
	 * binding IS the call step. Deliberately narrow: the initializer
	 * must be dead (missing/null/undefined), the try body exactly one
	 * assignment to that name, the value awaited. Anything else - real
	 * reassignment, assigning in catch too - still gets a pointed issue.
	 */
	const tryAssignDesugar = (
		decl: acorn.VariableDeclaration,
		next: acorn.AnyNode | undefined,
	): acorn.TryStatement | undefined => {
		if (decl.kind === "const" || decl.declarations.length !== 1) {
			return undefined;
		}
		const d = decl.declarations[0]!;
		if (d.id.type !== "Identifier") return undefined;
		const init = d.init;
		const deadInit =
			init === null ||
			init === undefined ||
			(init.type === "Literal" && init.value === null) ||
			(init.type === "Identifier" && init.name === "undefined");
		if (!deadInit) return undefined;
		if (next?.type !== "TryStatement" || next.block.body.length !== 1) {
			return undefined;
		}
		const inner = next.block.body[0]!;
		if (
			inner.type !== "ExpressionStatement" ||
			inner.expression.type !== "AssignmentExpression" ||
			inner.expression.operator !== "=" ||
			inner.expression.left.type !== "Identifier" ||
			inner.expression.left.name !== d.id.name ||
			inner.expression.right.type !== "AwaitExpression"
		) {
			return undefined;
		}
		const assign = inner.expression;
		const constDecl = {
			type: "VariableDeclaration",
			kind: "const",
			declarations: [
				{
					type: "VariableDeclarator",
					id: assign.left,
					init: assign.right,
					start: assign.start,
					end: assign.end,
					loc: assign.loc,
				},
			],
			start: inner.start,
			end: inner.end,
			loc: inner.loc,
		} as unknown as acorn.Statement;
		return {
			...next,
			block: { ...next.block, body: [constDecl] },
		} as acorn.TryStatement;
	};

	const compileStatements = (
		stmts: readonly acorn.AnyNode[],
		ctx: Ctx,
	): void => {
		for (let index = 0; index < stmts.length; index++) {
			const stmt = stmts[index]!;
			const last = index === stmts.length - 1;
			switch (stmt.type) {
				case "VariableDeclaration": {
					const desugared = tryAssignDesugar(stmt, stmts[index + 1]);
					if (desugared !== undefined) {
						compileTry(desugared, ctx);
						index++;
						continue;
					}
					if (ifAssignDesugar(stmt, stmts[index + 1], ctx)) {
						index++;
						continue;
					}
					compileDeclaration(stmt, ctx);
					continue;
				}
				case "ExpressionStatement": {
					const expr = stmt.expression;
					if (expr.type === "AwaitExpression") {
						compileAwaited(expr, undefined, ctx, "statement");
						continue;
					}
					if (expr.type === "AssignmentExpression") {
						issue(
							stmt,
							"bindings are single-assignment - declare a new const instead of reassigning",
						);
						continue;
					}
					if (expr.type === "CallExpression") {
						const name = dottedName(expr.callee);
						if (name !== undefined && isMountedTool(name)) {
							// Un-awaited call statement -> detached (fire-and-forget).
							const step = compileCall(expr, mint(), ctx);
							if (step !== undefined) {
								step.await = false;
								pushCall(step, ctx);
							}
							continue;
						}
						// The two bare calls models write most: name the callscript
						// spelling for each, not just the rule.
						if (
							expr.callee.type === "MemberExpression" &&
							!expr.callee.computed &&
							expr.callee.property.type === "Identifier" &&
							expr.callee.property.name === "forEach"
						) {
							issue(
								stmt,
								"forEach cannot fan out - spell it: await Promise.all(list.map(item => tool.name({ ... })))",
							);
							continue;
						}
						if (name !== undefined && name.startsWith("console.")) {
							issue(
								stmt,
								`${name} has nowhere to print - return the value instead (return { ... }); every step's output is already recorded`,
							);
							continue;
						}
						issue(
							stmt,
							name !== undefined
								? `"${name}" is not a mounted tool - a bare statement must be a tool call (await tool.name({ ... }))`
								: "a bare expression does nothing - bind it (const x = ...) or return it",
						);
						continue;
					}
					issue(
						stmt,
						"a bare expression does nothing - bind it (const x = ...) or return it",
					);
					continue;
				}
				case "ReturnStatement":
					if (!last) {
						issue(stmt, "unreachable code after return - the run ends there");
					}
					compileReturn(stmt, ctx);
					continue;
				case "IfStatement":
					compileIf(stmt, ctx);
					continue;
				case "TryStatement":
					compileTry(stmt, ctx);
					continue;
				case "ForOfStatement":
					compileForOf(stmt, ctx);
					continue;
				case "BlockStatement":
					compileStatements(stmt.body, { ...ctx, topLevel: false });
					continue;
				case "EmptyStatement":
					continue;
				case "WhileStatement":
				case "DoWhileStatement":
				case "ForStatement":
				case "ForInStatement":
					issue(
						stmt,
						"unbounded loops cannot run - fan out over a bounded list instead: await Promise.all(items.slice(0, N).map(item => tool.name({ ... })))",
					);
					continue;
				case "FunctionDeclaration":
				case "ClassDeclaration":
					issue(
						stmt,
						"no function/class declarations - helpers are arrow expressions inside a step's own expression",
					);
					continue;
				case "ThrowStatement":
					issue(
						stmt,
						"throw is not available - a failed call already ends the run; to end it yourself, guard: if (cond) return { ... }",
					);
					continue;
				case "SwitchStatement":
					issue(stmt, "switch is not available - use if/else chains");
					continue;
				default:
					issue(stmt, `unsupported statement (${stmt.type})`);
					continue;
			}
		}
	};

	/* -------------------------------- program ------------------------------ */

	const body = [...program.body];
	// Intent: the leading comment's first line, or a leading string directive.
	let intent: string | undefined;
	const firstStart = body[0]?.start ?? source.length;
	const leading = comments.find((c) => c.start < firstStart);
	if (leading !== undefined) {
		intent =
			leading.text
				.split("\n")
				.map((l) => l.replace(/^\s*\*?\s*/, "").trim())
				.find((l) => l.length > 0) ?? undefined;
	}
	if (
		intent === undefined &&
		body[0]?.type === "ExpressionStatement" &&
		body[0].expression.type === "Literal" &&
		typeof body[0].expression.value === "string"
	) {
		intent = body[0].expression.value;
		body.shift();
	}

	compileStatements(body, { topLevel: true });

	if (steps.length === 0 && output !== undefined) {
		// A projection-only script: keep it runnable as one derivation.
		steps.push({ id: mint(), let: output });
		output = undefined;
	}
	if (steps.length === 0 && issues.length === 0) {
		issues.push({
			path: "(script)",
			message:
				"the script is empty - write at least one statement (const x = await tool.name({ ... }))",
		});
	}
	if (issues.length > 0) throw new ScriptValidationError(issues);

	const script: Script = { steps };
	if (intent !== undefined && intent.length > 0) script.intent = intent;
	if (output !== undefined) script.output = output;
	return script;
}
