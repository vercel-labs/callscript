/**
 * The tool door onto the callscript engine.
 *
 * The language core is host-agnostic: `executeScript` takes a string
 * tool registry and one `handlers.call` dispatcher, and what a "tool"
 * is stays the host's problem. This file rebuilds that boundary around
 * ONE neutral shape - `ScriptTool` (see tool.ts) - so any ecosystem
 * plugs in through an adapter (or a plain object literal):
 *
 * - the tool registry IS the mounted tools' names - `validate` rejects
 *   anything else before a run starts
 * - a script's `call` dispatches to the tool's `execute`; a thrown
 *   error's `code` surfaces as the step error's machine-readable code
 * - the SESSION is a plain scope object (`engine.scope()`): the run
 *   record accumulates on it, host-seeded vars are readable from
 *   expressions, and runs handed the same scope share all of it
 * - a script COMPILES into a tool (`engine.tool`): mountable on another
 *   engine, its session joined through the caller's scope - and its
 *   gates compose (an inner approval gate ends the hosting run early)
 *
 * The language core (expressions, validation, limits, records, the
 * runner) is untouched - this file only rebuilds the boundary.
 */
import { analyzeScript, renderScript } from "./analyze";
import {
	baseCard,
	jsLanguageCard,
	jsScriptInputSchema,
	languageCard,
	type SessionEntry,
	scriptJsonSchema,
	searchTools,
	sessionCard,
	toolCard,
} from "./describe";
import {
	EarlyReturnSignal,
	executeScript,
	planExecution,
	publishedVariables,
	ScriptExecutionError,
	SuspendSignal,
	stableStringify,
} from "./execute";
import { resolveFnExprs } from "./fn-expr";
import {
	createRunner,
	type RunnerOptions,
	type ScriptRunner,
	type StartOptions,
	type StartResult,
} from "./runner";
import {
	type AnyScriptTool,
	createScope,
	type ScriptScope,
	type ScriptTool,
	type ToolCallContext,
	type ToolMap,
} from "./tool";
import type { TypedScriptOf } from "./typed";
import type {
	ExecuteHandlers,
	ExecuteOptions,
	ExecuteResult,
	JsonValue,
	RunState,
	Script,
	ScriptLimits,
	SerializedError,
	SuspensionRequest,
} from "./types";
import {
	ScriptValidationError,
	type ValidateOptions,
	validateScript,
} from "./validate";

export interface ScriptEngineOptions<TS extends readonly AnyScriptTool[]> {
	/**
	 * The tools scripts may call, by NAME - hand it adapter output
	 * (`fromAISDKTools(...)`), plain literals, compiled
	 * scripts from another engine, or any mix.
	 */
	tools: TS;
	limits?: Partial<ScriptLimits>;
	/** When true, every call step must carry a non-empty `reason`. */
	requireReason?: boolean;
	/** The per-step scrutiny policy (see `ExecuteOptions.suspend`). */
	suspend?: ExecuteOptions["suspend"];
	/**
	 * The AUTHORING surface the prompt layers teach ("js" by default).
	 * "js": the model writes plain JavaScript statements, compiled (never
	 * executed) into the same inert plan - a fraction of the instruction.
	 * "json": the model emits the JSON plan directly, taught field-by-field
	 * through `scriptJsonSchema`. Execution accepts BOTH regardless - this
	 * only decides what `describe`/`toolDefinition`/`agentTools` teach.
	 */
	format?: "js" | "json";
}

/** One execution: the script plus the per-execute channel (`input`,
 * suspension `resolutions`, ...). Session state is implicit - it lives
 * on the scope passed alongside - but an explicit `state` still wins
 * for hosts that manage records themselves. */
export interface RunInput {
	/** The script - raw model JSON or a validated/typed one. Validated at
	 * the door either way, every issue reported. */
	script: unknown;
	/** Per-execute data bound as `input` in every expression. Ephemeral. */
	input?: unknown;
	/** Explicit session state - overrides the scope's accumulated record. */
	state?: RunState;
	/** Answers to outstanding suspensions, by key. */
	resolutions?: Record<string, JsonValue>;
	/** Host-injected session variables (their names validate as referable). */
	variables?: Record<string, unknown>;
	/** Default "all" here (unlike bare executeScript): the session lives on
	 * the scope, and published variables need outputs to survive the run. */
	retainOutputs?: "live" | "all";
}

