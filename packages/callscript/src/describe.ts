/**
 * Agent-facing context: what a model needs in its prompt to AUTHOR
 * scripts against an engine. Three layers, split by change-rate (which
 * is also prompt-cache order):
 *
 * - the LANGUAGE card - static per language version (`languageCard`)
 * - the TOOL cards - static per engine: one TS-ish signature per mounted
 *   tool, rendered from its declared JSON Schemas (`toolCard`)
 * - the SESSION card - fresh every turn: the referable names with value
 *   PREVIEWS, because a model writing `issues.filter(i => i.stale)`
 *   needs to see the fields, not a type (`sessionCard`, `previewValue`)
 *
 * `engine.describe()` assembles the static two; `engine.context(scope)`
 * renders the live one. The fourth channel is not a prompt at all: the
 * validator reports every issue with pointed messages, and step errors
 * carry machine-readable codes - feed them back verbatim.
 *
 * There is a second static shape for hosts that mount the ENGINE as one
 * tool of an agent: `scriptJsonSchema` is the script format as an
 * annotated JSON Schema (the tool's input schema teaches the step
 * shapes field by field), and `baseCard` is the remaining prose - the
 * semantics a schema cannot carry. `engine.toolDefinition()` pairs them.
 */
import { ID_PATTERN } from "./schema";
import type { JsonSchema } from "./tool";
import { DEFAULT_LIMITS, type ScriptLimits } from "./types";

/** The slice of a tool this module reads - structurally, so anything
 * carrying a `name` and the descriptive metadata renders. */
export type IntrospectableTool = {
	name: string;
	description?: string;
	inputSchema?: JsonSchema;
	outputSchema?: JsonSchema;
	errors?: readonly string[];
	idempotent?: boolean;
};

/* ------------------------------ type cards ------------------------------- */

/**
 * Render a JSON Schema as a compact TS-ish type. TS syntax on purpose:
 * the expression language IS JavaScript, so the model reads and writes
 * one idiom - and it is a fraction of the tokens of raw JSON Schema.
 */
export const renderJsonSchemaType = (schema: unknown, depth = 0): string => {
	if (schema === undefined || schema === null || schema === true) return "any";
	if (schema === false) return "never";
	if (typeof schema !== "object") return "any";
	if (depth > 6) return "any";
	const s = schema as Record<string, any>;
	const render = (child: unknown) => renderJsonSchemaType(child, depth + 1);
	// A union or arrow element needs parens to bind before `[]`.
	const arrayOf = (element: string) =>
		/[|)]\s|=>|\|/.test(element) ? `(${element})[]` : `${element}[]`;

	if (s.const !== undefined) return JSON.stringify(s.const);
	if (Array.isArray(s.enum)) {
		return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
	}
	const variants = s.anyOf ?? s.oneOf;
	if (Array.isArray(variants)) {
		return [...new Set(variants.map(render))].join(" | ");
	}
	if (Array.isArray(s.allOf) && s.allOf.length === 1) return render(s.allOf[0]);

	const type = Array.isArray(s.type) ? s.type : [s.type];
	if (type.length > 1) {
		return type.map((t: unknown) => render({ ...s, type: t })).join(" | ");
	}
	switch (type[0]) {
		case "string":
		case "boolean":
		case "number":
			return type[0];
		case "integer":
			return "number";
		case "null":
			return "null";
		case "array": {
			// Tuple form (prefixItems / positional items array) or list form.
			const prefix =
				s.prefixItems ?? (Array.isArray(s.items) ? s.items : undefined);
			if (Array.isArray(prefix)) return `[${prefix.map(render).join(", ")}]`;
			return s.items === undefined ? "any[]" : arrayOf(render(s.items));
		}
		case "object": {
			const props = s.properties as Record<string, unknown> | undefined;
			if (props === undefined || Object.keys(props).length === 0) {
				const extra = s.additionalProperties;
				return extra !== undefined && typeof extra === "object"
					? `Record<string, ${render(extra)}>`
					: "object";
			}
			const required = new Set<string>(
				Array.isArray(s.required) ? s.required : [],
			);
			const fields = Object.entries(props).map(
				([field, child]) =>
					`${field}${required.has(field) ? "" : "?"}: ${render(child)}`,
			);
			return `{ ${fields.join(", ")} }`;
		}
		default:
			return "any";
	}
};

