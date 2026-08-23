import { collectArgExprs, resolveArgs } from "./args";
import { evalExpr } from "./expr/eval";
import {
	collectRefs,
	ExprError,
	errorSelectors,
	GLOBAL_NAMES,
	parseExpr,
} from "./expr/parse";
import { sha256Hex } from "./hash";
import {
	type CallContext,
	type CallRequest,
	type CallStep,
	DEFAULT_LIMITS,
	type ExecuteOptions,
	type ExecuteResult,
	type ItemState,
	isCallStep,
	isReturnStep,
	type JsonValue,
	type RunState,
	type Script,
	type ScriptLimits,
	type SerializedError,
	type Step,
	type StepPlan,
	type StepState,
	type SuspensionRequest,
} from "./types";

export class ScriptExecutionError extends Error {
	readonly stepId: string;
	readonly code: string;

	constructor(message: string, stepId: string, code: string = "call_failed") {
		super(message);
		this.stepId = stepId;
		this.code = code;
		this.name = "ScriptExecutionError";
	}
}

/**
 * Thrown (never returned) by a call handler or middleware to end the run
 * early with `value` as its output - the runtime analogue of a step's
 * `return` expression. The step records status "returned" and re-dispatches
 * on the next execute (with `CallContext.attempt` incremented), so a
 * device-auth link, a poll-again hint, or any wait-for-the-world payload is
 * just a value the host interprets. Throwing - rather than a sentinel
 * return - lets the signal compose through nested middleware untouched.
 */
export class EarlyReturnSignal extends Error {
	readonly value: unknown;

	constructor(value: unknown) {
		super("Early return");
		this.value = value;
		this.name = "EarlyReturnSignal";
	}
}

/** Convenience factory: `throw earlyReturn({ kind: "link", url })`. */
export function earlyReturn(value: unknown): EarlyReturnSignal {
	return new EarlyReturnSignal(value);
}

/**
 * Thrown (never returned) by a call handler or middleware to park the run
 * on an external event — an approval, a sign-in, a slow job. The step
 * records status "suspended" and the run settles as `status: "suspended"`
 * with the request in `suspensions`; re-executing with the answer under
 * `resolutions[request.key]` re-dispatches the step (the handler reads it
 * from `CallContext.resolutions`). Unlike `earlyReturn`, the run does NOT
 * produce an output — nothing downstream runs until the suspension resolves.
 */
export class SuspendSignal extends Error {
	readonly request: SuspensionRequest;

	constructor(request: SuspensionRequest) {
		super(`Suspended: ${request.key}`);
		this.request = request;
		this.name = "SuspendSignal";
	}
}

/** Convenience factory: `throw suspend({ key, interaction: {...} })`. */
export function suspend(request: SuspensionRequest): SuspendSignal {
	return new SuspendSignal(request);
}

/** Hash of one authored step definition - the reconciliation key. */
export function hashStep(step: Step): string {
	// A call step's `await` flag is scheduling metadata (whether the run
	// waits), not part of WHAT it computes - excluded so session reuse
	// survives toggling it.
	const { await: _await, ...hashed } = step as Step & { await?: boolean };
	return sha256Hex(stableStringify(hashed)).slice(0, 32);
}

/** Deterministic JSON-ish encoding (sorted keys, undefined dropped) -
 * the step-hash payload. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
	return `{${entries.join(",")}}`;
}

function serializeError(err: unknown): SerializedError {
	if (err instanceof ExprError) return { message: err.message, code: err.code };
	if (err instanceof Error) {
		const code = (err as { code?: unknown }).code;
		return {
			message: err.message,
			code: typeof code === "string" ? code : undefined,
		};
	}
	return { message: String(err) };
}

function refsOfExpr(source: string): Set<string> {
	try {
		return collectRefs(parseExpr(source));
	} catch {
		return new Set();
	}
}

/** Step ids whose recorded FAILURE the expression reads (`$errors.x`). */
function errorRefsOf(source: string): Set<string> {
	try {
		return errorSelectors(parseExpr(source)).names;
	} catch {
		return new Set();
	}
}

/**
 * Free references a step's expressions may read (step ids + `input`),
 * plus its `after` edges - an ordering edge is a dependency too (a
 * runner must not detach a step another step waits on).
 */
