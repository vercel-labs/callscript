export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ErrorMode = "fail" | "skip";

export interface StepBase {
	/** Unique name; later expressions reference this step's output by this id. */
	id: string;
	/** Expression; when it evaluates falsy the step is skipped (output undefined). */
	if?: string;
	/**
	 * Expression evaluated BEFORE this step's action runs. Truthy → the run
	 * ends here with that value as its output (`returnedAt` names this step)
	 * and the step's action never fires. The expression sees every earlier
	 * settled output plus `input`; on a call step it additionally sees
	 * `$calls`, the resolved calls that WOULD fire, so an approval payload
	 * can carry the concrete preview. Re-executing the run with the same
	 * record re-evaluates the expression — pass different `input` (or edit
	 * the step) to get past it.
	 *
	 * A step with a `return` gate is also a FENCE in the schedule: every
	 * earlier step settles before it is judged, and no later step starts
	 * until it passes — a guard guards everything behind it.
	 *
	 * On a return-ONLY step that also carries an `if`, the `if` is the
	 * decision and the value is the result, falsy included — JS's
	 * `if (cond) return value` exactly. Everywhere else (no `if`, or a
	 * gate riding a call/let step) the value's truthiness decides.
	 */
	return?: string;
	/**
	 * Explicit ordering: earlier step ids this step must wait for even
	 * though its expressions don't read them — effect ordering ("close the
	 * issues, THEN post the summary"). Data references already order; use
	 * this only when no data flows.
	 */
	after?: string[];
}

/** Pure derivation step: binds the value of an expression to `id`. */
export interface LetStep extends StepBase {
	let: string;
}

export interface CallStep extends StepBase {
	/** Name of the tool to invoke, e.g. `"github.listIssues"`. */
	call: string;
	/**
	 * Call arguments. Literal JSON, except strings starting with `=` which are
	 * evaluated as expressions (`==` escapes a literal leading `=`).
	 */
	args?: JsonValue;
	/**
	 * Fan out: an expression evaluating to an ARRAY, each element the full
	 * args of one call - `"stale.map(i => ({ repo: 'api', number: i.number }))"`.
	 * Replaces `args` (compute the whole args list in the expression); the
	 * step's output is the array of results, in element order. Calls run
	 * concurrently (bounded by `limits.maxConcurrency`).
	 */
	each?: string;
	/**
	 * Hard upper bound on `each` elements. If the array is longer the step
	 * fails (slice explicitly in the expression if you want "first N"
	 * semantics). Defaults to `limits.maxItemsPerStep`.
	 */
	max?: number;
	/**
	 * Why the agent is making this call. Feeds the authorizer, approval card,
	 * and audit log. Optional unless validateScript runs with `requireReason`.
	 */
	reason?: string;
	onError?: ErrorMode;
	/**
	 * Self-declared scrutiny: true gates this step behind a "confirm"
	 * suspension (keyed by the step id) exactly as if the host's
	 * `ExecuteOptions.suspend` policy had flagged it — the script's way of
	 * saying "have a human look at this one".
	 */
	suspend?: boolean;
	/**
	 * Whether the script waits for this call (JS semantics: every tool call
	 * is an async operation; `await` only decides if the run blocks on it —
	 * it never changes what the operation is). Default true — except for
	 * host-declared `asyncTools`, which are NOT awaited unless consumed.
	 *
	 * `"await": false` — fire without waiting: under a runner the step
	 * detaches as its OWN background run named by the step id; the rest of
	 * the script settles now, the settlement arrives via the digest, later
	 * scripts join it with `await.<stepId>`, and its output publishes as the
	 * session variable `<stepId>` when it lands. Later steps in the SAME
	 * script may not reference it (validated).
	 *
	 * `"await": true` — wait explicitly (pins a slow `asyncTools` call the
	 * script must confirm without consuming its output).
	 *
	 * Consumption always wins: a value some later step references, or that is
	 * the run's output, resolves synchronously regardless. Excluded from the
	 * step hash (scheduling, not semantics) and ignored by bare
	 * `executeScript` — detachment is a runner concern.
	 */
	await?: boolean;
}

/**
 * A step that is ONLY a conditional early return — a guard clause. Two
 * spellings: with an `if`, the condition decides and the value is the
 * result even when falsy — `{ "if": "stale.length === 0", "return":
 * "{ closed: 0 }" }` is JS's `if (cond) return value`. Without one, the
 * value gates truthily: `{ "return": "stale.length === 0 && { closed: 0 }" }`
 * — falsy → the step settles as done (output undefined) and the run
 * continues.
 */
export interface ReturnStep extends StepBase {
	return: string;
}

