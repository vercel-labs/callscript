/**
 * The DURABLE runner: callscript's pure state machine, persisted between
 * executions. Where `createRunner` (runner.ts) is in-memory and treats a
 * suspension as a host integration error, this runner treats suspension
 * as the normal shape of long work - an approval, a sign-in, a slow job
 * park the run in STORAGE, and a later resolution re-executes it
 * (reconciliation reuses settled steps; side effects never re-fire).
 *
 * The storage contract is deliberately four calls, with `compareAndSet`
 * as the concurrency floor: every execution round is claimed by a CAS on
 * the stored revision, so two concurrent resumes cannot both dispatch the
 * same round. Exactly-once at the tool still needs idempotency keys -
 * dispatch carries `stepId`/`itemIndex`, and the host adds the run id.
 */

import { executeScript, stableStringify } from "./execute";
import { sha256Hex } from "./hash";
import type {
	ExecuteHandlers,
	ExecuteResult,
	JsonValue,
	RunState,
	Script,
	ScriptLimits,
	SuspensionRequest,
} from "./types";
import { validateScript } from "./validate";

/* ---------------------------------------------------------------- storage */

export type StoredRunStatus = "running" | "suspended" | "completed" | "failed";

export type StoredRun = {
	id: string;
	/** Who the run belongs to - the isolation key between principals
	 * sharing one storage. */
	owner: string;
	script: Script;
	/** Canonical hash of the script - resubmits must match. */
	scriptHash: string;
	/** The run record from the last execution round. */
	state?: RunState;
	status: StoredRunStatus;
	suspensions?: SuspensionRequest[];
	/** Resolutions delivered but not yet consumed by a resume. */
	resolutions?: Record<string, JsonValue>;
	output?: unknown;
	error?: { message: string; code?: string; at?: string };
	/** Optimistic-concurrency revision - bumped on every write. */
	revision: number;
	createdAt: Date;
	updatedAt: Date;
	expiresAt: Date;
};

export interface CallscriptStorage {
	create(run: StoredRun): Promise<void>;
	get(runId: string): Promise<StoredRun | null>;
	/** Persist `next` only when the stored revision still equals
	 * `revision`; answers whether the write won. Backends without native
	 * CAS emulate it with a transaction on the revision column. */
	compareAndSet(
		runId: string,
		revision: number,
		next: StoredRun,
	): Promise<boolean>;
	delete(runId: string): Promise<void>;
}

/** In-memory storage - development and tests. Nothing survives restart. */
export function memoryStorage(): CallscriptStorage {
	const runs = new Map<string, StoredRun>();
	return {
		async create(run) {
			if (runs.has(run.id)) throw new Error(`run "${run.id}" already exists`);
			runs.set(run.id, structuredClone(run));
		},
		async get(runId) {
			const run = runs.get(runId);
			return run ? structuredClone(run) : null;
		},
		async compareAndSet(runId, revision, next) {
			const current = runs.get(runId);
			if (!current || current.revision !== revision) return false;
			runs.set(runId, structuredClone({ ...next, revision: revision + 1 }));
			return true;
		},
		async delete(runId) {
			runs.delete(runId);
		},
	};
}

/* ----------------------------------------------------------------- runner */

export interface CallscriptScheduler {
	/** Wake `runId` (call `runner.resume(runId)`) - now, or at `at`. */
	schedule(runId: string, options?: { at?: Date }): Promise<void>;
}

export type DurableRunResult =
	| { runId: string; status: "completed"; output: unknown }
	| {
			runId: string;
			status: "failed";
			error: { message: string; code?: string; at?: string };
	  }
	| { runId: string; status: "suspended"; suspensions: SuspensionRequest[] };

export type DurableRunnerOptions = {
	storage: CallscriptStorage;
	handlers: ExecuteHandlers;
	/** Tool registry the validator checks `call` steps against. */
	tools: string[];
	limits?: Partial<ScriptLimits>;
	requireReason?: boolean;
	scheduler?: CallscriptScheduler;
	/** How long a stored run stays resumable (default 24h). */
	ttlMs?: number;
};

export type DurableRunner = {
	start(options: {
		script: unknown;
		owner: string;
		runId?: string;
		input?: unknown;
		variables?: Record<string, unknown>;
		/** Answers to a prior round's suspensions - the re-submit idiom
		 * (same id + same script + resolutions continues the run). */
		resolutions?: Record<string, JsonValue>;
	}): Promise<DurableRunResult>;
	/** Deliver resolutions (or just a wake-up) and re-execute. */
	resume(
		runId: string,
		options?: {
			owner?: string;
			resolutions?: Record<string, JsonValue>;
			input?: unknown;
			variables?: Record<string, unknown>;
		},
	): Promise<DurableRunResult>;
	get(runId: string): Promise<StoredRun | null>;
};

const scriptHashOf = (script: Script): string =>
	sha256Hex(stableStringify(script));

const mintRunId = (): string => `run_${crypto.randomUUID().slice(0, 13)}`;