export type SessionOptions = Omit<RunnerOptions, "handlers">;

/** A session runner whose `start` validates at the door (same registry as
 * `run`, plus the `await.*` join namespace the runner serves). */
export type SessionRunner = Omit<ScriptRunner, "start"> & {
	start(script: unknown, options?: StartOptions): Promise<StartResult>;
};

/**
 * A script compiled into a tool: mountable on another engine, where a
 * `call` naming it runs the whole script - against the CALLER's scope,
 * so the inner session rides the outer one. Ends and pauses COMPOSE: a
 * `return` gate throws `EarlyReturnSignal` (a hosting run ends early
 * with the payload; a direct caller catches it), a suspension throws
 * `SuspendSignal`. Call it directly with `execute(input, { scope })`.
 */
export type CompiledScriptTool<
	K extends string = string,
	A = any,
	R = unknown,
> = ScriptTool<K, A, R> & {
	readonly $script: true;
	/** The validated, normalized script - render/analyze/plan off this. */
	readonly script: Script;
	/** Free names the script reads from the session - its data requires,
	 * checked against the live session on every call. */
	readonly external: readonly string[];
	/** Direct-call form: ctx is optional (pass `{ scope }` to join one). */
	execute(args?: A, ctx?: Partial<ToolCallContext>): Promise<R>;
};

/** One host-neutral agent tool: hand `description`/`inputSchema` to any
 * tool interface and dispatch to `execute`. The AI SDK wrapper is
 * `toAISDKTools(engine)` from `callscript/ai-sdk`. */
export interface AgentTool<A = any, R = unknown> {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute(args: A): Promise<R>;
}

export interface AgentToolsOptions {
	/** The session scope runs execute against - state, vars, and the memo
	 * table persist across `execute` calls (suspended runs resume here).
	 * Default: a fresh scope minted per `agentTools()` call. */
	scope?: ScriptScope;
	/** Inline every tool card in the `execute` description. Default: true
	 * up to 20 mounted tools; past that the cards move behind `search`,
	 * so the prompt stays small and the model discovers tools as needed. */
	inlineTools?: boolean;
	/** Rename the pair (defaults: "execute" / "search"). */
	names?: { execute?: string; search?: string };
	/** Override the engine's authoring `format` for this pair. */
	format?: "js" | "json";
}

/** What the `execute` agent tool returns to the model: the run outcome
 * without the session `state` (that rides the scope, not the prompt). */
export type AgentExecuteResult =
	| { status: "ok"; output: unknown; returnedAt?: string }
	| { status: "error"; at: string; error: SerializedError }
	| { status: "suspended"; suspensions: SuspensionRequest[] }
	| { status: "invalid"; issues: string[] };

export interface AgentSearchInput {
	/** Keywords matched against tool names, descriptions, and signatures. */
	query: string;
	/** Maximum matches to return (default 10). */
	limit?: number;
}

