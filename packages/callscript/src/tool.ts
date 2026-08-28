/**
 * The tool contract - the ONE seam between the engine and whatever
 * provides its tools. The engine never knows about AI SDK tools, v.fns,
 * * or anything else: an ADAPTER turns each of
 * those into this shape, and a plain object literal is already one.
 *
 * - `name` is the registry: a script's `call` names a tool by it, and
 *   the validator rejects anything else before a run starts
 * - `execute` is dispatch: resolved args in, result out. Throw to fail
 *   the step (an error with a string `code` keeps it as the step's
 *   machine-readable error code), throw `earlyReturn(value)` to end the
 *   run here, or throw `suspend({ key, ... })` to park it
 * - the metadata (`description`, schemas, `errors`) is the
 *   tool CARD: what a model sees in its prompt, rendered by `describe`
 */
import type { CallContext, JsonValue, RunState } from "./types";

/** A JSON Schema object - the wire-format type language adapters
 * normalize into (every tool ecosystem can produce one). */
export type JsonSchema = Record<string, unknown>;

/**
 * Everything a dispatch carries besides the args: which step is calling
 * and why, the re-entry channel (`attempt`, `resolutions`,
 * `suspensions` - see `CallContext`), and the hosting run's session
 * record - how a compiled script mounted as a tool joins its caller's
 * session.
 */
export interface ToolCallContext extends CallContext {
	/** Id of the step making this call. */
	stepId: string;
	/** Registry name the call dispatched under. */
	toolName: string;
	/** The step's declared reason, when it carries one. */
	reason?: string;
	/** 0-based element index when part of an `each` fan-out. */
	itemIndex?: number;
	/** The hosting run's accumulated session record at dispatch time. */
	state?: RunState;
	/** Merge a settlement record back into the hosting run - how a
	 * compiled script tool's settled steps survive into the caller's
	 * `result.state` (so a resumed run reuses them). */
	persist?: (state: RunState) => void;
}

/**
 * A tool the engine can mount. `K`/`A`/`R` exist for TYPED script
 * authoring: `engine.script` types each `call` step's `args` (and the
 * scope of later expressions) from the mounted tools' literals.
 */
export interface ScriptTool<K extends string = string, A = any, R = unknown> {
	/** Registry name a script's `call` uses, e.g. `"github.listIssues"`. */
	name: K;
	/** What the tool does - rendered on its card for the authoring model. */
	description?: string;
	/** Args as JSON Schema - rendered TS-ish on the card. Purely
	 * descriptive: validation belongs to the tool/adapter, not the engine. */
	inputSchema?: JsonSchema;
	/** Result as JSON Schema - the card's return type. */
	outputSchema?: JsonSchema;
	/** Declared machine-readable failure codes (rendered on the card;
	 * a thrown error's `code` surfaces as the step error's code). */
	errors?: readonly string[];
	/** Perform one call. See the module doc for the throw protocol. */
	execute(args: A, ctx: ToolCallContext): R | Promise<R>;
}

/** Widest tool shape - what registries and dispatch work against. */
export type AnyScriptTool = ScriptTool<string, any, unknown>;

/** The mounted tools re-keyed by name - the map typed authoring reads. */
export type ToolMap<TS extends readonly AnyScriptTool[]> = {
	[T in TS[number] as T["name"]]: T;
};

/**
 * Identity helper that PINS the literals a plain tool object carries
 * (`name`, the `execute` signature), so `engine.script` can type `call`
 * and `args` without `as const` gymnastics:
 *
 *   const closeIssue = tool({
 *     name: "github.closeIssue",
 *     execute: (args: { repo: string; number: number }) => ({ closed: args.number }),
 *   });
 */
export const tool = <K extends string, A = void, R = unknown>(
	definition: ScriptTool<K, A, R>,
): ScriptTool<K, A, R> => definition;

/** Re-exported for adapter authors: what a resolution payload may be. */
export type { JsonValue };