/** @experimental The durable runner API may change before it stabilizes in a minor release. */
export function createDurableRunner(
	options: DurableRunnerOptions,
): DurableRunner {
	const ttlMs = options.ttlMs ?? 24 * 3600 * 1000;

	const settle = (run: StoredRun, result: ExecuteResult): StoredRun => {
		const next: StoredRun = {
			...run,
			state: result.state,
			updatedAt: new Date(),
			suspensions: undefined,
			resolutions: undefined,
		};
		if (result.status === "ok") {
			next.status = "completed";
			next.output = result.output;
		} else if (result.status === "error") {
			next.status = "failed";
			next.error = { ...result.error, at: result.at };
		} else {
			next.status = "suspended";
			next.suspensions = result.suspensions;
		}
		return next;
	};

	const executeRound = async (
		run: StoredRun,
		round: {
			resolutions?: Record<string, JsonValue>;
			input?: unknown;
			variables?: Record<string, unknown>;
		},
	): Promise<DurableRunResult> => {
		// Claim the round: whoever wins the CAS owns this execution.
		const claimed: StoredRun = {
			...run,
			status: "running",
			updatedAt: new Date(),
		};
		const won = await options.storage.compareAndSet(
			run.id,
			run.revision,
			claimed,
		);
		if (!won) {
			return {
				runId: run.id,
				status: "failed",
				error: {
					message: `run "${run.id}" is being executed concurrently - retry after it settles`,
					code: "run_conflict",
				},
			};
		}
		claimed.revision = run.revision + 1;

		let result: ExecuteResult;
		try {
			result = await executeScript(run.script, {
				handlers: options.handlers,
				limits: options.limits,
				state: run.state,
				resolutions: round.resolutions,
				input: round.input,
				variables: round.variables,
				retainOutputs: "all",
			});
		} catch (thrown) {
			const failed: StoredRun = {
				...claimed,
				status: "failed",
				error: {
					message: thrown instanceof Error ? thrown.message : String(thrown),
					code: (thrown as { code?: string })?.code,
				},
				updatedAt: new Date(),
			};
			await options.storage.compareAndSet(run.id, claimed.revision, failed);
			return { runId: run.id, status: "failed", error: failed.error! };
		}

		const settled = settle(claimed, result);
		await options.storage.compareAndSet(run.id, claimed.revision, settled);

		if (settled.status === "suspended") {
			// Pure timed waits (retryAfterMs, no interaction) self-schedule.
			const timed = settled.suspensions?.find(
				(suspension) =>
					suspension.retryAfterMs !== undefined && !suspension.interaction,
			);
			if (timed && options.scheduler) {
				await options.scheduler.schedule(run.id, {
					at: new Date(Date.now() + (timed.retryAfterMs ?? 0)),
				});
			}
			return {
				runId: run.id,
				status: "suspended",
				suspensions: settled.suspensions ?? [],
			};
		}
		if (settled.status === "failed") {
			return { runId: run.id, status: "failed", error: settled.error! };
		}
		return { runId: run.id, status: "completed", output: settled.output };
	};

	const start: DurableRunner["start"] = async (startOptions) => {
		const script = validateScript(startOptions.script, {
			...options.limits,
			tools: options.tools,
			requireReason: options.requireReason,
			variables: Object.keys(startOptions.variables ?? {}),
		});
		const runId = script.id ?? startOptions.runId ?? mintRunId();
		const hash = scriptHashOf(script);

		const existing = await options.storage.get(runId);
		if (existing) {
			if (existing.owner !== startOptions.owner) {
				return {
					runId,
					status: "failed",
					error: {
						message: `run "${runId}" belongs to another owner`,
						code: "run_forbidden",
					},
				};
			}
			if (existing.scriptHash !== hash) {
				return {
					runId,
					status: "failed",
					error: {
						message: `run "${runId}" exists with a different script - pick another id`,
						code: "run_id_in_use",
					},
				};
			}
			if (existing.status === "completed") {
				return { runId, status: "completed", output: existing.output };
			}
			if (existing.status === "failed") {
				return { runId, status: "failed", error: existing.error! };
			}
			// Same script, same id: the continuation idiom - re-execute
			// against the stored state (approvals answered via resolutions).
			return executeRound(existing, {
				resolutions: { ...existing.resolutions, ...startOptions.resolutions },
				input: startOptions.input,
				variables: startOptions.variables,
			});
		}

		const run: StoredRun = {
			id: runId,
			owner: startOptions.owner,
			script,
			scriptHash: hash,
			status: "running",
			revision: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			expiresAt: new Date(Date.now() + ttlMs),
		};
		await options.storage.create(run);
		return executeRound(run, {
			resolutions: startOptions.resolutions,
			input: startOptions.input,
			variables: startOptions.variables,
		});
	};

	const resume: DurableRunner["resume"] = async (runId, resumeOptions) => {
		const run = await options.storage.get(runId);
		if (!run) {
			return {
				runId,
				status: "failed",
				error: {
					message: `unknown run "${runId}" - it never started here or expired`,
					code: "unknown_run",
				},
			};
		}
		if (
			resumeOptions?.owner !== undefined &&
			run.owner !== resumeOptions.owner
		) {
			return {
				runId,
				status: "failed",
				error: {
					message: `run "${runId}" belongs to another owner`,
					code: "run_forbidden",
				},
			};
		}
		if (run.status === "completed") {
			return { runId, status: "completed", output: run.output };
		}
		if (run.status === "failed") {
			return { runId, status: "failed", error: run.error! };
		}
		if (new Date(run.expiresAt).getTime() <= Date.now()) {
			return {
				runId,
				status: "failed",
				error: { message: `run "${runId}" expired`, code: "run_expired" },
			};
		}
		return executeRound(run, {
			resolutions: { ...run.resolutions, ...resumeOptions?.resolutions },
			input: resumeOptions?.input,
			variables: resumeOptions?.variables,
		});
	};

	return { start, resume, get: (runId) => options.storage.get(runId) };
}