export interface ScriptEngine<TS extends readonly AnyScriptTool[]> {
	/** Execute one script (validated at the door). A `scope` makes it a
	 * session run: state, vars, and the memo table ride the scope. */
	run(input: RunInput, scope?: ScriptScope): Promise<ExecuteResult>;
	/**
	 * Mint a session scope - the session as a VALUE. Runs and compiled
	 * tools handed it share vars AND the accumulated record, so
	 * re-executing (approvals, suspensions) needs no state threading:
	 *
	 *   const s = engine.scope({ user });
	 *   await engine.run({ script }, s);                            // gate fires
	 *   await engine.run({ script, input: { approved: true } }, s); // resumes
	 */
	scope(seed?: Record<string, unknown>): ScriptScope;
	/** Open a session: async runs, `await.<id>` joins, the settlement
	 * digest, and an accumulated record every new run executes against.
	 * A `scope` shares its vars with (and absorbs settlements into) it. */
	session(options?: SessionOptions, scope?: ScriptScope): SessionRunner;
	/**
	 * TYPED script authoring: `call` is the union of mounted tool names
	 * and `args` is that tool's argument type (expressions allowed
	 * anywhere). Authoring arrows are scope-typed: a name bound by an
	 * earlier CALL step carries that tool's return type. Returns the
	 * validated, normalized script.
	 */
	script<const Marks extends readonly unknown[]>(
		input: TypedScriptOf<ToolMap<TS>, Marks>,
	): Script;
	/** Compile a script into a tool - see `CompiledScriptTool`. */
	tool<K extends string, const Marks extends readonly unknown[]>(
		name: K,
		script: TypedScriptOf<ToolMap<TS>, Marks>,
		options?: { description?: string },
	): CompiledScriptTool<K>;
	/** The tool names scripts may call. */
	tools: string[];
	/**
	 * The STATIC prompt context for an authoring model: the language card
	 * (rendered against this engine's limits) and one signature card per
	 * mounted tool. Stable for the engine's lifetime - put it in the
	 * cacheable prefix and pair it with `context(scope)` for the live part.
	 */
	describe(): string;
	/**
	 * The engine as ONE TOOL of an agent: `inputSchema` is the script
	 * format as an annotated JSON Schema (the step shapes teach
	 * themselves, field by field, against this engine's limits), and
	 * `description` is everything a schema cannot say - the base card
	 * (what a script is, expression semantics, ordering rules) plus one
	 * TS-ish signature per mounted tool. Hand both to the tool interface
	 * verbatim; static per engine, so it caches like `describe()`. Pair
	 * with `context(scope)` for the live session card.
	 */
	toolDefinition(): {
		description: string;
		inputSchema: Record<string, unknown>;
	};
	/**
	 * The engine as an agent TOOL PAIR, ready to mount on any host:
	 * `execute` runs one script against a shared session scope (invalid
	 * scripts come back as `status: "invalid"` with every issue, for the
	 * model to retry; the session `state` stays on the scope, never in
	 * the result), and `search` finds mounted tools by keyword, returning
	 * their signature cards. With few tools `execute`'s description
	 * inlines all the cards; past `inlineTools` the model discovers them
	 * through `search` instead.
	 */
	agentTools(options?: AgentToolsOptions): {
		execute: AgentTool<unknown, AgentExecuteResult>;
		search: AgentTool<AgentSearchInput, string>;
	};
	/**
	 * The LIVE prompt context: every name a script can reference in this
	 * scope right now - step outputs published by prior runs, vars the
	 * scope holds - with short value previews. Re-render per turn.
	 */
	context(scope?: ScriptScope): string;
	/** Validate a script against the registry; throws with EVERY issue. */
	validate(input: unknown, overrides?: ValidateOptions): Script;
	analyze: typeof analyzeScript;
	render: typeof renderScript;
	plan: typeof planExecution;
}

