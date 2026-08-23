import { describe, expect, it, vi } from "vitest";
import {
	analyzeScript,
	type CallRequest,
	publishedVariables,
	validateScript,
} from "./index";
import { executeScript } from "./execute";

describe("session variables", () => {
	it("binds variables in every expression, read-only", async () => {
		const script = validateScript(
			{
				intent: "recompute",
				steps: [{ id: "titles", let: "stale.map(i => i.title)" }],
			},
			{ variables: ["stale"] },
		);
		const result = await executeScript(script, {
			handlers: { call: async () => null },
			variables: { stale: [{ title: "a" }, { title: "b" }] },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toEqual(["a", "b"]);
	});

	it("a step id reusing a variable name owns it: the old value is unreadable", async () => {
		// Validation: referencing the name BEFORE the step that redeclares it is
		// a forward reference, not a variable read.
		expect(() =>
			validateScript(
				{
					intent: "shadow",
					steps: [
						{ id: "early", let: "stale.length" },
						{ id: "stale", let: "[1, 2, 3]" },
					],
				},
				{ variables: ["stale"] },
			),
		).toThrowError(/Unknown reference "stale"/);

		// Execution: the variable is never bound; the new step's value wins.
		const script = validateScript(
			{
				intent: "shadow",
				steps: [
					{ id: "stale", let: "[1, 2, 3]" },
					{ id: "n", let: "stale.length" },
				],
			},
			{ variables: ["stale"] },
		);
		const result = await executeScript(script, {
			handlers: { call: async () => null },
			variables: { stale: ["old", "old", "old", "old"] },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(3);
	});

	it("rejects references to variables the host did not declare", () => {
		expect(() =>
			validateScript(
				{ intent: "unknown", steps: [{ id: "x", let: "stale.length" }] },
				{ variables: ["issues"] },
			),
		).toThrowError(/Unknown reference "stale"/);
	});

	it("variable names never mask globals or the reserved input", async () => {
		const script = validateScript(
			{
				intent: "globals win",
				steps: [{ id: "x", let: "Math.max(1, 2) + (input.n ?? 0)" }],
			},
			{ variables: ["Math", "input"] },
		);
		const result = await executeScript(script, {
			handlers: { call: async () => null },
			variables: { Math: "not math", input: "not input" },
			input: { n: 40 },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(42);
	});

	it("publishedVariables publishes done steps only - never skipped, failed, or returned ones", async () => {
		const script = validateScript({
			intent: "publish rules",
			steps: [
				{ id: "kept", let: "[1, 2]" },
				{ id: "skipped", if: "false", call: "svc.op", reason: "r" },
				{ id: "gate", return: "input.stop && { stopped: true }" },
				{ id: "boom", call: "svc.fail", reason: "r" },
			],
		});
		const handlers = {
			call: vi.fn(async (req: CallRequest) => {
				if (req.tool === "svc.fail") throw new Error("nope");
				return "ok";
			}),
		};
		const failed = await executeScript(script, {
			handlers,
			retainOutputs: "all",
		});
		expect(failed.status).toBe("error");
		// The failed run still publishes its settled facts - and nothing else.
		expect(publishedVariables(failed.record)).toEqual({ kept: [1, 2] });

		const returned = await executeScript(script, {
			handlers,
			input: { stop: true },
			retainOutputs: "all",
		});
		expect(returned.status).toBe("ok");
		if (returned.status !== "ok") return;
		expect(returned.returnedAt).toBe("gate");
		expect(publishedVariables(returned.record)).toEqual({ kept: [1, 2] });
	});

	it("released outputs are not published (retain 'all' when a session wants them)", async () => {
		const script = validateScript({
			intent: "release",
			steps: [
				{ id: "big", call: "svc.rows", reason: "r" },
				{ id: "n", let: "big.length" },
				{ id: "out", let: "n * 10" },
			],
		});
		const handlers = { call: async () => [1, 2, 3] };

		const live = await executeScript(script, { handlers });
		expect(live.status).toBe("ok");
		// big was released once `n` (its last reader) settled.
		expect(Object.keys(publishedVariables(live.record)).sort()).toEqual([
			"n",
			"out",
		]);

		const all = await executeScript(script, { handlers, retainOutputs: "all" });
		expect(Object.keys(publishedVariables(all.record)).sort()).toEqual([
			"big",
			"n",
			"out",
		]);
	});

	it("the record is the session: entries accumulate and bind as variables", async () => {
		const handlers = {
			call: async (req: CallRequest) =>
				req.tool === "svc.fetch" ? [1, 2, 3] : "ok",
		};

		const runA = await executeScript(
			validateScript({
				intent: "a",
				steps: [{ id: "issues", call: "svc.fetch", reason: "r" }],
			}),
			{ handlers, retainOutputs: "all" },
		);
		expect(runA.status).toBe("ok");

		// Run B declares nothing named "issues" - the entry carries forward and
		// binds as a variable, no re-fetch, validated via the variables option.
		const scriptB = validateScript(
			{ intent: "b", steps: [{ id: "count", let: "issues.length" }] },
			{ variables: Object.keys(publishedVariables(runA.record)) },
		);
		const runB = await executeScript(scriptB, {
			handlers,
			state: runA.record,
			retainOutputs: "all",
		});
		expect(runB.status).toBe("ok");
		if (runB.status !== "ok") return;
		expect(runB.output).toBe(3);
		// Both runs' facts live in ONE record now.
		expect(Object.keys(publishedVariables(runB.record)).sort()).toEqual([
			"count",
			"issues",
		]);

		// Run C redeclares "issues": the step owns the name and overwrites it.
		const scriptC = validateScript({
			intent: "c",
			steps: [
				{ id: "issues", let: "['fresh']" },
				{ id: "n", let: "issues.length" },
			],
		});
		const runC = await executeScript(scriptC, {
			handlers,
			state: runB.record,
			retainOutputs: "all",
		});
		expect(runC.status).toBe("ok");
		if (runC.status !== "ok") return;
		expect(runC.output).toBe(1);
		expect(publishedVariables(runC.record).issues).toEqual(["fresh"]);
		expect(publishedVariables(runC.record).count).toBe(3); // untouched entries persist
	});

	it("analyzeScript reports the external names a script expects", () => {
		const script = validateScript(
			{
				intent: "external",
				steps: [
					{
						id: "fresh",
						call: "svc.op",
						args: { from: "=stale[0].id", code: "=input.code" },
						reason: "r",
					},
					{ id: "both", let: "fresh + prior.length" },
				],
			},
			{ variables: ["stale", "prior"] },
		);
		expect(analyzeScript(script).external.sort()).toEqual(["prior", "stale"]);
	});
});
