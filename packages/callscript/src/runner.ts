import {
	executeScript,
	referencedNames,
	ScriptExecutionError,
} from "./execute";
import {
	type CallContext,
	type CallRequest,
	type CallStep,
	type ExecuteHandlers,
	type ExecuteResult,
	isCallStep,
	type RunRecord,
	type Script,
	type ScriptLimits,
	type SerializedError,
} from "./types";
import { createWildcardMatcher } from "./wildcard";

/**
 * The runner: asynchronous runs on top of the synchronous engine.
 *
 * `executeScript` is a pure state machine — it runs until the script finishes
 * and hands back a serializable record. The runner adds the *when* and the
 * *between*: a run marked `"await": false` executes in the fast lane up to a deadline
 * and, if still unfinished, detaches — the caller gets `pending` plus the run
 * id, the run keeps executing in the background, and its settlement is
 * delivered later. Three channels carry that news, layered by capability:
 *
 * 1. **Pull** — `await.<id>` calls inside later scripts (the dataflow join),
 *    and `result(id)` / `status(id)` for hosts. Always available.
 * 2. **Digest** — `digest()` returns every still-pending run plus each
 *    settlement exactly once; hosts attach it to every tool response so the
 *    agent hears about background completions without asking.
 * 3. **Push** — `onRunSettled` fires per settlement for hosts that can
 *    inject into the agent's context or wake it. Optional acceleration.
 *
 * Reading a result never consumes it: announcements are at-most-once, the
 * value stays readable until TTL. There is no separate "resolve" protocol —
 * a run that ended at a `return` gate settles as `"returned"`, and
 * continuing it is just `start()` again with the same id and new `input`
 * (reconciliation reuses everything settled).
 *
 * The runner also owns the **session**: every settled run's fresh step
 * entries merge into one accumulated `RunRecord`, so each new run executes
 * against everything the agent has computed so far and published variables
 * flow between runs (see `publishedVariables`). Concurrent async runs fork
 * the session at start and merge back by step id, latest settlement wins.
 */

/** Reserved call-name namespace for joining runs: `await.<runId>[.<stepId>]`.
 * Hosts that run scripts through a runner add `"await.*"` to their tool list. */
export const AWAIT_PREFIX = "await.";

/** True when a call step names the runner's join pseudo-tool. */
export const isAwaitCall = (tool: string): boolean =>
	tool.startsWith(AWAIT_PREFIX);

export type RunStatus = "pending" | "done" | "returned" | "error" | "cancelled";

/**
 * One run's model-facing status line. `output` is inlined only while it fits
 * `maxDigestOutputBytes` (`outputOmitted` marks the cut — join the run with
 * an `await.<id>` call for the full value).
 */
export interface RunDigestEntry {
	status: RunStatus;
	/** Settled value (done: last step's output · returned: the gate's payload). */
	output?: unknown;
	outputOmitted?: true;
	/** Step id the run returned or failed at. */
	at?: string;
	error?: SerializedError;
	/** Wall-time from start to settlement, in ms (only with `RunnerOptions.timings`). */
	durationMs?: number;
}

/** A settlement, as delivered to `onRunSettled` listeners and `result()`. */
export interface SettledRun {
	runId: string;
	status: "done" | "returned" | "error" | "cancelled";
	output?: unknown;
	at?: string;
	error?: SerializedError;
	record?: RunRecord;
}

/** What `start` answers: the result when the run finished inside the
 * deadline (or wasn't async), else `pending` plus the id to hear it by. */
export type StartResult =
	| {
			runId: string;
			status: "done";
			output: unknown;
			returnedAt?: string;
			record: RunRecord;
	  }
	| {
			runId: string;
			status: "error";
			at: string;
			error: SerializedError;
			record: RunRecord;
	  }
	| { runId: string; status: "pending" };