function refsOfStep(step: Step): Set<string> {
	const refs = new Set<string>();
	const takeExpr = (source: string) => {
		for (const ref of refsOfExpr(source)) refs.add(ref);
		// An error selection is a dependency on the step it names - the
		// error branch of the same edge a value reference makes.
		for (const ref of errorRefsOf(source)) refs.add(ref);
	};
	if (step.if) takeExpr(step.if);
	if (step.return) takeExpr(step.return);
	if (step.after) for (const id of step.after) refs.add(id);
	if (isCallStep(step)) {
		if (step.each !== undefined) takeExpr(step.each);
		for (const src of collectArgExprs(step.args)) takeExpr(src);
	} else if (!isReturnStep(step)) {
		takeExpr(step.let);
	}
	refs.delete("$calls"); // bound by the engine, never a step id
	refs.delete("$errors"); // the namespace itself - selections added above
	return refs;
}

/**
 * Every name some expression in the script reads — step ids, session
 * variables, `input`. A step whose id is absent here (and which isn't the
 * last step, i.e. the run's output) produces a value nothing in THIS script
 * observes; a runner may detach it without changing the script's result.
 */
export function referencedNames(script: Script): Set<string> {
	const refs = new Set<string>();
	for (const step of script.steps) {
		for (const ref of refsOfStep(step)) refs.add(ref);
	}
	if (script.output !== undefined) {
		for (const ref of refsOfExpr(script.output)) refs.add(ref);
		for (const ref of errorRefsOf(script.output)) refs.add(ref);
		refs.delete("$errors");
	}
	return refs;
}

/**
 * The schedule, as dependency edges per step id. Steps are authored in
 * order but RUN by dependency: a step waits for the step ids its
 * expressions reference plus its `after` edges - independent steps run
 * concurrently. A `return`-gated step is a FENCE: it waits for every
 * step before it, and every step after it waits for the fence - a guard
 * guards everything behind it, exactly like sequential execution.
 */
function computeDeps(script: Script): Map<string, Set<string>> {
	const ids = new Set(script.steps.map((step) => step.id));
	const deps = new Map<string, Set<string>>();
	let fence: string | undefined;
	const before: string[] = [];
	for (const step of script.steps) {
		const wait = new Set<string>();
		for (const ref of refsOfStep(step)) {
			if (ids.has(ref) && ref !== step.id) wait.add(ref);
		}
		if (step.return !== undefined) {
			for (const id of before) wait.add(id);
			fence = step.id;
		} else if (fence !== undefined) {
			wait.add(fence);
		}
		deps.set(step.id, wait);
		before.push(step.id);
	}
	return deps;
}

/**
 * For each name, the step ids whose expressions read it. Once a name's
 * producer and every consumer settled, the value can never be observed
 * again (scripts have no dynamic references) and is safe to drop - except
 * what the output projection (or the default last-step output) reads.
 */
function computeConsumers(script: Script): {
	consumers: Map<string, Set<string>>;
	keep: Set<string>;
} {
	const consumers = new Map<string, Set<string>>();
	for (const step of script.steps) {
		for (const ref of refsOfStep(step)) {
			let readers = consumers.get(ref);
			if (!readers) {
				readers = new Set();
				consumers.set(ref, readers);
			}
			readers.add(step.id);
		}
	}
	// Everything the output projection reads is the run's result - never drop.
	const keep = new Set<string>();
	if (script.output !== undefined) {
		for (const ref of refsOfExpr(script.output)) keep.add(ref);
	}
	const last = script.steps[script.steps.length - 1];
	if (last) keep.add(last.id);
	return { consumers, keep };
}

/**
 * Reconcile a script against a prior record: decide per leaf step whether
 * its saved state is reusable or the step must run, and why. The shared
 * brain behind `planExecution` (host preview / approval cards) and
 * `executeScript` (the actual carry-over).
 */
