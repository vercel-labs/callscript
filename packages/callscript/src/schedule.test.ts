/**
 * The dependency scheduler: steps are authored in order but RUN by
 * dependency - data references (plus `after` edges) order, independent
 * steps overlap, a `return` gate fences. The old `parallel` group is
 * gone; these tests pin the semantics that replaced it.
 */
import { describe, expect, it } from "vitest";
import {
	type CallRequest,
	earlyReturn,
	executeScript,
	renderScript,
	type Script,
	ScriptValidationError,
	validateScript,
} from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("dependency scheduling", () => {
	it("independent steps overlap; a dependent step waits for its data", async () => {
		const script: Script = validateScript({
			intent: "overlap",
			steps: [
				{ id: "a", call: "slow", args: { n: 1 }, reason: "r" },
				{ id: "b", call: "slow", args: { n: 2 }, reason: "r" },
				{ id: "sum", let: "a + b" },
			],
		});
		let inFlight = 0;
		let maxInFlight = 0;
		const handlers = {
			call: async (req: CallRequest) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(20);
				inFlight--;
				return (req.args as { n: number }).n;
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(3);
		expect(maxInFlight).toBe(2);
	});

	it("dispatch is bounded by limits.maxConcurrency", async () => {
		const script: Script = validateScript({
			intent: "bounded",
			steps: [
				{ id: "a", call: "slow", reason: "r" },
				{ id: "b", call: "slow", reason: "r" },
				{ id: "c", call: "slow", reason: "r" },
				{ id: "out", let: "[a, b, c]" },
			],
		});
		let inFlight = 0;
		let maxInFlight = 0;
		const handlers = {
			call: async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await sleep(10);
				inFlight--;
				return "ok";
			},
		};
		const result = await executeScript(script, {
			handlers,
			limits: { maxConcurrency: 2 },
		});
		expect(result.status).toBe("ok");
		expect(maxInFlight).toBe(2);
	});

	it("`after` orders steps no expression connects", async () => {
		const script: Script = validateScript({
			intent: "effect ordering",
			steps: [
				{ id: "close", call: "svc.close", reason: "r" },
				{ id: "report", call: "svc.report", reason: "r", after: ["close"] },
			],
		});
		const order: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				order.push(`start:${req.stepId}`);
				await sleep(10);
				order.push(`end:${req.stepId}`);
				return "ok";
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("ok");
		expect(order).toEqual([
			"start:close",
			"end:close",
			"start:report",
			"end:report",
		]);
	});

	it("a return gate is a FENCE: everything before settles first, nothing after starts early", async () => {
		const make = () =>
			validateScript({
				intent: "gated",
				steps: [
					{ id: "a", call: "slow", reason: "r" },
					{ id: "gate", return: "input.stop && 'stopped'" },
					{ id: "b", call: "fast", reason: "r" },
				],
			});
		const order: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				order.push(`start:${req.stepId}`);
				if (req.tool === "slow") await sleep(15);
				order.push(`end:${req.stepId}`);
				return "ok";
			},
		};

		// Gate passes: b still waited for the fence, which waited for a.
		const open = await executeScript(make(), { handlers });
		expect(open.status).toBe("ok");
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);

		// Gate fires: the run ends at the fence; b never dispatches.
		order.length = 0;
		const stopped = await executeScript(make(), {
			handlers,
			input: { stop: true },
		});
		expect(stopped.status).toBe("ok");
		if (stopped.status !== "ok") return;
		expect(stopped.returnedAt).toBe("gate");
		expect(stopped.output).toBe("stopped");
		expect(order).toEqual(["start:a", "end:a"]);
	});

	it("an error stops new dispatches; in-flight steps finish and record", async () => {
		const script: Script = validateScript({
			intent: "halt",
			steps: [
				{ id: "a", call: "slow", reason: "r" },
				{ id: "boom", call: "fails", reason: "r" },
				{ id: "c", call: "fast", args: { v: "=a" }, reason: "r" },
			],
		});
		const called: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				called.push(req.stepId);
				if (req.tool === "fails") throw new Error("boom");
				if (req.tool === "slow") await sleep(15);
				return "ok";
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.at).toBe("boom");
		// The in-flight step finished and its fact recorded...
		expect(result.record.steps.a?.status).toBe("done");
		// ...but nothing new dispatched after the failure.
		expect(called).not.toContain("c");
		expect(result.record.steps.c).toBeUndefined();
	});

	it("an error beats a concurrent early return, deterministically in document order", async () => {
		const script: Script = validateScript({
			intent: "mixed",
			steps: [
				{ id: "boom", call: "fails", reason: "r" },
				{ id: "gated", call: "gated", reason: "r" },
				{ id: "out", let: "gated", if: "false" },
			],
		});
		const handlers = {
			call: async (req: CallRequest) => {
				if (req.tool === "fails") throw new Error("boom");
				throw earlyReturn({ gate: true });
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.at).toBe("boom");
	});

	it("a returned step parks the run; re-execute re-runs only unfinished steps", async () => {
		const script: Script = validateScript({
			intent: "two gates",
			steps: [
				{ id: "fast", call: "plain", reason: "r" },
				{ id: "g1", call: "gated", args: { k: "one" }, reason: "r" },
				{ id: "g2", call: "gated", args: { k: "two" }, reason: "r" },
				{ id: "all", let: "[fast, g1, g2]" },
			],
		});
		let granted = false;
		const calls: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				calls.push(req.stepId);
				if (req.tool === "plain") return "ok";
				const key = `gate:${(req.args as { k: string }).k}`;
				if (!granted) throw earlyReturn({ waitingOn: key });
				return key;
			},
		};

		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		// Deterministic: the FIRST returned step in document order wins.
		expect(first.returnedAt).toBe("g1");
		expect(first.output).toEqual({ waitingOn: "gate:one" });
		// Settled steps are kept; both gated steps are re-entry points.
		expect(first.record.steps.fast!.status).toBe("done");
		expect(first.record.steps.g1!.status).toBe("returned");
		expect(first.record.steps.g2!.status).toBe("returned");

		granted = true;
		const second = await executeScript(script, {
			handlers,
			state: first.record,
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.output).toEqual(["ok", "gate:one", "gate:two"]);
		// "fast" ran exactly once; only the gated steps re-dispatched.
		expect(calls.filter((c) => c === "fast")).toHaveLength(1);
	});

	it("a suspension parks the step and its dependents; independent steps finish", async () => {
		const script: Script = validateScript({
			intent: "partial park",
			steps: [
				{ id: "sus", call: "svc.act", reason: "r", suspend: true },
				{ id: "other", call: "plain", reason: "r" },
				{ id: "dep", let: "sus + '!'" },
			],
		});
		const handlers = {
			call: async (req: CallRequest) =>
				req.tool === "plain" ? "done" : "acted",
		};

		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("suspended");
		if (first.status !== "suspended") return;
		expect(first.suspensions[0]!.key).toBe("sus");
		// The independent step finished; the dependent never dispatched.
		expect(first.record.steps.other?.status).toBe("done");
		expect(first.record.steps.dep).toBeUndefined();

		const second = await executeScript(script, {
			handlers,
			state: first.record,
			resolutions: { sus: true },
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.output).toBe("acted!");
	});

	it("onError skip records the error and the script continues", async () => {
		const script: Script = validateScript({
			intent: "tolerant",
			steps: [
				{ id: "a", call: "fails", onError: "skip", reason: "r" },
				{ id: "b", call: "plain", reason: "r" },
				{ id: "out", let: "[a ?? 'failed', b]" },
			],
		});
		const handlers = {
			call: async (req: CallRequest) => {
				if (req.tool === "fails") throw new Error("nope");
				return "ok";
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toEqual(["failed", "ok"]);
		expect(result.record.steps.a!.error?.message).toBe("nope");
	});
});

describe("schedule validation & analysis", () => {
	it("concurrent each steps count toward worst-case totals", () => {
		const make = () =>
			validateScript(
				{
					intent: "big",
					steps: [
						{
							id: "a",
							call: "t",
							each: "[1,2].map(i => ({ i }))",
							max: 60,
							reason: "r",
						},
						{
							id: "b",
							call: "t",
							each: "[1,2].map(j => ({ j }))",
							max: 60,
							reason: "r",
						},
						{ id: "out", let: "a" },
					],
				},
				{ maxTotalCalls: 100 },
			);
		expect(make).toThrow(ScriptValidationError);
		expect(make).toThrow(/Worst-case total calls \(120\)/);
	});

	it("renderScript shows fan-out bounds and after edges", () => {
		const script = validateScript({
			intent: "fan out",
			steps: [
				{ id: "xs", let: "[1, 2]" },
				{
					id: "a",
					call: "t1",
					each: "xs.map(i => ({ i }))",
					max: 10,
					reason: "ra",
				},
				{ id: "b", call: "t2", reason: "rb", after: ["a"] },
			],
		});
		const rendered = renderScript(script);
		expect(rendered).toContain("[call ×≤10] t1");
		expect(rendered).toContain("[call] t2 (after a)");
	});
});