export interface StartOptions {
	/** Run name override; `script.id` wins, then this, then a minted `r<n>`. */
	runId?: string;
	/** Wait override (default true); `script.await` wins. false = may detach. */
	await?: boolean;
	/** Per-execute data bound as `input` (captured at start for async runs). */
	input?: unknown;
	/** Extra session variables for this run (on top of the session record's). */
	variables?: Record<string, unknown>;
	/**
	 * Per-start dispatch override (e.g. handlers closed over one tool call's
	 * context). A detached run keeps using the handlers it started with.
	 */
	handlers?: ExecuteHandlers;
	/**
	 * Fast-lane budget override for THIS start, in ms. 0 detaches immediately
	 * (pure fire-and-forget: the settlement is only ever delivered via the
	 * digest / push / await, never inline).
	 */
	deadlineMs?: number;
}

export interface RunnerOptions {
	/** Default tool dispatch; `StartOptions.handlers` overrides per start.
	 * The runner wraps whichever applies to serve `await.*`. */
	handlers?: ExecuteHandlers;
	limits?: Partial<ScriptLimits>;
	/**
	 * Fast-lane budget for async runs, in ms (default 3000). A run that
	 * settles inside it returns its result directly — the async machinery is
	 * pure acceleration and most scripts never see it. 0 detaches immediately.
	 */
	deadlineMs?: number;
	/** How long settled runs stay readable, in ms (default 30 minutes). */
	ttlMs?: number;
	/** Max retained runs; oldest announced settlements evict first (default 64). */
	maxRuns?: number;
	/** Inline-output cap per digest entry, in bytes (default 4096). */
	maxDigestOutputBytes?: number;
	/**
	 * Passed through to the engine. Defaults to "all" here (unlike bare
	 * executeScript): the session and `await.<id>.<stepId>` reads need outputs
	 * to survive the run that produced them.
	 */
	retainOutputs?: "live" | "all";
	/**
	 * Tools that are background-by-default (exact names or `prefix.*`
	 * patterns — typically the slow ones). A top-level call step naming one
	 * detaches automatically as its own run — the agent opts OUT, not in —
	 * unless the script consumes it: a later step references its output, it
	 * is the last step (the run's result), or it says `await: true`
	 * ("wait for this one"). Consumption is the await: values a script reads
	 * always resolve synchronously, so a step whose success the agent wants
	 * to report just has to appear in the final projection.
	 */
	asyncTools?: Iterable<string>;
}

export interface ScriptRunner {
	/** Run a script (fast lane first; async runs may answer `pending`). */
	start(script: Script, options?: StartOptions): Promise<StartResult>;
	/** One run's current status line, or undefined if unknown/expired. */
	status(runId: string): RunDigestEntry | undefined;
	/** Resolves at settlement (immediately if already settled). Idempotent. */
	result(runId: string): Promise<SettledRun>;
	/** A settled run's record, for host inspection / re-execution elsewhere. */
	record(runId: string): RunRecord | undefined;
	/** The accumulated session record every new run executes against. */
	session(): RunRecord | undefined;
	/**
	 * Every pending run, plus each settlement exactly once (announce-once —
	 * a settled run appears in the digest that first reports it, then drops
	 * out; its value stays readable via `await.<id>` / `result()`). Attach to
	 * every tool response.
	 */
	digest(): Record<string, RunDigestEntry>;
	/** Per-settlement push for hosts that can inject or wake. Returns unsubscribe. */
	onRunSettled(listener: (run: SettledRun) => void): () => void;
	/**
	 * Mark a settlement as already delivered to the agent (e.g. the host
	 * pushed it into the conversation) so the digest does not repeat it -
	 * announcements are at-most-once ACROSS channels. The value itself stays
	 * readable (`await.<id>` / `result()`); acknowledging never consumes it.
	 */
	acknowledge(runId: string): void;
	/**
	 * Mark a run cancelled: its settlement is discarded from the session,
	 * awaiters reject with code "run_cancelled", the digest announces
	 * "cancelled". In-flight tool calls are NOT interrupted (the engine has
	 * no abort channel) — cancellation is a promise about the result, not the
	 * side effects already in motion.
	 */
	cancel(runId: string): boolean;
}