/** One tool as a signature line, its description right under it (plus
 * its declared error codes, when it has any):
 *
 *   github.closeIssue({ repo: string, number: number }) -> { closed: number }
 *     close an issue by number
 *     errors: not_found
 */
export const toolCard = (tool: IntrospectableTool): string => {
	const args =
		tool.inputSchema === undefined
			? "()"
			: `(${renderJsonSchemaType(tool.inputSchema)})`;
	const out =
		tool.outputSchema === undefined
			? ""
			: ` -> ${renderJsonSchemaType(tool.outputSchema)}`;
	const lines = [`${tool.name}${args}${out}`];
	if (tool.description) {
		lines.push(`  ${tool.description.trim().replace(/\s*\n\s*/g, " ")}`);
	}
	if (tool.errors?.length) lines.push(`  errors: ${tool.errors.join(", ")}`);
	if (tool.idempotent) {
		lines.push("  idempotent (same args -> one call per session)");
	}
	return lines.join("\n");
};

export const toolCards = (tools: readonly IntrospectableTool[]): string =>
	tools.map(toolCard).join("\n");

/**
 * Find mounted tools by keyword - the engine's `search` agent tool runs
 * on this. Tokens match against the name (whole, segment, substring),
 * the description, and the rendered card (so schema field names hit
 * too), name matches scoring above description matches. An empty query
 * lists tools in mount order.
 */