function reconcile(
	script: Script,
	state: RunState | undefined,
): Map<string, StepPlan & { prior?: StepState }> {
	const out = new Map<string, StepPlan & { prior?: StepState }>();
	for (const step of script.steps) {
		const prior = state?.steps[step.id];
		const tool = isCallStep(step) ? { tool: step.call } : {};
		if (!prior) {
			out.set(step.id, { id: step.id, action: "run", why: "new", ...tool });
		} else if (prior.hash !== hashStep(step)) {
			out.set(step.id, { id: step.id, action: "run", why: "changed", ...tool });
		} else if (prior.status === "done" || prior.status === "skipped") {
			out.set(step.id, {
				id: step.id,
				action: "reuse",
				why: "settled",
				prior,
				...tool,
			});
		} else {
			// returned/error: a re-entry point; items/attempts carry over.
			out.set(step.id, {
				id: step.id,
				action: "run",
				why: prior.status,
				prior,
				...tool,
			});
		}
	}

	// A released settled output cannot feed a step that will run (the value is
	// gone) - nor be the run's output. Re-running the producer may widen what
	// else is needed, so iterate to a fixpoint.
	const last = script.steps[script.steps.length - 1];
	const lastIds = last === undefined ? [] : [last.id];
	for (let changed = true; changed; ) {
		changed = false;
		const needed = new Set<string>(lastIds);
		for (const step of script.steps) {
			if (out.get(step.id)?.action !== "run") continue;
			for (const ref of refsOfStep(step)) needed.add(ref);
		}
		for (const entry of out.values()) {
			if (
				entry.action === "reuse" &&
				entry.prior?.released &&
				needed.has(entry.id)
			) {
				out.set(entry.id, {
					id: entry.id,
					action: "run",
					why: "released",
					tool: entry.tool,
				});
				changed = true;
			}
		}
	}
	return out;
}

/**
 * Preview what `executeScript(script, { state })` will do with each leaf
 * step - reuse its settled output or run it, and why. Hosts gate approval
 * on this: `why: "changed"` on a call step means side effects re-fire for
 * a step the record says already ran.
 */
export function planExecution(script: Script, state?: RunState): StepPlan[] {
	return [...reconcile(script, state).values()].map(
		({ prior: _prior, ...plan }) => plan,
	);
}

