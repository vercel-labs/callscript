import { collectArgExprs, collectArgRefs } from "./args";
import {
	collectRefs,
	ExprError,
	errorSelectors,
	GLOBAL_NAMES,
	parseExpr,
} from "./expr/parse";
import { parseJsScript } from "./js";
import { scriptShellSchema, stepSchema } from "./schema";
import {
	DEFAULT_LIMITS,
	isCallStep,
	isReturnStep,
	type Script,
	type ScriptLimits,
	type Step,
} from "./types";
import { createWildcardMatcher, isInternalName } from "./wildcard";

/** Names the engine binds; step ids and forEach vars must not shadow them. */
const RESERVED_NAMES = new Set(["input"]);

export interface ScriptIssue {
	path: string;
	message: string;
}

export class ScriptValidationError extends Error {
	readonly issues: ScriptIssue[];

	constructor(issues: ScriptIssue[]) {
		super(
			`Invalid script:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`,
		);
		this.name = "ScriptValidationError";
		this.issues = issues;
	}
}

export type ValidateOptions = Partial<ScriptLimits> & {
	/**
	 * The tool names this host can execute. When provided, every `call` must
	 * name one of them - unknown names fail validation with the full list of
	 * offenders. Names ending in ".*" are prefix patterns: a call matches by
	 * naming a listed tool exactly, or by falling under a pattern's prefix
	 * ("github.close" matches "github.*"). Internal "$"-segment names never
	 * match a pattern, and a call may never contain "*" itself.
	 * Default: any non-empty string is accepted.
	 */
	tools?: Iterable<string>;
	/** Message shown when a `call` names an unknown tool. */
	unknownToolHint?: string;
	/**
	 * When true, every call step must carry a non-empty `reason`.
	 * Default: false - reasons are optional.
	 */
	requireReason?: boolean;
	/**
	 * Session variable names expressions may reference WITHOUT a producing
	 * step - the static twin of `ExecuteOptions.variables`. A step id may
	 * reuse a variable name (the run overwrites it, JS `let`-style); the old
	 * value is then unreadable in this script, since the name refers to the
	 * new step and forward references stay illegal.
	 */
	variables?: Iterable<string>;
	/** @deprecated Alias of {@link ValidateOptions.variables}. */
	bindings?: Iterable<string>;
};

export type ScriptValidator = (
	input: unknown,
	overrides?: ValidateOptions,
) => Script;

/**
 * Create a validator with baked-in defaults (limits, tools, requireReason).
 * Per-call overrides shallow-merge over the defaults.
 *
 * ```ts
 * const validate = createScriptValidator({ tools: registry.names, requireReason: true })
 * const script = validate(input)
 * ```
 */
export function createScriptValidator(
	defaults: ValidateOptions = {},
): ScriptValidator {
	return (input, overrides) =>
		validateScript(input, { ...defaults, ...overrides });
}

/** The call-only fields - naming one without `call` gets a pointed message. */
const CALL_ONLY_FIELDS = [
	"args",
	"each",
	"max",
	"reason",
	"onError",
	"suspend",
	"await",
] as const;

/**
 * Validate a script. Returns the typed script or throws `ScriptValidationError`
 * with every issue found
 */