/**
 * One step shape, three verbs: `call` (invoke a tool), `let` (pure
 * derivation), or a bare `return` (guard clause). Steps are authored in
 * order but SCHEDULED by dependency: a step waits for the steps its
 * expressions reference (plus any `after` ids); independent steps run
 * concurrently (bounded by `limits.maxConcurrency`). Forward references
 * stay illegal - document order is the authoring order.
 */
export type Step = LetStep | CallStep | ReturnStep;

export interface Script {
	version?: "2";
	/**
	 * Agent-chosen run name. A runner stores the run under this id: other
	 * scripts join it with an `await.<id>` call, and the host reports its
	 * settlement under this name. Same identifier grammar as step ids —
	 * letters, digits, `_`, no dots (dots would break `await.<id>` names).
	 * Optional; a runner mints `r1`, `r2`, ... when omitted.
	 */
	id?: string;
	/**
	 * Whether the submitter waits for the whole run (default true). With
	 * `"await": false` the run MAY detach: a runner executes it in the fast
	 * lane up to its deadline and, if still unfinished, answers `pending`
	 * with the run id instead of blocking — the result arrives later via the
	 * settlement digest, a host push, or an explicit `await.<id>` call.
	 * Ignored by plain `executeScript` (detachment is a runner concern).
	 */
	await?: boolean;
	/** One-line human-readable intent; shown on the approval card.
	 * validateScript derives one from the first call's reason when omitted. */
	intent?: string;
	/** @deprecated Accepted alias of {@link Script.intent} — validateScript
	 * normalizes `goal` into `intent`. */
	goal?: string;
	steps: Step[];
	/**
	 * Expression projecting the run's final output from any settled step.
	 * Default: the last step's value.
	 */
	output?: string;
}

export function isCallStep(step: Step): step is CallStep {
	return "call" in step && (step as CallStep).call !== undefined;
}

export function isLetStep(step: Step): step is LetStep {
	return "let" in step && (step as LetStep).let !== undefined;
}

