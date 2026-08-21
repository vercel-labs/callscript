/**
 * The better-tools adapter: mount a better-tools INSTANCE (or a picked
 * subset - anything carrying `definitions` + `call`) as callscript
 * tools. Purely structural, so there is no package dependency - the
 * definition shape (`{ name, description, input_schema }`) and the
 * dispatch signature are the whole contract:
 *
 *   import { createTools } from "expt-better-tools";
 *   import { scriptEngine } from "callscript";
 *   import { betterTools } from "callscript/better-tools";
 *
 *   const t = createTools();
 *   // ...t.create(...) tools...
 *   const engine = scriptEngine({ tools: betterTools(t) });
 *
 * Dispatch goes through `instance.call`, so hooks, mounted vars, and
 * context seeds apply exactly as they do for a direct `tools.call`.
 * better-tools failure values translate structurally:
 *
 * - a declared refusal (`FnError`-shaped: string `tag`) fails the step
 *   with the TAG as its machine-readable error code
 * - a contract violation (`ValidationError`-shaped: string `path`)
 *   fails it with code `invalid_tool_args`
 * - a defect wrapper (`UnexpectedError`-shaped) is unwrapped when its
 *   cause is one of the engine's control-flow signals, so `earlyReturn`
 *   / `suspend` thrown from a tool's body still end or park the run
 */
import { EarlyReturnSignal, SuspendSignal } from "../execute";
import type { JsonSchema, ScriptTool, ToolCallContext } from "../tool";

/** One tool as better-tools defines it for the AI boundary. */
export type BetterToolDefinition = {
	name: string;
	description: string;
	input_schema: JsonSchema;
};

/** What this adapter programs against: the live tool set surface of a
 * better-tools instance (`createTools(...)`, or a `pick(...)` subset). */
export type BetterToolsInstance = {
	definitions: readonly BetterToolDefinition[];
	call(
		name: string,
		input: unknown,
		callContext?: Record<string, unknown>,
	): unknown;
};

export type BetterToolsOptions = {
	/** Seeds vars for every dispatch, like `tools.call`'s third argument -
	 * the place for per-request state. */
	context?: Record<string, unknown>;
	/** Callscript-level metadata better-tools does not declare per tool. */
	overrides?: Record<
		string,
		{ idempotent?: boolean; errors?: readonly string[] }
	>;
};

/** Translate a better-tools failure into the step-error protocol. */
const asStepError = (thrown: unknown): unknown => {
	if (thrown === null || typeof thrown !== "object") return thrown;
	const err = thrown as {
		name?: string;
		tag?: unknown;
		path?: unknown;
		cause?: unknown;
		code?: unknown;
	};
	// A defect wrapper hiding one of OUR control-flow signals: unwrap it
	// (a tool with declared errors wraps ANY untagged throw).
	if (
		err.cause instanceof EarlyReturnSignal ||
		err.cause instanceof SuspendSignal
	) {
		return err.cause;
	}
	if (err.code === undefined && typeof err.tag === "string") {
		return Object.assign(err, { code: err.tag });
	}
	if (
		err.code === undefined &&
		err.name === "ValidationError" &&
		typeof err.path === "string"
	) {
		return Object.assign(err, { code: "invalid_tool_args" });
	}
	return thrown;
};

/**
 * Mount a better-tools instance. `definitions` is snapshotted when the
 * adapter runs - create tools first, adapt after (re-run `betterTools`
 * to pick up later additions).
 */
export const betterTools = (
	instance: BetterToolsInstance,
	options: BetterToolsOptions = {},
): ScriptTool[] => {
	return instance.definitions.map((definition) => {
		const extra = options.overrides?.[definition.name];
		return {
			name: definition.name,
			description: definition.description,
			inputSchema: definition.input_schema,
			...(extra?.errors ? { errors: extra.errors } : {}),
			...(extra?.idempotent ? { idempotent: true } : {}),
			execute: async (args: unknown, _ctx: ToolCallContext) => {
				try {
					return await instance.call(definition.name, args, options.context);
				} catch (thrown) {
					throw asStepError(thrown);
				}
			},
		};
	});
};