export const searchTools = (
	tools: readonly IntrospectableTool[],
	query: string,
	limit = 10,
): IntrospectableTool[] => {
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (tokens.length === 0) return tools.slice(0, limit);
	const scored = tools.flatMap((tool) => {
		const name = tool.name.toLowerCase();
		const segments = name.split(/[._-]/);
		const description = (tool.description ?? "").toLowerCase();
		const card = toolCard(tool).toLowerCase();
		let score = 0;
		for (const token of tokens) {
			if (name === token) score += 8;
			else if (segments.includes(token)) score += 5;
			else if (name.includes(token)) score += 3;
			if (description.includes(token)) score += 2;
			else if (card.includes(token)) score += 1;
		}
		return score > 0 ? [{ tool, score }] : [];
	});
	scored.sort(
		(a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
	);
	return scored.slice(0, limit).map((entry) => entry.tool);
};

/* ----------------------------- language card ------------------------------ */

/**
 * The script language, as prompt text - rendered against the ENGINE's
 * limits so the numbers the model plans around are the ones enforced.
 * Static per engine: cache it as a prompt prefix.
 */
export const languageCard = (options: DescribeOptions = {}): string => {
	const lim = { ...DEFAULT_LIMITS, ...options.limits };
	return `## callscript

You act by sending ONE script - a JSON plan of tool calls - instead of
calling tools one at a time. The script is validated before anything runs
(every issue reported at once) and executes with bounded call counts.

{ "intent": "one line of intent", "steps": [ ... ], "output": "expr"? }

Every step is ONE shape carrying one of three verbs:
  { "id": "x", "call": "tool.key", "args": { ... }, "reason": "why" }   invoke a tool
  { "id": "x", "let": "expr" }                                          derive a value
  { "if": "expr", "return": "expr" }                                    guard clause

Steps are written in order but RUN by dependency: a step waits for the
step ids its expressions reference (plus any listed in "after");
independent steps run concurrently. A step with a "return" gate is a
FENCE - everything before it settles first, nothing after it starts
until it passes.

Steps also take:
  "each": "expr"      call steps fan out: the expression yields the ARRAY
      of args, one call per element - "stale.map(i => ({ repo: 'api',
      number: i.number }))". Replaces "args"; the step's output is the
      array of results, in element order
  "max": N            bound on "each" elements (<= ${lim.maxItemsPerStep})
  "if": "expr"        falsy skips the step (its output stays undefined)
  "return": "expr"    evaluated BEFORE the action: truthy ENDS THE RUN with
      that value. On a return-ONLY step that also has an "if", the "if"
      decides and the value is the result even when falsy (a JS guard
      clause). On a call step it sees \`$calls\` (the resolved calls about
      to be made), so it can gate:
      "return": "!input.approved && { confirm: $calls.map(c => c.args) }"
  "after": ["id"]     wait for earlier steps nothing here reads (effect ordering)
  "onError": "skip"   a failed call skips this step instead of failing the
      run, and records its failure: later expressions read it as
      \`$errors.<stepId>\` ({ message, code }; a per-element list on an
      "each" step) - undefined when the step succeeded
  "suspend": true     pause for confirmation before this step runs

Expressions are pure JavaScript EXPRESSIONS - no statements, no
assignment, no await. They may reference earlier step ids, session
variables, \`input\` (per-run data), and \`$errors.<stepId>\` (a skipped
failure - use a literal step id). Arrows, ternaries, and template
literals work; available globals: Math, JSON, Date, Object, Array,
Number, String, Boolean, Base64. Inside "args", a string starting with
"=" is an expression ("=issue.number") and any other string is a
literal; whole-expression positions (let / if / return / each / output)
take the expression directly, without "=".

Rules:
- steps may only reference EARLIER step ids
- every fan-out is bounded: "max" <= ${lim.maxItemsPerStep}, at most ${lim.maxSteps} steps,
  and at most ${lim.maxTotalCalls} worst-case calls per script
- the run's output is the LAST step's value unless "output" projects one${
		options.requireReason
			? '\n- every call step MUST carry a non-empty "reason"'
			: ""
	}`;
};

/**
 * The JS-surface language card - the ENTIRE instruction for the default
 * authoring format. Deliberately small: the surface is the JavaScript
 * the model already writes, so the card only marks the boundaries, and
 * the validator's pointed messages teach the rest on retry.
 */
export const jsLanguageCard = (options: DescribeOptions = {}): string => {
	const lim = { ...DEFAULT_LIMITS, ...options.limits };
	return `## callscript

You act by sending ONE short script of tool calls, written as plain
JavaScript. It is parsed and validated - NEVER executed as JS: only
mounted tools can run, every issue is reported at once before anything
runs, and all fan-outs are bounded.

// close stale issues                                  <- first comment = intent
const issues = await repo.listIssues({ name: "api" });     // call a tool
const stale = issues.filter(i => i.stale);                 // derive a value (pure expression)
if (stale.length === 0) return { closed: 0 };              // guard: end the run early
const closed = await Promise.all(                          // fan out, bounded by the slice
  stale.slice(0, 10).map(i => repo.closeIssue({ name: "api", number: i.number })));
return { count: closed.length };                           // last statement = the run's output

More forms:
  const [a, b] = await Promise.all([x.one({}), y.two({})]); // independent calls run concurrently
  try { await repo.closeIssue({ ... }) }                    // without try/catch, a failed call
  catch (e) { await chat.post({ text: e.message }); }       //   fails the run; e = { message, code }
  const job = svc.export({ ... });   // no await: fire-and-forget; a LATER script joins it: await job
  await x.del({ id }, { reason: "why", suspend: true });    // per-call options: reason, suspend
                                                            //   (ask a human first), onError: "skip"

Rules:
- const only, single assignment; no while/for(;;), function, class, or import -
  fan out with .map over a bounded list
- awaited calls run in statement order; Promise.all runs them concurrently
- expressions are pure JS (arrows, ternaries, template literals, ?.) - no new,
  no regex; globals: Math, JSON, Date, Object, Array, Number, String, Boolean, Base64
- \`input\` holds per-run data (auth codes, approvals) when a run is re-executed
- limits: ${lim.maxSteps} steps, ${lim.maxItemsPerStep} calls per fan-out, ${lim.maxTotalCalls} calls total per script${
		options.requireReason
			? '\n- every call must carry { reason: "..." } options'
			: ""
	}`;
};

/**
 * The input schema for the JS surface: one string field. The language
 * rides the description (`jsLanguageCard`) - a string schema has nothing
 * to teach field-by-field.
 */
export const jsScriptInputSchema = (): Record<string, unknown> => ({
	type: "object",
	properties: {
		script: {
			type: "string",
			description:
				"The callscript program: plain JavaScript statements (const, await " +
				"tool calls, Promise.all, if/return guards, try/catch). Parsed and " +
				"validated - never executed as JS.",
		},
	},
	required: ["script"],
	additionalProperties: false,
});

/* ----------------------------- tool definition ---------------------------- */

/** Options both static shapes render against - the engine's, so the
 * bounds the model plans around are the ones enforced. */
export type DescribeOptions = {
	limits?: Partial<ScriptLimits>;
	requireReason?: boolean;
};

/**
 * The script format as ONE annotated JSON Schema - for hosts that mount
 * the engine as a single tool of an agent, this is the tool's input
 * schema. Every field carries its own description, so the step shapes
 * teach themselves and the prompt prose shrinks to `baseCard` (the
 * semantics a schema cannot say: expressions, ordering, the "=" rule).
 * Rendered against the engine's limits; static per engine, cache it.
 */
export const scriptJsonSchema = (
	options: DescribeOptions = {},
): Record<string, unknown> => {
	const lim = { ...DEFAULT_LIMITS, ...options.limits };
	const expr = (description: string) => ({
		type: "string",
		description: `${description} A pure JS expression, written directly (no "=" prefix here).`,
	});
	const step = {
		type: "object",
		description:
			'One step. The verb is "call" (invoke a tool), "let" (derive a value), or a bare "return" (guard clause) - exactly one of "call"/"let". ' +
			'Steps are written in order but RUN by dependency: a step waits for the step ids its expressions reference (plus "after"); independent steps run concurrently.',
		properties: {
			id: {
				type: "string",
				pattern: ID_PATTERN.source,
				description:
					"Name of this step's output; later expressions reference it. Auto-assigned (s1, s2, ...) when omitted.",
			},
			call: {
				type: "string",
				description: "The tool to invoke, by key (see the tools list).",
			},
			let: expr("The value this step publishes under its id - no tool call."),
			args: {
				description:
					'Arguments for the tool ("call" only). A string starting with "=" is an expression ("=issue.number"); any other string is a literal ("==" escapes a literal leading "=").',
			},
			each: expr(
				'Fan out ("call" only): yields the ARRAY of args, one call per element - "stale.map(i => ({ repo: \'api\', number: i.number }))". Replaces "args"; the step\'s output is the array of results, in element order.',
			),
			max: {
				type: "integer",
				minimum: 1,
				maximum: lim.maxItemsPerStep,
				description:
					'Hard bound on "each" elements (the step fails if the array is longer - slice in the expression for "first N").',
			},
			reason: {
				type: "string",
				description: "Why this call is being made.",
			},
			if: expr("Falsy skips this step (its output stays undefined)."),
			return: expr(
				"Evaluated BEFORE the step's action: truthy ENDS THE RUN with that value. " +
					'On a return-ONLY step that also has an "if", the "if" decides and the value is the result even when falsy (a JS guard clause). ' +
					'On a call step it sees `$calls` (the resolved calls about to be made), so it can gate: "!input.approved && { confirm: $calls.map(c => c.args) }". ' +
					"A return-gated step is a FENCE: everything before it settles first, nothing after it starts until it passes.",
			),
			after: {
				type: "array",
				items: { type: "string", pattern: ID_PATTERN.source },
				description:
					"EARLIER step ids to wait for even though no expression here reads them - effect ordering. Data references already order steps.",
			},
			onError: {
				enum: ["fail", "skip"],
				description:
					'"skip": a failed call skips this step instead of failing the run, and records the failure - later expressions read it as `$errors.<stepId>` (undefined when the step succeeded).',
			},
			suspend: {
				type: "boolean",
				description: "Pause for confirmation before this step runs.",
			},
			await: {
				type: "boolean",
				description:
					"false: fire without waiting (under a session runner the call detaches; join it later with an await.<stepId> call).",
			},
		},
		anyOf: [
			{ required: options.requireReason ? ["call", "reason"] : ["call"] },
			{ required: ["let"] },
			{ required: ["return"] },
		],
		additionalProperties: false,
	};
	return {
		type: "object",
		description:
			"One script: a plan of tool calls, validated before anything runs (every issue reported at once). " +
			"Steps may only reference EARLIER step ids and run concurrently whenever no data flows between them; " +
			`at most ${lim.maxSteps} steps and ${lim.maxTotalCalls} worst-case calls per script.`,
		properties: {
			intent: { type: "string", description: "One line of intent." },
			id: {
				type: "string",
				pattern: ID_PATTERN.source,
				description:
					"Optional run name (a detached session run is joined by it: await.<id>).",
			},
			await: {
				type: "boolean",
				description:
					"Session runs only: false starts the whole run detached instead of waiting for it.",
			},
			steps: {
				type: "array",
				minItems: 1,
				maxItems: lim.maxSteps,
				items: { $ref: "#/$defs/step" },
			},
			output: expr(
				"Projects the run's output; defaults to the last step's value.",
			),
		},
		required: ["steps"],
		additionalProperties: false,
		$defs: { step },
	};
};

/**
 * The prose HALF of a tool definition - only what the schema cannot
 * carry: what a script IS, how expressions work, and the ordering
 * rules. The step shapes live in `scriptJsonSchema`; do not pair this
 * with `languageCard` (they overlap - `languageCard` is for hosts that
 * prompt the whole language as text).
 */
export const baseCard = (options: DescribeOptions = {}): string => {
	const lim = { ...DEFAULT_LIMITS, ...options.limits };
	return `## callscript

You act by sending ONE script - a JSON plan of tool calls (see the input
schema) - instead of calling tools one at a time. The script is validated
before anything runs (every issue reported at once) and executes with
bounded call counts. Steps are written in order but RUN by dependency:
a step waits for the step ids its expressions reference (plus "after");
independent steps run concurrently, and a "return" gate fences.

Expressions are pure JavaScript EXPRESSIONS - no statements, no
assignment, no await. They may reference earlier step ids, session
variables, \`input\` (per-run data), and \`$errors.<stepId>\` (the failure
an "onError": "skip" step recorded - use a literal step id; undefined
when it succeeded). Arrows, ternaries, and template literals work;
available globals: Math, JSON, Date, Object, Array, Number, String,
Boolean, Base64. Inside "args", a string starting with "=" is an
expression ("=issue.number") and any other string is a literal;
whole-expression positions (let / if / return / each / output) take the
expression directly, without "=".

Rules:
- steps may only reference EARLIER step ids
- every fan-out is bounded: "max" <= ${lim.maxItemsPerStep}, at most ${lim.maxSteps} steps,
  and at most ${lim.maxTotalCalls} worst-case calls per script
- the run's output is the LAST step's value unless "output" projects one${
		options.requireReason
			? '\n- every call step MUST carry a non-empty "reason"'
			: ""
	}`;
};

/* ------------------------------ session card ------------------------------ */

/** A short single-line preview of a runtime value: enough to see WHICH
 * FIELDS EXIST (that is what expressions get written against), never the
 * whole payload. Arrays show the first element plus a count. */
export const previewValue = (value: unknown, max = 72): string => {
	const text = preview(value, 2);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const preview = (value: unknown, depth: number): string => {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "string") {
		return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value);
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "function") return "fn";
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		// A short list of primitives shows whole; anything else shows the
		// first element (the FIELDS matter, not the rows) plus a count.
		const primitive = value.every((x) => x === null || typeof x !== "object");
		if (primitive && value.length <= 5) {
			return `[${value.map((x) => preview(x, 0)).join(", ")}]`;
		}
		const first = preview(value[0], depth - 1);
		return value.length === 1
			? `[${first}]`
			: `[${first}, …${value.length} items]`;
	}
	if (typeof value === "object") {
		if (depth <= 0) return "{…}";
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return "{}";
		const shown = entries
			.slice(0, 4)
			.map(([k, v]) => `${k}: ${preview(v, depth - 1)}`);
		return `{${shown.join(", ")}${entries.length > 4 ? ", …" : ""}}`;
	}
	return typeof value;
};

export type SessionEntry = {
	name: string;
	value: unknown;
	/** "step": published by a settled step of a prior run · "var": a
	 * declared module var the scope currently holds. */
	source: "step" | "var";
};

/** The live half of the prompt: every name expressions can reference
 * right now, with a value preview and where it came from. */
export const sessionCard = (entries: readonly SessionEntry[]): string => {
	if (entries.length === 0) return "session: (empty - no variables set)";
	const width = Math.max(...entries.map((e) => e.name.length));
	const lines = entries.map(
		(e) =>
			`  ${e.name.padEnd(width)} = ${previewValue(e.value)}  (${e.source})`,
	);
	return ["session variables (referable from expressions):", ...lines].join(
		"\n",
	);
};