function approxBytes(value: unknown): number {
	const json = JSON.stringify(value);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

export async function executeScript(
	script: Script,
	options: ExecuteOptions,
): Promise<ExecuteResult> {
	const limits: ScriptLimits = { ...DEFAULT_LIMITS, ...options.limits };

	// Reconcile against the prior record: reusable entries carry over verbatim,
	// re-entry points (returned/error/suspended with a matching hash) keep
	// items/attempts.
	const plans = reconcile(script, options.state);
	const declared = new Set(script.steps.map((step) => step.id));
	const record: RunState = { version: "2", script, status: "done", steps: {} };
	// Suspension bookkeeping carries across rounds: per-key raise counts (the
	// maxSuspendAttempts guard) and the prior round's outstanding requests
	// (handlers recover their parked `data` via `CallContext.suspensions`).
	const suspendAttempts: Record<string, number> = {
		...options.state?.suspendAttempts,
	};
	if (options.state?.suspendAttempts) record.suspendAttempts = suspendAttempts;
	const priorSuspensions: SuspensionRequest[] = [];
	for (const state of Object.values(options.state?.steps ?? {})) {
		if (state.suspensions) priorSuspensions.push(...state.suspensions);
	}
	// The record IS the session: entries no step in THIS script declares carry
	// forward verbatim - they are the session's variables, published by earlier
	// runs. Entries for declared steps follow the reconciliation plan instead.
	if (options.state) {
		for (const [id, state] of Object.entries(options.state.steps)) {
			if (!declared.has(id)) record.steps[id] = state;
		}
	}
	for (const entry of plans.values()) {
		if (entry.action === "reuse" && entry.prior)
			record.steps[entry.id] = entry.prior;
	}
	const carried = new Map<string, StepState>();
	for (const entry of plans.values()) {
		if (entry.action === "run" && entry.prior)
			carried.set(entry.id, entry.prior);
	}

	const env: Record<string, unknown> = {};
	// Session variables: carried entries bind by id, read-only, under the same
	// publish rule as `publishedVariables` (done, unreleased, non-undefined).
	for (const [id, state] of Object.entries(record.steps)) {
		if (
			!declared.has(id) &&
			state.status === "done" &&
			!state.released &&
			state.output !== undefined
		) {
			env[id] = state.output;
		}
	}
	// Host-supplied variables bind on top (host-trusted, so they win a name
	// clash). A name declared by any step in THIS script is excluded - the id
	// refers to the new step (which overwrites the variable when it settles),
	// and forward references stay illegal. Globals and `input` can never be
	// masked (env wins over namespaces in expression lookup, so filtering here
	// is load-bearing).
	for (const [name, value] of Object.entries({
		...options.bindings,
		...options.variables,
	})) {
		if (
			!declared.has(name) &&
			!GLOBAL_NAMES.has(name) &&
			name !== "input" &&
			name !== "$errors" &&
			name !== "$calls"
		)
			env[name] = value;
	}
	// `input` defaults to {} so `input.anything` is undefined, not a type
	// error, on runs where the host piped nothing in.
	env.input = options.input ?? {};
	// The error branch of the dataflow: `$errors.<id>` is step <id>'s
	// recorded failure - set only by a settled `onError: "skip"` step (the
	// { message, code } for a plain call, the per-element error list for an
	// `each` fan-out), undefined when the step succeeded. UCAN's
	// `await/error`, spelled with a step id.
	const errorBranch: Record<string, unknown> = {};
	env.$errors = errorBranch;
	const noteError = (id: string) => {
		const state = record.steps[id];
		if (!state || state.status !== "done") return;
		if (state.error) errorBranch[id] = state.error;
		else if (state.items?.some((item) => item?.error)) {
			errorBranch[id] = state.items.map((item) => item?.error);
		}
	};
	// Reused settled steps carry their skipped failures into this run too.
	for (const entry of plans.values()) {
		if (entry.action === "reuse") noteError(entry.id);
	}
	const evalOpts = { maxNodes: limits.maxExprNodes };

	// Memory: drop outputs no unsettled step can read anymore. Only THIS
	// script's steps are ever stripped from the record - carried session
	// entries stay intact for future runs (their env binding may still drop).
	const { consumers, keep } = computeConsumers(script);
	const settled = new Set<string>();
	const releaseDead = () => {
		if ((options.retainOutputs ?? "live") === "all") return;
		for (const id of Object.keys(env)) {
			// Whole-run bindings: per-execute data and the error branch (errors
			// are small and survive release by design - only outputs drop).
			if (id === "input" || id === "$errors") continue;
			if (keep.has(id)) continue;
			if (declared.has(id) && !settled.has(id)) continue;
			let dead = true;
			for (const reader of consumers.get(id) ?? []) {
				if (!settled.has(reader)) {
					dead = false;
					break;
				}
			}
			if (!dead) continue;
			delete env[id];
			if (!declared.has(id)) continue;
			const state = record.steps[id];
			if (state && (state.status === "done" || state.status === "skipped")) {
				if (state.output !== undefined) state.released = true;
				delete state.output;
				if (state.items) {
					state.items = state.items.map(({ status, error }) => ({
						status,
						error,
					}));
				}
			}
		}
	};

	// The per-dispatch context every call handler sees, beyond `attempt`:
	// suspension resolutions delivered for THIS execute, prior outstanding
	// requests, and per-key raise counts (live - updated as suspensions land;
	// attached to the record only once something actually counts).
	const callExtras: Omit<CallContext, "attempt"> = {
		attempts: suspendAttempts,
		resolutions: options.resolutions ?? {},
		suspensions: priorSuspensions,
	};

	const ctx: StepCtx = { options, limits, evalOpts, carried, callExtras };

	// --- the scheduler: steps run by DEPENDENCY, not position ---
	// A step dispatches once every dep (data refs + `after` edges + the
	// return-gate fences) settled; independent steps run concurrently,
	// bounded by limits.maxConcurrency. An error or a fired return gate
	// stops NEW dispatches; in-flight steps finish and their settlements
	// record. A suspension parks only the step and whatever depends on it.
	const deps = computeDeps(script);
	const stops = new Map<string, ExecuteResult>();
	const dispatched = new Set<string>();
	const inflight = new Map<string, Promise<void>>();
	let halted = false;

	const isReady = (step: Step): boolean => {
		for (const dep of deps.get(step.id)!) {
			if (!settled.has(dep)) return false;
		}
		return true;
	};

	while (true) {
		if (!halted) {
			for (const step of script.steps) {
				if (inflight.size >= limits.maxConcurrency) break;
				if (dispatched.has(step.id) || !isReady(step)) continue;
				dispatched.add(step.id);
				// Release as the schedule ADVANCES, never at run end - a value
				// only the final steps consumed stays published to the session.
				releaseDead();
				inflight.set(
					step.id,
					runLeafStep(step, env, record, ctx).then((result) => {
						inflight.delete(step.id);
						if (result === undefined) {
							settled.add(step.id);
							noteError(step.id);
							return;
						}
						stops.set(step.id, result);
						if (result.status !== "suspended") halted = true;
					}),
				);
			}
		}
		if (inflight.size === 0) break;
		await Promise.race(inflight.values());
	}

	// Aggregate deterministically in DOCUMENT order, whatever the timing:
	// errors first, then early returns, then suspensions (merged - the run
	// parks once on everything it waits for). The winner re-stamps the
	// record's status/at, so concurrent settlements can't leave a stale one.
	for (const step of script.steps) {
		const stop = stops.get(step.id);
		if (stop?.status === "error") {
			return errorResult(record, stop.at, stop.error);
		}
	}
	for (const step of script.steps) {
		const stop = stops.get(step.id);
		if (stop?.status === "ok" && stop.returnedAt !== undefined) {
			return returnResult(record, stop.returnedAt, stop.output);
		}
	}
	const suspensions: SuspensionRequest[] = [];
	let suspendedAt: string | undefined;
	for (const step of script.steps) {
		const stop = stops.get(step.id);
		if (stop?.status === "suspended") {
			suspendedAt ??= step.id;
			suspensions.push(...stop.suspensions);
		}
	}
	if (suspendedAt !== undefined) {
		return suspendedResult(record, suspendedAt, suspensions);
	}

	const last = script.steps[script.steps.length - 1];
	let output: unknown;
	try {
		output =
			script.output !== undefined
				? evalExpr(script.output, env, evalOpts)
				: last
					? env[last.id]
					: undefined;
	} catch (err) {
		return errorResult(record, "output", serializeError(err));
	}
	record.status = "done";
	return { status: "ok", output, state: record, record };
}

interface StepCtx {
	options: ExecuteOptions;
	limits: ScriptLimits;
	evalOpts: { maxNodes: number };
	/** Prior state of re-entry steps (returned/error/suspended with matching hash). */
	carried: Map<string, StepState>;
	/** The suspension-aware slice of every dispatch's CallContext. */
	callExtras: Omit<CallContext, "attempt">;
}

function errorResult(
	record: RunState,
	at: string,
	error: SerializedError,
): ExecuteResult {
	record.status = "error";
	record.at = at;
	return { status: "error", at, error, state: record, record };
}

function returnResult(
	record: RunState,
	at: string,
	output: unknown,
): ExecuteResult {
	record.status = "returned";
	record.at = at;
	return { status: "ok", output, returnedAt: at, state: record, record };
}

function suspendedResult(
	record: RunState,
	at: string,
	suspensions: SuspensionRequest[],
): ExecuteResult {
	record.status = "suspended";
	record.at = at;
	return { status: "suspended", suspensions, state: record, record };
}

/**
 * Run one step (let, call, or return), including its `if` condition,
 * `return` gate, env binding, and error capture. Returns an ExecuteResult
 * when the run should stop, otherwise undefined.
 */
async function runLeafStep(
	step: Step,
	env: Record<string, unknown>,
	record: RunState,
	ctx: StepCtx,
): Promise<ExecuteResult | undefined> {
	const prior = record.steps[step.id];

	// Settled on a previous run - rebind the output and move on.
	if (prior && (prior.status === "done" || prior.status === "skipped")) {
		env[step.id] = prior.output;
		return undefined;
	}

	const carried = ctx.carried.get(step.id);
	const hash = hashStep(step);
	const started = Date.now();

	try {
		// --- condition ---
		if (step.if !== undefined) {
			const pass = evalExpr(step.if, env, ctx.evalOpts);
			if (!pass) {
				record.steps[step.id] = { hash, status: "skipped", output: undefined };
				env[step.id] = undefined;
				return undefined;
			}
		}

		// --- call step: resolve first so `return` can preview `$calls` ---
		if (isCallStep(step)) {
			return await runCallStep(step, env, record, {
				...ctx,
				hash,
				started,
				prior: carried,
			});
		}

		// --- return gate (let and return-only steps) ---
		if (step.return !== undefined) {
			const value = evalExpr(step.return, env, ctx.evalOpts);
			// A return-ONLY step with an `if` is a true guard clause - JS's
			// `if (cond) return value`: the condition (already passed above)
			// decides, and the value is the run's result, falsy included.
			// Gate-only forms (no `if`, or a gate riding a let/call step)
			// still decide truthily on the value itself.
			const guarded = isReturnStep(step) && step.if !== undefined;
			if (guarded || value) {
				record.steps[step.id] = {
					hash,
					status: "returned",
					output: value,
					attempts: (carried?.attempts ?? 0) + 1,
				};
				return returnResult(record, step.id, value);
			}
		}

		// --- pure derivation (a return-only step settles as done/undefined) ---
		const output = isReturnStep(step)
			? undefined
			: evalExpr(step.let, env, ctx.evalOpts);
		record.steps[step.id] = {
			hash,
			status: "done",
			output,
			durationMs: Date.now() - started,
		};
		env[step.id] = output;
		return undefined;
	} catch (err) {
		const error = serializeError(err);
		record.steps[step.id] = {
			hash,
			status: "error",
			error,
			...(carried?.attempts !== undefined
				? { attempts: carried.attempts }
				: {}),
			durationMs: Date.now() - started,
		};
		return errorResult(record, step.id, error);
	}
}

type CallStepCtx = StepCtx & {
	hash: string;
	started: number;
	prior: StepState | undefined;
};

/**
 * Run one call step. Returns an ExecuteResult when the run should stop
 * (the step's `return` fired, a handler ended the run early, or a call
 * failed), otherwise undefined.
 */
async function runCallStep(
	step: CallStep,
	env: Record<string, unknown>,
	record: RunState,
	ctx: CallStepCtx,
): Promise<ExecuteResult | undefined> {
	const { options, limits, evalOpts, hash, started, prior, callExtras } = ctx;
	const attempt = prior?.attempts ?? 0;

	// Resolution is deterministic over settled outputs, so what a `return`
	// gate previews via `$calls` is exactly what runs after the re-execute -
	// unless args read the ephemeral `input`, which analyze flags.
	const requests = resolveRequests(step, env, evalOpts, limits);

	// --- return gate: fires BEFORE any call, with the resolved preview ---
	if (step.return !== undefined) {
		const value = evalExpr(step.return, { ...env, $calls: requests }, evalOpts);
		if (value) {
			record.steps[step.id] = {
				hash,
				status: "returned",
				output: value,
				attempts: attempt + 1,
				...(prior?.items ? { items: prior.items } : {}),
				...(prior?.calls !== undefined ? { calls: prior.calls } : {}),
			};
			return returnResult(record, step.id, value);
		}
	}

	// Counts a raised suspension against the per-key guard. Pure timed waits
	// (retryAfterMs, no interaction) are progress, never counted. Returns the
	// guard error once the key is over budget.
	const countSuspension = (
		request: SuspensionRequest,
	): SerializedError | undefined => {
		if (request.interaction === undefined && request.retryAfterMs !== undefined)
			return undefined;
		const n = (callExtras.attempts[request.key] ?? 0) + 1;
		callExtras.attempts[request.key] = n;
		record.suspendAttempts = callExtras.attempts;
		if (n > limits.maxSuspendAttempts) {
			return {
				message:
					`Suspension "${request.key}" was raised ${n} times, over ` +
					`maxSuspendAttempts (${limits.maxSuspendAttempts}) - it is not converging`,
				code: "suspend_limit",
			};
		}
		return undefined;
	};

	// --- confirm gate: the step needs a decision before it dispatches ---
	// Self-declared (`suspend: true`) or flagged by the host's policy. The
	// suspension is keyed by the STEP ID; a truthy resolution proceeds, a
	// falsy one denies. The interaction carries the resolved calls preview.
	const gated =
		step.suspend === true ||
		(options.suspend
			? await options.suspend({ stepId: step.id, tool: step.call })
			: false);
	if (gated) {
		const answer = callExtras.resolutions[step.id];
		if (answer === undefined) {
			const request: SuspensionRequest = {
				key: step.id,
				stepId: step.id,
				tool: step.call,
				interaction: {
					id: step.id,
					kind: "confirm",
					title: `Run "${step.call}"?`,
					detail: step.reason,
					props: { calls: requests } as unknown as JsonValue,
				},
			};
			const over = countSuspension(request);
			if (over) {
				record.steps[step.id] = {
					hash,
					status: "error",
					error: over,
					...(attempt > 0 ? { attempts: attempt } : {}),
					durationMs: Date.now() - started,
				};
				return errorResult(record, step.id, over);
			}
			record.steps[step.id] = {
				hash,
				status: "suspended",
				suspensions: [request],
				attempts: attempt + 1,
				...(prior?.items ? { items: prior.items } : {}),
				...(prior?.calls !== undefined ? { calls: prior.calls } : {}),
			};
			return suspendedResult(record, step.id, [request]);
		}
		if (!answer) {
			const error: SerializedError = {
				message: `The user declined to run "${step.call}" (step "${step.id}")`,
				code: "step_denied",
			};
			record.steps[step.id] = {
				hash,
				status: "error",
				error,
				...(attempt > 0 ? { attempts: attempt } : {}),
				durationMs: Date.now() - started,
			};
			return errorResult(record, step.id, error);
		}
	}

	const onError = step.onError ?? "fail";
	const items: ItemState[] = prior?.items ?? [];
	let calls = prior?.calls ?? 0;
	const earlyReturns = new Map<number, unknown>();
	const raised: SuspensionRequest[] = [];

	const runOne = async (
		request: CallRequest,
		index: number,
	): Promise<ItemState | "returned"> => {
		try {
			const output = await options.handlers.call(request, {
				attempt,
				...callExtras,
			});
			calls++;
			const size = approxBytes(output);
			if (size > limits.maxCallResultBytes) {
				return {
					status: "error",
					error: {
						message:
							`Result of "${request.tool}" is ${size} bytes, over the ` +
							`maxCallResultBytes limit (${limits.maxCallResultBytes}). ` +
							"Have the tool return less, or raise the limit.",
						code: "result_too_large",
					},
				};
			}
			return { status: "done", output };
		} catch (err) {
			if (err instanceof EarlyReturnSignal) {
				earlyReturns.set(index, err.value);
				return "returned";
			}
			if (err instanceof SuspendSignal) {
				// The raiser says WHAT it waits on; the interpreter says WHERE.
				const request_ = { ...err.request };
				request_.stepId ??= step.id;
				request_.tool ??= step.call;
				if (
					request_.itemIndex === undefined &&
					request.itemIndex !== undefined
				) {
					request_.itemIndex = request.itemIndex;
				}
				const over = countSuspension(request_);
				if (over) return { status: "error", error: over };
				raised.push(request_);
				return { status: "suspended" };
			}
			calls++;
			return { status: "error", error: serializeError(err) };
		}
	};

	const settle = (): ExecuteResult | undefined => {
		const failed = items.filter((i) => i?.status === "error");
		if (failed.length > 0 && onError === "fail") {
			const error = failed[0]!.error!;
			record.steps[step.id] = {
				hash,
				status: "error",
				error,
				...(step.each !== undefined ? { items } : {}),
				...(attempt > 0 ? { attempts: attempt } : {}),
				calls,
				durationMs: Date.now() - started,
			};
			return errorResult(record, step.id, error);
		}
		if (earlyReturns.size > 0) {
			// Deterministic: the earliest item's value wins; done items are kept
			// so the re-execute only dispatches what never completed.
			const index = Math.min(...earlyReturns.keys());
			const value = earlyReturns.get(index);
			record.steps[step.id] = {
				hash,
				status: "returned",
				output: value,
				...(step.each !== undefined ? { items } : {}),
				attempts: attempt + 1,
				calls,
			};
			return returnResult(record, step.id, value);
		}
		if (raised.length > 0) {
			// Suspended items stay non-done, so the re-execute re-dispatches
			// exactly them (plus errored ones, under onError "skip" semantics).
			record.steps[step.id] = {
				hash,
				status: "suspended",
				suspensions: raised,
				...(step.each !== undefined ? { items } : {}),
				attempts: attempt + 1,
				calls,
			};
			return suspendedResult(record, step.id, raised);
		}
		return undefined;
	};

	if (step.each !== undefined) {
		// Re-entry-aware: "done" item slots never re-dispatch; "error" slots
		// retry (re-executing an errored run IS the retry request).
		const pending = requests
			.map((request, index) => ({ request, index }))
			.filter(({ index }) => items[index]?.status !== "done");

		await pool(pending, limits.maxConcurrency, async ({ request, index }) => {
			const outcome = await runOne(request, index);
			if (outcome !== "returned") items[index] = outcome;
			else delete items[index];
		});

		const stop = settle();
		if (stop) return stop;

		clearSuspendCounts(step, prior, callExtras.attempts);
		const output = items.map((i) =>
			i?.status === "done" ? i.output : undefined,
		);
		record.steps[step.id] = {
			hash,
			status: "done",
			output,
			items: items.map(({ status, error }) => ({ status, error })),
			calls,
			durationMs: Date.now() - started,
		};
		env[step.id] = output;
		return undefined;
	}

	if (items[0]?.status !== "done") {
		const outcome = await runOne(requests[0]!, 0);
		if (outcome !== "returned") items[0] = outcome;
	}
	const stop = settle();
	if (stop) return stop;

	const item = items[0]!;
	// onError "skip" on a single call: record the error, output undefined, continue.
	clearSuspendCounts(step, prior, callExtras.attempts);
	const output = item.status === "done" ? item.output : undefined;
	record.steps[step.id] = {
		hash,
		status: "done",
		output,
		error: item.error,
		calls,
		durationMs: Date.now() - started,
	};
	env[step.id] = output;
	return undefined;
}

/**
 * A step that settles releases its suspension budget: per-key counts for
 * everything it was parked on (and its confirm key) reset, so a future
 * re-run of the session isn't haunted by a long-resolved approval.
 */
function clearSuspendCounts(
	step: CallStep,
	prior: StepState | undefined,
	attempts: Record<string, number>,
): void {
	delete attempts[step.id];
	for (const request of prior?.suspensions ?? []) delete attempts[request.key];
}

function resolveRequests(
	step: CallStep,
	env: Record<string, unknown>,
	evalOpts: { maxNodes: number },
	limits: ScriptLimits,
): CallRequest[] {
	const base = {
		stepId: step.id,
		tool: step.call,
		reason: step.reason,
	};

	if (step.each === undefined) {
		return [{ ...base, args: resolveArgs(step.args, env, evalOpts) }];
	}

	const list = evalExpr(step.each, env, evalOpts);
	if (!Array.isArray(list)) {
		throw new ScriptExecutionError(
			`"each" of step "${step.id}" did not evaluate to an array (each yields the LIST of call args, one call per element)`,
			step.id,
			"each_not_array",
		);
	}
	const max = Math.min(
		step.max ?? limits.maxItemsPerStep,
		limits.maxItemsPerStep,
	);
	if (list.length > max) {
		throw new ScriptExecutionError(
			`"each" of step "${step.id}" has ${list.length} elements, more than max (${max}). ` +
				`Slice explicitly (e.g. ".slice(0, ${max})") if you want the first ${max}.`,
			step.id,
			"each_too_many_items",
		);
	}

	// Each element IS one call's args - already evaluated, no "=" walking.
	return list.map((args, itemIndex) => ({ ...base, itemIndex, args }));
}

async function pool<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const runners = Array.from(
		{ length: Math.max(1, Math.min(concurrency, items.length)) },
		async () => {
			while (next < items.length) {
				const item = items[next++]!;
				await worker(item);
			}
		},
	);
	await Promise.all(runners);
}

/** Convenience: total calls actually performed in a run. */
export function totalCalls(record: RunState): number {
	return Object.values(record.steps).reduce(
		(n, s: StepState) => n + (s.calls ?? 0),
		0,
	);
}

/**
 * The variables a run publishes to a session namespace: every settled
 * "done" step's output, by id. Publication is per STEP, not per run - a
 * failed run still publishes the steps that completed (they are facts; the
 * data is what makes recovery cheap). Skipped steps publish nothing (they
 * produced no value - publishing undefined would clobber a live variable),
 * as do released outputs and the failed/returned steps themselves.
 */
export function publishedVariables(record: RunState): Record<string, unknown> {
	const vars: Record<string, unknown> = {};
	for (const [id, step] of Object.entries(record.steps)) {
		if (step.status === "done" && !step.released && step.output !== undefined) {
			vars[id] = step.output;
		}
	}
	return vars;
}