export const callscript = <const TS extends readonly AnyScriptTool[]>(
	options: ScriptEngineOptions<TS>,
): ScriptEngine<TS> => {
	// name -> tool. Two entries under one name would make dispatch
	// ambiguous - caught here, not at the first colliding call.
	const registry = new Map<string, AnyScriptTool>();
	for (const tool of options.tools) {
		const existing = registry.get(tool.name);
		if (existing !== undefined && existing !== tool) {
			throw new Error(
				`two different tools share the name "${tool.name}" - ` +
					"a script call names exactly one tool, so names must be unique",
			);
		}
		registry.set(tool.name, tool);
	}
	const tools = [...registry.keys()];

	// Arrows in expression positions transpile to strings FIRST (see
	// fn-expr.ts), so every door - run, tool, script, session.start -
	// takes the JS-native authoring form and everything downstream stays data.
	const validate = (input: unknown, overrides?: ValidateOptions): Script =>
		validateScript(resolveFnExprs(input), {
			...options.limits,
			tools,
			requireReason: options.requireReason,
			...overrides,
		});

	/** Session-variable names a script may reference without a producing
	 * step: what the state published, plus the run's bindings. */
	const referable = (
		state: RunState | undefined,
		variables: Record<string, unknown>,
	): string[] => [
		...(state ? Object.keys(publishedVariables(state)) : []),
		...Object.keys(variables),
	];

	/** Persist a run's outcome into the scope: the record merges in,
	 * latest settlement per step - so the next run in the scope reuses
	 * settled steps and reads published outputs as session variables. */
	const persist = (scope: ScriptScope | undefined, state: RunState) => {
		if (!scope) return;
		const prior = scope.state;
		scope.state = prior
			? { ...state, steps: { ...prior.steps, ...state.steps } }
			: state;
	};

	/**
	 * The one dispatcher: a resolved call goes to the tool whose name
	 * matches. Idempotent tools are input-addressed: same name + same
	 * resolved args -> ONE dispatch per scope, shared even between
	 * concurrent steps (the memo holds the in-flight promise); failures
	 * - including suspend/earlyReturn signals - never cache.
	 */
	const handlersFrom = (scope?: ScriptScope): ExecuteHandlers => ({
		call: async (request, ctx) => {
			const tool = registry.get(request.tool);
			if (tool === undefined) {
				throw new ScriptExecutionError(
					`No tool named "${request.tool}" is mounted on this engine`,
					request.stepId,
					"unknown_tool",
				);
			}
			const callContext: ToolCallContext = {
				...ctx,
				stepId: request.stepId,
				toolName: request.tool,
				reason: request.reason,
				itemIndex: request.itemIndex,
				scope,
			};
			const invoke = async () => tool.execute(request.args, callContext);
			if (tool.idempotent !== true || scope === undefined) {
				return invoke();
			}
			const key = `${request.tool}:${stableStringify(request.args)}`;
			const hit = scope.memo.get(key);
			if (hit !== undefined) return hit;
			const pending = invoke();
			scope.memo.set(key, pending);
			pending.catch(() => scope.memo.delete(key));
			return pending;
		},
	});

	// Sync-start on purpose: a validation failure THROWS from the call
	// (contract at the door), only execution itself is async.
	const run = (
		input: RunInput,
		scope?: ScriptScope,
	): Promise<ExecuteResult> => {
		const { script, ...exec } = input ?? {};
		const state = exec.state ?? scope?.state;
		const variables = { ...scope?.vars, ...exec.variables };
		const validated = validate(script, {
			variables: referable(state, variables),
		});
		return executeScript(validated, {
			handlers: handlersFrom(scope),
			limits: options.limits,
			suspend: options.suspend,
			input: exec.input,
			state,
			resolutions: exec.resolutions,
			variables,
			retainOutputs: exec.retainOutputs ?? "all",
		}).then((result) => {
			persist(scope, result.state);
			return result;
		});
	};

	/**
	 * Tolerant compile-time validation: names no step produces are the
	 * script's EXTERNALS (session data it expects), not errors - collect
	 * them, validate again with them referable. Anything else still throws,
	 * and each call revalidates against the live session, so a genuinely
	 * missing external fails pointedly before anything runs.
	 */
	const compileValidate = (
		input: unknown,
	): { script: Script; external: string[] } => {
		const finish = (script: Script) => ({
			script,
			external: analyzeScript(script).external,
		});
		try {
			return finish(validate(input));
		} catch (err) {
			if (!(err instanceof ScriptValidationError)) throw err;
			const unknown = new Set<string>();
			let rest = 0;
			for (const issue of err.issues) {
				const match = /^Unknown reference "([^"]+)"/.exec(issue.message);
				if (match) unknown.add(match[1]!);
				else rest++;
			}
			if (rest > 0 || unknown.size === 0) throw err;
			// Forward references and sibling reads stay illegal: validateScript
			// ignores variables that collide with declared step ids, so those
			// re-throw here with their pointed message.
			return finish(validate(input, { variables: [...unknown] }));
		}
	};

	const compile = (
		name: string,
		rawScript: unknown,
		opts: { description?: string } = {},
	): CompiledScriptTool => {
		// Arrows transpile ONCE at compile time; every later validation
		// works off the resolved data form.
		const scriptInput = resolveFnExprs(rawScript);
		const { script: compiledScript, external } = compileValidate(scriptInput);
		// Sync-start: a stale external or bad script THROWS from the call
		// (contract at the door), only execution itself is async.
		const execute = (args?: any, ctx?: Partial<ToolCallContext>) => {
			const scope = ctx?.scope;
			const state = scope?.state;
			const variables = { ...scope?.vars };
			const script = validate(scriptInput, {
				variables: referable(state, variables),
			});
			return executeScript(script, {
				handlers: handlersFrom(scope),
				limits: options.limits,
				suspend: options.suspend,
				input: args,
				state,
				variables,
				retainOutputs: "all",
			}).then((result) => {
				persist(scope, result.state);
				if (result.status === "error") {
					throw new ScriptExecutionError(
						result.error.message,
						result.at,
						result.error.code ?? "call_failed",
					);
				}
				if (result.status === "suspended") {
					// The first suspension carries the signal; the rest
					// re-raise on re-entry (suspended steps re-dispatch).
					throw new SuspendSignal(result.suspensions[0]!);
				}
				if (result.returnedAt !== undefined) {
					// The gate composes: a hosting run ends early with the
					// payload; a direct caller catches EarlyReturnSignal.
					throw new EarlyReturnSignal(result.output);
				}
				return result.output;
			});
		};
		return {
			name,
			description: opts.description ?? compiledScript.intent,
			execute,
			$script: true as const,
			script: compiledScript,
			external,
		};
	};

	const session = (
		opts: SessionOptions = {},
		scope?: ScriptScope,
	): SessionRunner => {
		const runner = createRunner({
			...opts,
			limits: { ...options.limits, ...opts.limits },
			handlers: handlersFrom(scope),
		});
		const absorb = (record: RunState | undefined) => {
			if (record) persist(scope, record);
		};
		// Detached settlements land in the scope too.
		runner.onRunSettled((settled) => {
			if (settled.status !== "cancelled") absorb(settled.record);
		});
		return {
			...runner,
			// The runner serves the `await.*` join namespace, and both its
			// accumulated session and the scope's vars are referable -
			// captured at START time, not session creation.
			start: async (script, startOpts) => {
				const variables = {
					...scope?.vars,
					...startOpts?.variables,
				};
				const result = await runner.start(
					validate(script, {
						tools: [...tools, "await.*"],
						variables: referable(runner.session(), variables),
					}),
					{ ...startOpts, variables },
				);
				if (result.status !== "pending") absorb(result.record);
				return result;
			},
		};
	};

	/** The engine-specific prompt section: one signature card per tool. */
	const engineSections = (): string[] => [
		`## tools\n${tools.map((name) => toolCard(registry.get(name)!)).join("\n")}`,
	];

	const describeOptions = {
		limits: options.limits,
		requireReason: options.requireReason,
	};
	const engineFormat = options.format ?? "js";

	/** The static prompt context - language card plus tool cards. */
	const describe = (): string =>
		[
			engineFormat === "json"
				? languageCard(describeOptions)
				: jsLanguageCard(describeOptions),
			...engineSections(),
		].join("\n\n");

	/** The engine as one agent tool - see `ScriptEngine.toolDefinition`. */
	const toolDefinition = () =>
		engineFormat === "json"
			? {
					description: [baseCard(describeOptions), ...engineSections()].join(
						"\n\n",
					),
					inputSchema: scriptJsonSchema(describeOptions),
				}
			: {
					description: [
						jsLanguageCard(describeOptions),
						...engineSections(),
					].join("\n\n"),
					inputSchema: jsScriptInputSchema(),
				};

	/** The engine as an agent tool pair - see `ScriptEngine.agentTools`. */
	const agentTools = (opts: AgentToolsOptions = {}) => {
		const scope = opts.scope ?? createScope();
		const format = opts.format ?? engineFormat;
		const executeName = opts.names?.execute ?? "execute";
		const searchName = opts.names?.search ?? "search";
		const mounted = [...registry.values()];
		const inline = opts.inlineTools ?? mounted.length <= 20;
		const description = [
			format === "json"
				? baseCard(describeOptions)
				: jsLanguageCard(describeOptions),
			inline
				? engineSections().join("\n\n")
				: `## tools\n${mounted.length} tools are mounted; a script may only ` +
					`call mounted tools. Call \`${searchName}\` to find them by ` +
					"keyword before authoring.",
		].join("\n\n");
		const execute: AgentTool<unknown, AgentExecuteResult> = {
			name: executeName,
			description,
			inputSchema:
				format === "json"
					? scriptJsonSchema(describeOptions)
					: jsScriptInputSchema(),
			execute: async (input) => {
				// Liberal at the door regardless of format: `{ script: "..." }`
				// unwraps (the js input shape), a raw string IS the script, and
				// a `steps` object is the JSON plan.
				const script =
					input !== null &&
					typeof input === "object" &&
					typeof (input as { script?: unknown }).script === "string" &&
					!("steps" in input)
						? (input as { script: string }).script
						: input;
				let result: ExecuteResult;
				try {
					result = await run({ script }, scope);
				} catch (err) {
					// Rejected at the door: the issues go back for a retry,
					// anything else (a host bug) stays a real throw.
					if (!(err instanceof ScriptValidationError)) throw err;
					return {
						status: "invalid",
						issues: err.issues.map((i) => `${i.path}: ${i.message}`),
					};
				}
				switch (result.status) {
					case "ok":
						return {
							status: "ok",
							output: result.output,
							...(result.returnedAt !== undefined
								? { returnedAt: result.returnedAt }
								: {}),
						};
					case "error":
						return { status: "error", at: result.at, error: result.error };
					case "suspended":
						return { status: "suspended", suspensions: result.suspensions };
				}
			},
		};
		const search: AgentTool<AgentSearchInput, string> = {
			name: searchName,
			description:
				`Search the ${mounted.length} tools mounted on the script ` +
				"engine by keyword, against names, descriptions, and " +
				"signatures. Returns the matching signature cards - the " +
				`tools a \`${executeName}\` script can call.`,
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Keywords to match against tool names and descriptions.",
					},
					limit: {
						type: "integer",
						minimum: 1,
						description: "Maximum matches to return (default 10).",
					},
				},
				required: ["query"],
				additionalProperties: false,
			},
			execute: async ({ query, limit }) => {
				const matched = searchTools(mounted, query, limit ?? 10);
				if (matched.length === 0) {
					return (
						`no tools matched "${query}" (${mounted.length} mounted) - ` +
						"try broader keywords"
					);
				}
				return matched.map((tool) => toolCard(tool)).join("\n");
			},
		};
		return { execute, search };
	};

	/** The live prompt context: what THIS scope's expressions can read. */
	const context = (scope?: ScriptScope): string => {
		const entries: SessionEntry[] = [];
		if (scope) {
			const published = scope.state ? publishedVariables(scope.state) : {};
			for (const [name, value] of Object.entries(published)) {
				if (!(name in scope.vars)) {
					entries.push({ name, value, source: "step" });
				}
			}
			for (const [name, value] of Object.entries(scope.vars)) {
				entries.push({ name, value, source: "var" });
			}
		}
		return sessionCard(entries);
	};

	return {
		run,
		scope: createScope,
		session,
		describe,
		toolDefinition,
		agentTools,
		context,
		// Tolerant like compile: names no step produces are session
		// EXTERNALS, not authoring errors - the run checks them against the
		// live session it executes in.
		script: (input: unknown) => compileValidate(input).script,
		tool: compile as ScriptEngine<TS>["tool"],
		tools,
		validate,
		analyze: analyzeScript,
		render: renderScript,
		plan: planExecution,
	} as ScriptEngine<TS>;
};

/** Re-exported so tools can end or park a run without importing the
 * engine internals: `throw earlyReturn(value)` / `throw suspend({ key })`. */
export { earlyReturn, suspend } from "./execute";