interface RunEntry {
	id: string;
	scriptJson: string;
	status: RunStatus;
	output?: unknown;
	at?: string;
	error?: SerializedError;
	record?: RunRecord;
	/** Session image this run forked from (entry identity marks fresh steps). */
	forkedFrom?: RunRecord;
	/** Resolves when the run settles (also for cancelled). */
	settled: Promise<void>;
	announced: boolean;
	/** True once the run answered `pending` - its settlement is background
	 * news (pushed via onRunSettled); inline results never notify. */
	detached?: boolean;
	/** Run ids this run is currently blocked on inside `await.*` calls. */
	waitingOn: Set<string>;
	finishedAt?: number;
}

export function createRunner(options: RunnerOptions): ScriptRunner {
	const deadlineMs = options.deadlineMs ?? 3000;
	const ttlMs = options.ttlMs ?? 30 * 60_000;
	const maxRuns = options.maxRuns ?? 64;
	const maxDigestOutputBytes = options.maxDigestOutputBytes ?? 4096;

	const entries = new Map<string, RunEntry>();
	const listeners = new Set<(run: SettledRun) => void>();
	let sessionRecord: RunRecord | undefined;
	let minted = 0;

	const asyncToolNames = new Set(options.asyncTools ?? []);
	const hasAsyncTools = asyncToolNames.size > 0;
	const asyncToolPattern = createWildcardMatcher(asyncToolNames);
	const isAsyncTool = (tool: string): boolean =>
		asyncToolNames.has(tool) || asyncToolPattern(tool) !== undefined;

	const purge = () => {
		const now = Date.now();
		for (const [id, entry] of entries) {
			if (entry.finishedAt !== undefined && now - entry.finishedAt > ttlMs)
				entries.delete(id);
		}
		if (entries.size > maxRuns) {
			// Oldest announced settlements first; never evict pending runs.
			const evictable = [...entries.values()]
				.filter((e) => e.finishedAt !== undefined && e.announced)
				.sort((a, b) => a.finishedAt! - b.finishedAt!);
			for (const entry of evictable) {
				if (entries.size <= maxRuns) break;
				entries.delete(entry.id);
			}
		}
	};

	const digestEntry = (entry: RunEntry): RunDigestEntry => {
		if (entry.status === "pending") return { status: "pending" };
		const line: RunDigestEntry = { status: entry.status };
		if (entry.at !== undefined) line.at = entry.at;
		if (entry.error !== undefined) line.error = entry.error;
		if (entry.output !== undefined) {
			const json = JSON.stringify(entry.output);
			if (
				json !== undefined &&
				Buffer.byteLength(json, "utf8") > maxDigestOutputBytes
			) {
				line.outputOmitted = true;
			} else {
				line.output = entry.output;
			}
		}
		return line;
	};

	const settledRun = (entry: RunEntry): SettledRun => ({
		runId: entry.id,
		status: entry.status as SettledRun["status"],
		...(entry.output !== undefined ? { output: entry.output } : {}),
		...(entry.at !== undefined ? { at: entry.at } : {}),
		...(entry.error !== undefined ? { error: entry.error } : {}),
		...(entry.record !== undefined ? { record: entry.record } : {}),
	});

	/** Latest-settlement-wins merge of a run's FRESH step entries into the
	 * session. Fresh = not the same object carried over from the fork image
	 * (the engine carries reused/session entries by reference). */
	const mergeIntoSession = (entry: RunEntry, record: RunRecord) => {
		if (!sessionRecord) {
			sessionRecord = record;
			return;
		}
		const forked = entry.forkedFrom?.steps;
		const merged =
			sessionRecord === entry.forkedFrom
				? { ...record.steps }
				: { ...sessionRecord.steps };
		if (sessionRecord !== entry.forkedFrom) {
			for (const [id, state] of Object.entries(record.steps)) {
				if (forked?.[id] !== state) merged[id] = state;
			}
		}
		sessionRecord = {
			version: "2",
			script: record.script,
			status: record.status,
			at: record.at,
			steps: merged,
		};
	};

	const settle = (
		entry: RunEntry,
		result: ExecuteResult | { thrown: unknown },
	) => {
		entry.finishedAt = Date.now();
		if (entry.status === "cancelled") {
			// Cancelled while in flight: the result is discarded, not merged.
			notify(entry);
			return;
		}
		if ("thrown" in result) {
			const err = result.thrown;
			entry.status = "error";
			entry.error =
				err instanceof Error
					? {
							message: err.message,
							...(err instanceof ScriptExecutionError
								? { code: err.code }
								: {}),
						}
					: { message: String(err) };
			if (err instanceof ScriptExecutionError) entry.at = err.stepId;
			notify(entry);
			return;
		}
		entry.record = result.record;
		mergeIntoSession(entry, result.record);
		if (result.status === "error") {
			entry.status = "error";
			entry.at = result.at;
			entry.error = result.error;
		} else if (result.status === "suspended") {
			// The runner has no resolution channel - a suspension under it is a
			// host integration error, surfaced as such (use executeScript with
			// `resolutions` / an engine that parks runs instead).
			entry.status = "error";
			entry.at = result.state.at;
			entry.error = {
				message:
					`The run suspended (${result.suspensions.map((s) => s.key).join(", ")}), ` +
					"but this runner has no resolution channel - resolve suspensions with " +
					"executeScript({ resolutions }) or a suspension-aware host",
				code: "suspended_unsupported",
			};
		} else if (result.returnedAt !== undefined) {
			entry.status = "returned";
			entry.at = result.returnedAt;
			entry.output = result.output;
		} else {
			entry.status = "done";
			entry.output = result.output;
		}
		notify(entry);
	};

	const notify = (entry: RunEntry) => {
		// Push is for background news only: a run whose result went back inline
		// is already in its caller's hands.
		if (!entry.detached) return;
		const run = settledRun(entry);
		for (const listener of listeners) listener(run);
	};

	/** Walk `waitingOn` edges from `from`; true if `target` is reachable. */
	const wouldDeadlock = (from: string, target: string): boolean => {
		const seen = new Set<string>();
		const stack = [from];
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (id === target) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = entries.get(id);
			if (entry) stack.push(...entry.waitingOn);
		}
		return false;
	};

	const resolveAwait = async (
		self: RunEntry | undefined,
		request: CallRequest,
	): Promise<unknown> => {
		const segments = request.tool.split(".");
		const [, runId, stepId] = segments;
		if (segments.length < 2 || segments.length > 3 || !runId) {
			throw new ScriptExecutionError(
				`"${request.tool}" is not a valid await call - use "await.<runId>" or "await.<runId>.<stepId>"`,
				request.stepId,
				"invalid_await",
			);
		}
		const target = entries.get(runId);
		if (!target) {
			throw new ScriptExecutionError(
				`Unknown run "${runId}" - it never started here or its result expired. Re-run the original script instead.`,
				request.stepId,
				"unknown_run",
			);
		}
		if (target.status === "pending") {
			if (self) {
				if (wouldDeadlock(runId, self.id)) {
					throw new ScriptExecutionError(
						`Awaiting run "${runId}" would deadlock - it is (transitively) awaiting this run.`,
						request.stepId,
						"await_cycle",
					);
				}
				self.waitingOn.add(runId);
				try {
					await target.settled;
				} finally {
					self.waitingOn.delete(runId);
				}
			} else {
				await target.settled;
			}
		}
		if (target.status === "cancelled") {
			throw new ScriptExecutionError(
				`Run "${runId}" was cancelled.`,
				request.stepId,
				"run_cancelled",
			);
		}
		if (target.status === "error") {
			throw new ScriptExecutionError(
				`Awaited run "${runId}" failed${target.at ? ` at step "${target.at}"` : ""}: ${target.error?.message ?? "unknown error"}`,
				request.stepId,
				"awaited_run_failed",
			);
		}
		if (stepId === undefined) return target.output;
		const step = target.record?.steps[stepId];
		if (
			!step ||
			step.released ||
			(step.status !== "done" && step.status !== "returned")
		) {
			throw new ScriptExecutionError(
				`Run "${runId}" has no readable step "${stepId}"${step?.released ? " (its output was released)" : ""}.`,
				request.stepId,
				"unknown_step",
			);
		}
		return step.output;
	};

	/** The host's handlers plus the `await.*` join, bound to the calling run
	 * (so blocking on a pending target is deadlock-checked and attributed). */
	const makeHandlers = (
		self: RunEntry,
		base: ExecuteHandlers,
	): ExecuteHandlers => ({
		call: (request: CallRequest, ctx: CallContext) =>
			isAwaitCall(request.tool)
				? resolveAwait(self, request)
				: base.call(request, ctx),
	});

	const startResult = (entry: RunEntry): StartResult => {
		if (entry.status === "error") {
			return {
				runId: entry.id,
				status: "error",
				at: entry.at ?? "",
				error: entry.error!,
				record: entry.record!,
			};
		}
		return {
			runId: entry.id,
			status: "done",
			output: entry.output,
			...(entry.status === "returned" && entry.at !== undefined
				? { returnedAt: entry.at }
				: {}),
			record: entry.record!,
		};
	};

	const start = async (
		script: Script,
		opts: StartOptions = {},
	): Promise<StartResult> => {
		purge();
		const base = opts.handlers ?? options.handlers;
		if (!base) {
			throw new ScriptExecutionError(
				"No handlers: pass them to createRunner or to start()",
				script.id ?? "",
				"no_handlers",
			);
		}
		const detach = (script.await ?? opts.await ?? true) === false;
		let runId = script.id ?? opts.runId;
		if (runId === undefined) {
			do runId = `r${++minted}`;
			while (entries.has(runId));
		}

		const scriptJson = JSON.stringify(script);
		const existing = entries.get(runId);
		if (existing?.status === "pending") {
			if (existing.scriptJson === scriptJson) {
				// Idempotent resubmit: same name, same script - it's the same run.
				existing.detached = true;
				return { runId, status: "pending" };
			}
			throw new ScriptExecutionError(
				`Run "${runId}" is still pending with a different script - await it, cancel it, or pick another id.`,
				runId,
				"run_id_in_use",
			);
		}

		// Not-awaited steps split off as their own derived runs (named by step
		// id) and the rest of the script runs without them. Fired only after
		// the main run settles "done" - their expressions resolve against the
		// session, which by then holds this run's steps. A step is not awaited
		// when it says `"await": false`, or automatically when it calls a
		// background-by-default tool AND nothing in this script consumes it
		// (no later reference or `after` edge, not the last step, no
		// `"await": true` pin).
		const anyAsyncToolCall =
			hasAsyncTools &&
			script.steps.some((s) => isCallStep(s) && isAsyncTool(s.call));
		const referenced = anyAsyncToolCall ? referencedNames(script) : undefined;
		const lastStep = script.steps[script.steps.length - 1];
		const detachable = (step: Script["steps"][number]): step is CallStep =>
			isCallStep(step) &&
			step.await !== true &&
			(step.await === false ||
				(referenced !== undefined &&
					isAsyncTool(step.call) &&
					step !== lastStep &&
					!referenced.has(step.id)));
		// Clusters preserve intent: background steps form their own cluster
		// each, fired in SCRIPT ORDER one after another, so side-effect
		// ordering survives detachment - "close all, then report" reports
		// totals that include the closes.
		const backgroundClusters: CallStep[][] = [];
		const mainSteps: Script["steps"] = [];
		for (const step of script.steps) {
			if (detachable(step)) backgroundClusters.push([step]);
			else mainSteps.push(step);
		}
		const mainScript =
			backgroundClusters.length > 0 ? { ...script, steps: mainSteps } : script;

		const entry: RunEntry = {
			id: runId,
			scriptJson,
			status: "pending",
			forkedFrom: sessionRecord,
			settled: Promise.resolve(),
			announced: false,
			waitingOn: new Set(),
		};
		// A settled entry under this id is superseded: starting the same script
		// again with the same name IS the continuation idiom (reconciliation
		// reuses its settled steps via the session record).
		entries.set(runId, entry);

		entry.settled = executeScript(mainScript, {
			handlers: makeHandlers(entry, base),
			limits: options.limits,
			state: sessionRecord,
			input: opts.input,
			variables: opts.variables,
			retainOutputs: options.retainOutputs ?? "all",
		}).then(
			(result) => settle(entry, result),
			(thrown) => settle(entry, { thrown }),
		);

		if (backgroundClusters.length > 0) {
			void entry.settled.then(async () => {
				// Fail-fast: an errored/returned/cancelled main run fires nothing.
				if (entry.status !== "done") return;
				const fireOne = async (
					step: CallStep,
				): Promise<RunStatus | undefined> => {
					const { await: _await, ...derived } = step;
					try {
						await start(
							{
								version: script.version,
								id: step.id,
								await: false,
								intent: step.reason ?? script.intent,
								steps: [derived],
							},
							// deadlineMs 0: nobody holds this start's return value, so the
							// settlement must flow through digest/push/await - never inline.
							{
								input: opts.input,
								variables: opts.variables,
								handlers: base,
								deadlineMs: 0,
							},
						);
					} catch {
						// A same-id run is already pending with a different script - its
						// own settlement will announce under this id; the step did not
						// re-fire. (run_id_in_use is the only start() throw here.)
						return undefined;
					}
					const derivedEntry = entries.get(step.id);
					if (derivedEntry) await derivedEntry.settled;
					return entries.get(step.id)?.status;
				};
				// Clusters run one after another (script order = side-effect order);
				// steps inside a cluster run together. A failed or cancelled cluster
				// stops the chain - later background work assumed it happened.
				for (const cluster of backgroundClusters) {
					const outcomes = await Promise.all(cluster.map(fireOne));
					if (
						outcomes.some(
							(status) => status === "error" || status === "cancelled",
						)
					)
						return;
				}
			});
		}

		if (!detach) {
			await entry.settled;
			entry.announced = true; // the caller holds the result - nothing to announce
			return startResult(entry);
		}

		const deadline = opts.deadlineMs ?? deadlineMs;
		if (deadline > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const raced = await Promise.race([
				entry.settled.then(() => "settled" as const),
				new Promise<"deadline">((resolve) => {
					timer = setTimeout(() => resolve("deadline"), deadline);
				}),
			]);
			clearTimeout(timer);
			if (raced === "settled") {
				entry.announced = true;
				return startResult(entry);
			}
		}
		entry.detached = true;
		return { runId, status: "pending" };
	};

	return {
		start,
		status: (runId) => {
			purge();
			const entry = entries.get(runId);
			return entry && digestEntry(entry);
		},
		result: async (runId) => {
			const entry = entries.get(runId);
			if (!entry) {
				throw new ScriptExecutionError(
					`Unknown run "${runId}" - it never started here or its result expired.`,
					runId,
					"unknown_run",
				);
			}
			await entry.settled;
			return settledRun(entry);
		},
		record: (runId) => entries.get(runId)?.record,
		session: () => sessionRecord,
		digest: () => {
			purge();
			const out: Record<string, RunDigestEntry> = {};
			for (const entry of entries.values()) {
				if (entry.status === "pending") {
					out[entry.id] = { status: "pending" };
				} else if (!entry.announced) {
					out[entry.id] = digestEntry(entry);
					entry.announced = true;
				}
			}
			return out;
		},
		onRunSettled: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		acknowledge: (runId) => {
			const entry = entries.get(runId);
			if (entry && entry.status !== "pending") entry.announced = true;
		},
		cancel: (runId) => {
			const entry = entries.get(runId);
			if (entry?.status !== "pending") return false;
			entry.status = "cancelled";
			entry.finishedAt = Date.now();
			entry.announced = false;
			return true;
		},
	};
}
