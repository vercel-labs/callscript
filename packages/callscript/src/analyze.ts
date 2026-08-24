/**
 * Script analysis: everything an authorizer (AI or human) needs to judge a
 * script before execution — the exact tool set, worst-case call counts,
 * reasons, and which steps may end the run early. For what a RE-execute
 * against a prior record will do (reuse vs re-run), see `planExecution`.
 */
import { collectArgRefs } from "./args";
import { collectRefs, parseExpr } from "./expr/parse";
import {
	type CallAnalysis,
	isCallStep,
	isReturnStep,
	type Script,
	type ScriptAnalysis,
	type Step,
} from "./types";
import { createWildcardMatcher } from "./wildcard";

export function analyzeScript(script: Script): ScriptAnalysis {
	const calls: CallAnalysis[] = [];
	const returns: string[] = [];
	const ids = new Set<string>();
	const refs = new Set<string>();

	const collect = (source: string | undefined) => {
		if (!source) return;
		try {
			for (const ref of collectRefs(parseExpr(source))) refs.add(ref);
		} catch {
			// malformed expressions are validateScript's problem, not analysis's
		}
	};

	const push = (step: Step) => {
		ids.add(step.id);
		collect(step.if);
		collect(step.return);
		if (step.return !== undefined) returns.push(step.id);
		if (isCallStep(step)) {
			collect(step.each);
			try {
				for (const ref of collectArgRefs(step.args)) refs.add(ref);
			} catch {}
			calls.push({
				stepId: step.id,
				tool: step.call,
				reason: step.reason,
				conditional: step.if !== undefined,
				// validateScript fills a missing max; the ?? 100 covers unvalidated scripts.
				maxCalls: step.each !== undefined ? (step.max ?? 100) : 1,
				returns: step.return !== undefined,
			});
		} else if (!isReturnStep(step)) {
			collect(step.let);
		}
	};
	for (const step of script.steps) push(step);
	collect(script.output);

	const external = [...refs].filter(
		(ref) =>
			!ids.has(ref) && ref !== "input" && ref !== "$calls" && ref !== "$errors",
	);

	const intent = script.intent ?? script.goal;
	return {
		intent,
		goal: intent,
		calls,
		tools: [...new Set(calls.map((c) => c.tool))],
		worstCaseCalls: calls.reduce((n, c) => n + c.maxCalls, 0),
		returns,
		external,
	};
}

/**
 * Loosely collect the unique tool names a raw `execute` input scripts to
 * call, including `parallel` branches. Unlike `analyzeScript`, this accepts
 * completely untrusted input and never throws — host-side approval gates
 * (an approval policy, a Slack card, ...) run BEFORE the engine
 * validates the script, so malformed shapes just contribute nothing.
 */
export function scriptedTools(input: unknown): string[] {
	const steps = (input as { steps?: unknown } | null | undefined)?.steps;
	if (!Array.isArray(steps)) return [];
	const names = new Set<string>();
	const visit = (step: unknown) => {
		if (typeof step !== "object" || step === null) return;
		const s = step as { call?: unknown; parallel?: unknown };
		if (typeof s.call === "string") names.add(s.call);
		if (Array.isArray(s.parallel)) s.parallel.forEach(visit);
	};
	steps.forEach(visit);
	return [...names];
}

/**
 * Does this raw `execute` input script to call any of the given tools?
 * Names ending in ".*" match any call under their prefix
 * (`scriptCalls(input, "github.*")`). The one-liner for host-side approval
 * gates:
 *
 *   approval: ({ toolInput }) =>
 *     scriptCalls(toolInput, "sendAlert", "refund") ? "user-approval" : "not-applicable"
 *
 * Same tolerance as `scriptedTools`: untrusted input, never throws,
 * malformed shapes are simply `false`.
 */
export function scriptCalls(input: unknown, ...tools: string[]): boolean {
	if (tools.length === 0) return false;
	const wanted = new Set(tools);
	const wildcardOf = createWildcardMatcher(wanted);
	return scriptedTools(input).some(
		(tool) => wanted.has(tool) || wildcardOf(tool) !== undefined,
	);
}

/**
 * Render a script as a human-readable summary — the text shown on approval
 * cards and given to an AI authorizer alongside the raw script JSON.
 */
export function renderScript(script: Script): string {
	const lines: string[] = [
		`Intent: ${script.intent ?? script.goal ?? "(none)"}`,
		"",
	];

	const renderStep = (step: Step, label: string) => {
		const cond = step.if ? ` (only if \`${step.if}\`)` : "";
		const ret =
			step.return !== undefined
				? ` [may END THE RUN here, if \`${step.return}\`]`
				: "";
		const order = step.after?.length ? ` (after ${step.after.join(", ")})` : "";
		if (isReturnStep(step)) {
			lines.push(`${label}. return early if \`${step.return}\`${cond}${order}`);
			return;
		}
		if (!isCallStep(step)) {
			lines.push(
				`${label}. derive \`${step.id}\` = \`${step.let}\`${cond}${ret}${order}`,
			);
			return;
		}
		const count = step.each !== undefined ? ` ×≤${step.max}` : "";
		lines.push(`${label}. [call${count}] ${step.call}${cond}${ret}${order}`);
		if (step.reason) lines.push(`   reason: ${step.reason}`);
	};

	script.steps.forEach((step, i) => {
		renderStep(step, String(i + 1));
	});

	const last = script.steps[script.steps.length - 1];
	if (last) {
		lines.push("", `Returns: the output of \`${last.id}\``);
	}
	return lines.join("\n");
}