export function validateScript(
	input: unknown,
	options: ValidateOptions = {},
): Script {
	// A string is the JS surface: compiled (never executed) into the same
	// Script shape, then validated like any other input. parseJsScript
	// throws the same ScriptValidationError, issues located by line.
	if (typeof input === "string") {
		input = parseJsScript(input, { tools: options.tools });
	}
	const lim: ScriptLimits = { ...DEFAULT_LIMITS, ...options };
	const knownTools = options.tools ? new Set(options.tools) : undefined;
	const wildcardOf = knownTools ? createWildcardMatcher(knownTools) : undefined;
	const issues: ScriptIssue[] = [];

	// Shell first, then each step against the ONE step schema plus the verb
	// checks zod cannot phrase - so every error names the field to fix.
	const shell = scriptShellSchema.safeParse(input);
	if (!shell.success) {
		throw new ScriptValidationError(
			shell.error.issues.map((i) => ({
				path: i.path.join(".") || "(root)",
				message: i.message,
			})),
		);
	}
	const stepIssues: ScriptIssue[] = [];
	const parseStep = (
		raw: Record<string, unknown>,
		path: string,
	): Step | undefined => {
		if ("parallel" in raw) {
			stepIssues.push({
				path,
				message:
					'"parallel" is gone - steps run concurrently on their own whenever no data flows between them; just write the steps (use "after" to force ordering)',
			});
			return undefined;
		}
		if (!("call" in raw) && !("let" in raw) && !("return" in raw)) {
			stepIssues.push({
				path,
				message:
					'Every step needs "call" (invoke a tool), "let" (pure derivation), or "return" (end the run early)',
			});
			return undefined;
		}
		const parsed = stepSchema.safeParse(raw);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				stepIssues.push({
					path: `${path}.${issue.path.join(".")}`,
					message: issue.message,
				});
			}
			return undefined;
		}
		const step = parsed.data as Step;
		let bad = false;
		if ("call" in step && "let" in step) {
			stepIssues.push({
				path,
				message:
					'"call" and "let" cannot share a step - split them into two steps',
			});
			bad = true;
		}
		if (!isCallStep(step)) {
			for (const field of CALL_ONLY_FIELDS) {
				if (field in step) {
					stepIssues.push({
						path: `${path}.${field}`,
						message: `"${field}" only makes sense on a "call" step`,
					});
					bad = true;
				}
			}
		} else if (step.each !== undefined && step.args !== undefined) {
			stepIssues.push({
				path: `${path}.args`,
				message:
					'"each" yields every call\'s args - drop "args" and compute the full args list in the "each" expression',
			});
			bad = true;
		} else if (step.max !== undefined && step.each === undefined) {
			stepIssues.push({
				path: `${path}.max`,
				message: '"max" bounds an "each" fan-out - this step has no "each"',
			});
			bad = true;
		}
		return bad ? undefined : step;
	};
	const parsedSteps: Script["steps"] = [];
	shell.data.steps.forEach((raw, index) => {
		const step = parseStep(raw, `steps[${index}]`);
		if (step) parsedSteps.push(step);
	});
	if (stepIssues.length > 0) throw new ScriptValidationError(stepIssues);
	const script = { ...shell.data, steps: parsedSteps } as Script;

	// Normalize the frictionless single-step form: auto-assign missing step
	// ids (s1, s2, ...) and derive a missing intent from the first call's
	// reason - a one-call script needs nothing beyond { call, args, reason }.
	{
		const taken = new Set<string>();
		for (const step of script.steps) if (step.id) taken.add(step.id);
		script.steps.forEach((step, index) => {
			if (step.id) return;
			// Positional so references are guessable; suffix on collision.
			let candidate = `s${index + 1}`;
			while (taken.has(candidate)) candidate = `${candidate}_`;
			step.id = candidate;
			taken.add(candidate);
		});
		// `goal` is the deprecated spelling of `intent` - normalize, keep both
		// readable (analyzeScript mirrors them the same way).
		if (!script.intent && script.goal) script.intent = script.goal;
		if (!script.intent) {
			const firstCall = script.steps.find(isCallStep);
			script.intent = firstCall?.reason ?? `Run ${script.steps.length} step(s)`;
		}
		// Models habitually carry the args "=expr" marker onto the fields
		// that are ALWAYS expressions - forgive a leading "=" there instead
		// of failing a whole round trip on it.
		const stripMarker = (expr: string) =>
			expr.startsWith("=") ? expr.slice(1) : expr;
		if (script.output !== undefined) script.output = stripMarker(script.output);
		for (const step of script.steps) {
			if (step.if) step.if = stripMarker(step.if);
			if (step.return !== undefined) step.return = stripMarker(step.return);
			if (isCallStep(step)) {
				if (step.each !== undefined) {
					step.each = stripMarker(step.each);
					// The static bound always exists - when the script doesn't
					// declare one, it's the per-step limit. Agents shouldn't
					// have to guess a number to satisfy the analyzer.
					step.max ??= lim.maxItemsPerStep;
				}
			} else if (!isReturnStep(step)) {
				step.let = stripMarker(step.let);
			}
		}
	}

	if (script.steps.length > lim.maxSteps) {
		issues.push({
			path: "steps",
			message: `Too many steps (${script.steps.length} > ${lim.maxSteps})`,
		});
	}

	// `taken` guards id uniqueness (including group ids); `referable` is what
	// expressions may reference - group ids are structural and excluded.
	// `input` (per-execute data) is referable from the start, as are session
	// variables — except ones a step id in THIS script reuses: the name then
	// refers to the new step, so the old value is unreadable here (and
	// referencing it before that step gets the backward-only error).
	const declaredIds = new Set<string>();
	for (const step of script.steps) {
		declaredIds.add(step.id);
	}
	const taken = new Set<string>();
	const referable = new Set<string>(RESERVED_NAMES);
	/** Steps whose FAILURE is readable so far: earlier call steps that
	 * declared `onError: "skip"` (anything else fails the whole run, so
	 * its `$errors.<id>` could never be set). */
	const errorReadable = new Set<string>();
	/** Step ids processed so far - "is it earlier" for pointed messages. */
	const seenIds = new Set<string>();
	/** Not-awaited step ids ("await": false): never referable within this script. */
	const unawaitedIds = new Set<string>();
	for (const name of [
		...(options.variables ?? []),
		...(options.bindings ?? []),
	]) {
		if (
			!declaredIds.has(name) &&
			!GLOBAL_NAMES.has(name) &&
			!RESERVED_NAMES.has(name)
		) {
			referable.add(name);
		}
	}
	let worstCaseCalls = 0;

	const checkId = (id: string, at: string) => {
		if (GLOBAL_NAMES.has(id)) {
			issues.push({
				path: `${at}.id`,
				message: `"${id}" collides with a builtin global`,
			});
		}
		if (RESERVED_NAMES.has(id)) {
			issues.push({
				path: `${at}.id`,
				message: `"${id}" is reserved (per-execute data binding)`,
			});
		}
		if (taken.has(id)) {
			issues.push({ path: `${at}.id`, message: `Duplicate step id "${id}"` });
		}
		taken.add(id);
	};

	const checkStep = (step: Step, at: string, available: Set<string>) => {
		const checkExpr = (
			source: string,
			path: string,
			extraBindings: string[] = [],
		) => {
			try {
				const ast = parseExpr(source);
				const bound = new Set(extraBindings);
				for (const ref of collectRefs(ast)) {
					if (ref === "$errors") continue; // selections checked below
					if (!available.has(ref) && !bound.has(ref)) {
						issues.push({
							path,
							message: unawaitedIds.has(ref)
								? `"${ref}" is not awaited ("await": false) - its value is not available in this script. Join it from a LATER script with an "await.${ref}" call, or await it here by dropping the flag`
								: ref === "$calls"
									? `"$calls" is only available in a call step's "return" expression`
									: `Unknown reference "${ref}" (steps may only reference earlier steps)`,
						});
					}
				}
				checkErrorReads(ast, path);
			} catch (err) {
				issues.push({
					path,
					message: err instanceof ExprError ? err.message : String(err),
				});
			}
		};

		if (step.if) checkExpr(step.if, `${at}.if`);
		// A `return` gate is evaluated once, BEFORE the step's action - on a
		// call step it may preview the resolved calls via `$calls`.
		if (step.return !== undefined) {
			checkExpr(
				step.return,
				`${at}.return`,
				isCallStep(step) ? ["$calls"] : [],
			);
		}
		// `after` edges are pure ordering: they must name EARLIER step ids
		// (a variable carries no schedule; a forward edge is a forward ref).
		if (step.after !== undefined) {
			for (const dep of step.after) {
				if (available.has(dep) && declaredIds.has(dep)) continue;
				issues.push({
					path: `${at}.after`,
					message: unawaitedIds.has(dep)
						? `"${dep}" is not awaited ("await": false) - it cannot order steps in this script`
						: declaredIds.has(dep)
							? `"after" may only name EARLIER steps - "${dep}" comes later`
							: `"after" names an unknown step "${dep}" (it takes step ids, nothing else)`,
				});
			}
		}

		if (isCallStep(step)) {
			if (options.requireReason && !step.reason) {
				issues.push({
					path: `${at}.reason`,
					message: "reason is required for every call",
				});
			}
			if (knownTools) {
				// Exact names win; a pattern covers any non-internal name under its
				// prefix. A call may never contain "*" (patterns aren't callable),
				// and "$"-segment names stay reachable only via transformScript.
				const known =
					(!step.call.includes("*") && knownTools.has(step.call)) ||
					(!isInternalName(step.call) && wildcardOf!(step.call) !== undefined);
				if (!known) {
					issues.push({
						path: `${at}.call`,
						message: `Unknown tool "${step.call}"${options.unknownToolHint ? ` - ${options.unknownToolHint}` : ""}`,
					});
				}
			}

			if (step.each !== undefined) {
				// Normalization filled a missing max with the limit.
				const max = step.max ?? lim.maxItemsPerStep;
				if (max > lim.maxItemsPerStep) {
					issues.push({
						path: `${at}.max`,
						message: `max ${max} exceeds the limit of ${lim.maxItemsPerStep}`,
					});
				}
				checkExpr(step.each, `${at}.each`);
				worstCaseCalls += max;
			} else {
				worstCaseCalls += 1;
			}

			if (step.args !== undefined) {
				// Parse every embedded expression.
				try {
					for (const src of collectArgExprs(step.args)) {
						checkExpr(src, `${at}.args`);
					}
				} catch (err) {
					issues.push({
						path: `${at}.args`,
						message: err instanceof ExprError ? err.message : String(err),
					});
				}
				// collectArgRefs double-checks nothing slipped through unparsed.
				void collectArgRefs;
			}
		} else if (!isReturnStep(step)) {
			checkExpr(step.let, `${at}.let`);
		}
	};

	/** The `$errors.<id>` rules: a literal id, naming an EARLIER call step
	 * that declared `onError: "skip"` - each violation gets the message
	 * that names the fix. */
	const checkErrorReads = (ast: ReturnType<typeof parseExpr>, path: string) => {
		const { names, dynamic } = errorSelectors(ast);
		if (dynamic) {
			issues.push({
				path,
				message:
					'"$errors" is read per step, with a literal id ("$errors.close") - the schedule needs the dependency to be static',
			});
		}
		for (const name of names) {
			if (errorReadable.has(name)) continue;
			issues.push({
				path,
				message: !declaredIds.has(name)
					? `"$errors.${name}" names an unknown step`
					: !seenIds.has(name)
						? `"$errors.${name}" reads an EARLIER step's failure - "${name}" comes later`
						: unawaitedIds.has(name)
							? `"${name}" is not awaited ("await": false) - its failure is not available in this script`
							: `"$errors.${name}" is only set when step "${name}" declares "onError": "skip" - without it a failure fails the whole run and nothing after it runs`,
			});
		}
	};

	script.steps.forEach((step, index) => {
		const at = `steps[${index}]`;
		checkId(step.id, at);
		const available = new Set(referable);
		checkStep(step, at, available);
		seenIds.add(step.id);
		// A not-awaited step's value never lands in THIS script's scope - later
		// steps reference it only in future scripts (await.<id> / variables).
		if (isCallStep(step) && step.await === false) unawaitedIds.add(step.id);
		else {
			referable.add(step.id);
			if (isCallStep(step) && step.onError === "skip")
				errorReadable.add(step.id);
		}
	});

	// The output projection reads any settled step. Unawaited ids are
	// excluded from `referable`, so referencing one from `output` errors
	// with the pointed message below.
	if (script.output !== undefined) {
		try {
			const ast = parseExpr(script.output);
			checkErrorReads(ast, "output");
			for (const ref of collectRefs(ast)) {
				if (ref === "$errors") continue; // selections checked above
				if (!referable.has(ref)) {
					issues.push({
						path: "output",
						message: unawaitedIds.has(ref)
							? `"${ref}" is not awaited ("await": false) - its value is not available as this run's output`
							: `Unknown reference "${ref}"`,
					});
				}
			}
		} catch (err) {
			issues.push({
				path: "output",
				message: err instanceof ExprError ? err.message : String(err),
			});
		}
	}

	const last = script.steps[script.steps.length - 1];
	if (
		last &&
		isCallStep(last) &&
		last.await === false &&
		script.output === undefined
	) {
		issues.push({
			path: "steps",
			message:
				"The last step is not awaited, so it cannot be the run's output - end with a step " +
				'producing what you need NOW, or set "await": false on the whole script instead.',
		});
	}
	if (unawaitedIds.size > 0 && unawaitedIds.size === script.steps.length) {
		issues.push({
			path: "steps",
			message:
				'No step is awaited - drop the per-step flags and set "await": false on the whole script instead.',
		});
	}

	if (worstCaseCalls > lim.maxTotalCalls) {
		issues.push({
			path: "steps",
			message: `Worst-case total calls (${worstCaseCalls}) exceeds the limit of ${lim.maxTotalCalls}`,
		});
	}

	if (issues.length > 0) throw new ScriptValidationError(issues);
	return script;
}