export function isReturnStep(step: Step): step is ReturnStep {
	return "return" in step && !isCallStep(step) && !isLetStep(step);
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScriptLimits {
	/** Max steps per script. */
	maxSteps: number;
	/** Max `max` any single `each` step may declare. */
	maxItemsPerStep: number;
	/** Max worst-case total calls per script (Σ max). */
	maxTotalCalls: number;
	/** Max AST nodes evaluated per expression (loop/complexity budget). */
	maxExprNodes: number;
	/** Max concurrent work: independent steps in flight, and calls in
	 * flight inside one `each` fan-out. */
	maxConcurrency: number;
	/** Max serialized size of a single call's result, in bytes. */
	maxCallResultBytes: number;
	/**
	 * Max times a single suspension key may be raised before the step fails
	 * with code "suspend_limit" - bounds resolve/re-suspend loops. Pure timed
	 * waits (`retryAfterMs` with no `interaction`) are exempt: polling until
	 * a job finishes is progress, not a loop.
	 */
	maxSuspendAttempts: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
	maxSteps: 20,
	maxItemsPerStep: 100,
	maxTotalCalls: 200,
	maxExprNodes: 100_000,
	maxConcurrency: 5,
	maxCallResultBytes: 10 * 1024 * 1024, // 10 MiB
	maxSuspendAttempts: 5,
};

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

export interface CallAnalysis {
	stepId: string;
	/** Name of the tool this step calls. */
	tool: string;
	reason?: string;
	conditional: boolean;
	/** Worst-case number of calls this step can make (1, or the `each` bound). */
	maxCalls: number;
	/** True when the step declares a `return` — it may end the run before its calls fire. */
	returns: boolean;
}

export interface ScriptAnalysis {
	intent?: string;
	/** @deprecated Alias of {@link ScriptAnalysis.intent} (accepted as `goal` on input). */
	goal?: string;
	calls: CallAnalysis[];
	/** Unique tool names the script uses. */
	tools: string[];
	worstCaseCalls: number;
	/** Step ids (call, let, AND return steps) that may end the run early. */
	returns: string[];
	/**
	 * Free names no step in this script produces — session variables the run
	 * expects from `ExecuteOptions.variables`. Lets a host prefetch exactly
	 * these before executing (and reject/refresh missing ones up front).
	 */
	external: string[];
}

/**
 * One entry per leaf step of `planExecution`: what executing a script
 * against a prior record will do with that step. `action: "reuse"` — the
 * settled output is imported, nothing runs. `action: "run"` — the step
 * executes, with `why` saying why: it's new, it changed since the record
 * (side effects re-fire — surface this on approval cards!), it's a
 * re-entry point (`returned` / `error`), or its settled output was
 * memory-released and a running step needs it (`released`).
 */
export interface StepPlan {
	id: string;
	action: "reuse" | "run";
	why:
		| "settled"
		| "new"
		| "changed"
		| "returned"
		| "error"
		| "suspended"
		| "released";
	/** Tool name when the step is a call step — the side-effect flag. */
	tool?: string;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/** A single resolved tool invocation handed to the host. */
export interface CallRequest {
	stepId: string;
	/** Name of the tool to invoke. */
	tool: string;
	/** Fully resolved arguments (expressions already evaluated). */
	args: unknown;
	reason?: string;
	/** 0-based element index when part of an `each` fan-out. */
	itemIndex?: number;
}

/* -------------------------------------------------------------------------- */
/* Suspension                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the user is asked to do when a run suspends — the host-renderable
 * face of a suspension (a confirm card, a sign-in link, ...). The runtime
 * never interprets it; hosts render `kind` however they like.
 */
export interface InteractionRequest {
	/** Stable id for the interaction (usually the suspension's key). */
	id: string;
	/** "confirm" (yes/no decision), "link" (visit a URL), or any host kind. */
	kind: string;
	/** One-line headline, e.g. `"weather.setLocation" needs your approval`. */
	title?: string;
	/** Supporting detail — typically the step's `reason`. */
	detail?: string;
	/** Structured payload for the renderer (url, poll hint, call preview...). */
	props?: JsonValue;
}

/**
 * One thing a run is waiting on. Raised by throwing `suspend({ key, ... })`
 * from a call handler/middleware, or by the interpreter itself when a step
 * needs confirmation (`suspend: true` on the step, or the host's
 * `ExecuteOptions.suspend` policy — keyed by the STEP ID). The run resumes
 * by re-executing with the answer under `ExecuteOptions.resolutions[key]`.
 */
export interface SuspensionRequest {
	/** Unique key the resolution must come back under. */
	key: string;
	/** Step that raised it — filled in by the interpreter when absent. */
	stepId?: string;
	/** Tool that step calls — filled in by the interpreter when absent. */
	tool?: string;
	/** 0-based `each` element index, when raised from an item dispatch. */
	itemIndex?: number;
	/** What the user is asked to do. Absent on pure timed waits. */
	interaction?: InteractionRequest;
	/** Opaque payload round-tripped to the raiser via `CallContext.suspensions`
	 * on the next dispatch (server-side run state, approval ids, ...). */
	data?: JsonValue;
	/** Re-dispatch after this many ms — a poll hint. With no `interaction`
	 * this is a pure timed wait: nothing for the user to do. */
	retryAfterMs?: number;
}

/** Per-dispatch context handed to `ExecuteHandlers.call`. */
export interface CallContext {
	/**
	 * How many times this step has previously ended the run early (via a
	 * handler's `earlyReturn`/`suspend` or its own `return`). 0 on first
	 * dispatch — lets re-entrant middleware detect that it is being retried.
	 */
	attempt: number;
	/** Times each suspension key has been raised so far (across the session). */
	attempts: Record<string, number>;
	/** Answers delivered for this execute — `resolutions[key]` is how a
	 * handler learns the user acted on its suspension. */
	resolutions: Record<string, JsonValue>;
	/** Outstanding suspensions from the prior round, `data` intact — how a
	 * re-dispatched handler recovers what it parked (approval ids, ...). */
	suspensions: SuspensionRequest[];
}

export interface ExecuteHandlers {
	/**
	 * Perform one tool call. Throw to signal failure (handled per step's
	 * onError), throw `earlyReturn(value)` to end the run here with `value`
	 * as its output, or throw `suspend({ key, ... })` to park the run on an
	 * external event — the step re-dispatches on the next execute (with the
	 * resolution under `ctx.resolutions[key]`, when one was delivered).
	 */
	call(request: CallRequest, ctx: CallContext): Promise<unknown>;
}

export type ItemStatus = "done" | "error" | "suspended";

export interface ItemState {
	status: ItemStatus;
	output?: unknown;
	error?: SerializedError;
}

export type StepStatus =
	| "done"
	| "skipped"
	| "returned"
	| "error"
	| "suspended";

export interface SerializedError {
	message: string;
	code?: string;
}

export interface StepState {
	/**
	 * Hash of the authored step definition (expressions unresolved). THE
	 * reconciliation key: on re-execute this state is reused only when the
	 * incoming step with the same id hashes identically — otherwise the step
	 * counts as changed and runs again.
	 */
	hash: string;
	/**
	 * done/skipped are settled (reused on re-execute). returned/error/
	 * suspended are re-entry points: the step runs again on the next execute.
	 */
	status: StepStatus;
	/** Resolved output value. For status "returned", the value the run returned. */
	output?: unknown;
	error?: SerializedError;
	/** Per-item outcomes for `each` steps ("done" items are never re-called). */
	items?: ItemState[];
	/** Outstanding suspensions raised by this step's last dispatch. */
	suspensions?: SuspensionRequest[];
	/** Times this step ended the run early (drives `CallContext.attempt`). */
	attempts?: number;
	/** Number of calls actually performed. */
	calls?: number;
	durationMs?: number;
	/**
	 * True when the output was dropped after its last static reference
	 * (memory optimization; see ExecuteOptions.retainOutputs).
	 */
	released?: boolean;
}

/**
 * THE state object — there is exactly one. A record is both the image of
 * the last run AND the whole session: executing against a prior record
 * carries every entry forward, so chaining `state: last.record` across runs
 * accumulates everything the agent has ever computed. Per incoming step,
 * id+hash matching decides reuse vs run; entries no current step declares
 * carry verbatim and bind as read-only session variables (see
 * `publishedVariables` for the publish rule). Redeclaring an id overwrites
 * its entry when the new step settles, JS `let`-style.
 */
export interface RunState {
	version: "2";
	/** The script last executed against this record, verbatim (audit trail). */
	script: Script;
	/** done: ran to the end · returned: ended early at `at` · error: failed
	 * at `at` · suspended: parked waiting on `steps[at].suspensions`. */
	status: "done" | "returned" | "error" | "suspended";
	/** Step id the last run returned, failed, or (first) suspended at. */
	at?: string;
	/** Latest state per step id, across every run in the session. */
	steps: Record<string, StepState>;
	/** Times each suspension key has been raised (drives the
	 * `maxSuspendAttempts` guard; timed waits are never counted). */
	suspendAttempts?: Record<string, number>;
}

/** @deprecated Renamed to {@link RunState}. */
export type RunRecord = RunState;

/**
 * Every run settles: it ran to the end (output = the projected/last value),
 * returned early (`returnedAt` names the step), a step failed, or it
 * suspended waiting on the world (`suspensions` says what for). Re-execute
 * with `state` (plus `resolutions` for suspensions) to continue — settled
 * steps are reused, not re-run. `record` is a deprecated alias of `state`.
 */
export type ExecuteResult =
	| {
			status: "ok";
			output: unknown;
			/** Set when the run ended early at this step's `return` (or a handler's earlyReturn). */
			returnedAt?: string;
			state: RunState;
			/** @deprecated Use `state`. */
			record: RunState;
	  }
	| {
			status: "error";
			at: string;
			error: SerializedError;
			state: RunState;
			/** @deprecated Use `state`. */
			record: RunState;
	  }
	| {
			status: "suspended";
			/** Everything the run is waiting on, across all suspended steps. */
			suspensions: SuspensionRequest[];
			state: RunState;
			/** @deprecated Use `state`. */
			record: RunState;
	  };

export interface ExecuteOptions {
	handlers: ExecuteHandlers;
	limits?: Partial<ScriptLimits>;
	/** The session state to execute against: settled steps whose hash still
	 * matches are reused; changed/new steps and returned/error/suspended
	 * steps run; all other entries carry forward and bind as session
	 * variables. The result's `state` is this state updated — store it and
	 * pass it to the next run. */
	state?: RunState;
	/**
	 * Answers to outstanding suspensions, by key: a step-confirm key (the
	 * STEP ID — truthy proceeds, falsy denies with code "denied") or a
	 * handler-chosen key (delivered as `CallContext.resolutions[key]`).
	 * Consumed by THIS execute only — never persisted in the state.
	 */
	resolutions?: Record<string, JsonValue>;
	/**
	 * The per-step scrutiny policy: judged before each call step dispatches
	 * (steps with `suspend: true` are gated regardless). Returning true
	 * raises a "confirm" suspension keyed by the STEP ID, with the resolved
	 * calls preview in the interaction's props — unless a resolution for
	 * that key already arrived. Default: nothing suspends.
	 */
	suspend?: (info: {
		stepId: string;
		tool: string;
	}) => boolean | Promise<boolean>;
	/**
	 * Per-execute data, bound as `input` in every expression. Ephemeral: it
	 * is never persisted in the record — only outputs derived from it are.
	 * This is how a host pipes an auth code, an approval, or any context into
	 * a re-execute: `args: { "code": "=input.code" }`,
	 * `return: "!input.approved && {...}"`.
	 */
	input?: unknown;
	/**
	 * Session variables: read-only values bound by name in every expression —
	 * typically step outputs published by earlier runs (`publishedVariables`),
	 * making the session a notebook whose cells share a namespace. A name
	 * declared as a step id in THIS script is ignored (the new step owns the
	 * name and overwrites the variable when it settles). Validate with the
	 * same names (`ValidateOptions.variables`). Never persisted in the record.
	 */
	variables?: Record<string, unknown>;
	/** @deprecated Alias of {@link ExecuteOptions.variables} (variables win a name clash). */
	bindings?: Record<string, unknown>;
	/**
	 * "live" (default): a step's output is dropped from memory and the record
	 * as soon as no later expression can reference it (statically known).
	 * "all": keep every output for the whole run (full audit state, more memory).
	 */
	retainOutputs?: "live" | "all";
}
