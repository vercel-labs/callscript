import { describe, expect, it, vi } from "vitest";
import {
	type CallRequest,
	createRunner,
	publishedVariables,
	type Script,
	type ScriptRunner,
	validateScript,
} from "./index";

/** Published variables of the runner's session record ({} before any run). */
function sessionVars(runner: ScriptRunner): Record<string, unknown> {
	const session = runner.session();
	return session ? publishedVariables(session) : {};
}

/** A tool whose promise the test resolves by hand - the "slow remote job". */
function deferredTool() {
	let release: (value: unknown) => void = () => {};
	let fail: (err: unknown) => void = () => {};
	const gate = new Promise((resolve, reject) => {
		release = resolve;
		fail = reject;
	});
	return { gate, release, fail };
}

const TOOLS = ["svc.fast", "svc.slow", "await.*"];

const script = (input: unknown): Script =>
	validateScript(input, { tools: TOOLS });

function makeRunner(
	slow: () => Promise<unknown>,
	overrides: Partial<Parameters<typeof createRunner>[0]> = {},
) {
	const calls: CallRequest[] = [];
	const runner = createRunner({
		handlers: {
			call: async (req) => {
				calls.push(req);
				if (req.tool === "svc.slow") return slow();
				return { fast: true, args: req.args };
			},
		},
		deadlineMs: 25,
		...overrides,
	});
	return { runner, calls };
}

describe("runner: fast lane and detachment", () => {
	it("a non-async run blocks to completion and announces nothing", async () => {
		const { runner } = makeRunner(async () => "slow");
		const result = await runner.start(
			script({ steps: [{ id: "a", let: "1 + 1" }] }),
		);
		expect(result).toMatchObject({ runId: "r1", status: "done", output: 2 });
		expect(runner.digest()).toEqual({}); // the caller already holds the result
	});

	it("an async run that beats the deadline returns its result inline", async () => {
		const { runner } = makeRunner(async () => "quick");
		const result = await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		expect(result).toMatchObject({
			runId: "job",
			status: "done",
			output: "quick",
		});
		expect(runner.digest()).toEqual({});
	});

	it("an async run that outlives the deadline detaches and settles into the digest once", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate);
		const settled = vi.fn();
		runner.onRunSettled(settled);

		const result = await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		expect(result).toEqual({ runId: "job", status: "pending" });
		expect(runner.digest()).toEqual({ job: { status: "pending" } });
		expect(settled).not.toHaveBeenCalled();

		release("finally");
		await runner.result("job");
		expect(settled).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "job",
				status: "done",
				output: "finally",
			}),
		);
		// Announce-once: first digest carries it, the next doesn't - but the
		// value stays readable.
		expect(runner.digest()).toEqual({
			job: { status: "done", output: "finally" },
		});
		expect(runner.digest()).toEqual({});
		expect((await runner.result("job")).output).toBe("finally");
	});

	it("agent-named ids are idempotent while pending; a different script under the id is rejected", async () => {
		const { gate, release } = deferredTool();
		const { runner, calls } = makeRunner(() => gate);
		const src = {
			id: "job",
			await: false,
			steps: [{ call: "svc.slow", reason: "r" }],
		};

		expect(await runner.start(script(src))).toEqual({
			runId: "job",
			status: "pending",
		});
		expect(await runner.start(script(src))).toEqual({
			runId: "job",
			status: "pending",
		});
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1); // one run, not two

		await expect(
			runner.start(
				script({ id: "job", await: false, steps: [{ id: "x", let: "1" }] }),
			),
		).rejects.toMatchObject({ code: "run_id_in_use" });
		release("ok");
	});
});

describe("runner: await joins", () => {
	it("await.<id> blocks on a pending run and yields its output", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate);
		await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);

		const joinPromise = runner.start(
			script({
				steps: [
					{ id: "value", call: "await.job", reason: "collect" },
					{ id: "out", let: "'got ' + value" },
				],
			}),
		);
		release("payload");
		expect(await joinPromise).toMatchObject({
			status: "done",
			output: "got payload",
		});
	});

	it("await.<id>.<stepId> reads one step's output from the settled record", async () => {
		const { runner } = makeRunner(async () => ["a", "b"]);
		await runner.start(
			script({
				id: "job",
				steps: [
					{ id: "rows", call: "svc.slow", reason: "r" },
					{ id: "n", let: "rows.length" },
				],
			}),
		);
		const result = await runner.start(
			script({
				steps: [{ id: "rows2", call: "await.job.rows", reason: "read" }],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: ["a", "b"] });
	});

	it("awaiting an unknown run fails the step with a pointed code (onError applies)", async () => {
		const { runner } = makeRunner(async () => "x");
		const failed = await runner.start(
			script({ steps: [{ id: "v", call: "await.ghost", reason: "r" }] }),
		);
		expect(failed).toMatchObject({
			status: "error",
			error: { code: "unknown_run" },
		});

		const skipped = await runner.start(
			script({
				steps: [
					{ id: "v", call: "await.ghost", reason: "r", onError: "skip" },
					{ id: "out", let: "v ?? 'fallback'" },
				],
			}),
		);
		expect(skipped).toMatchObject({ status: "done", output: "fallback" });
	});

	it("an awaited run that failed propagates as awaited_run_failed", async () => {
		const { runner } = makeRunner(async () => {
			throw new Error("boom");
		});
		await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		await runner.result("job");
		const result = await runner.start(
			script({ steps: [{ id: "v", call: "await.job", reason: "r" }] }),
		);
		expect(result).toMatchObject({
			status: "error",
			error: { code: "awaited_run_failed" },
		});
	});

	it("mutual awaits deadlock-check instead of hanging", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate);
		// a: blocked on the slow tool, THEN awaits b - while b awaits a.
		// (the ordering is explicit: steps run by dependency, not position)
		const a = runner.start(
			script({
				id: "a",
				await: false,
				steps: [
					{ id: "slow", call: "svc.slow", reason: "r" },
					{ id: "join", call: "await.b", reason: "r", after: ["slow"] },
				],
			}),
		);
		const b = runner.start(
			script({
				id: "b",
				await: false,
				steps: [{ id: "join", call: "await.a", reason: "r" }],
			}),
		);
		await Promise.all([a, b]);
		release("go");
		const [ra, rb] = await Promise.all([
			runner.result("a"),
			runner.result("b"),
		]);
		const failed = [ra, rb].filter((r) => r.error?.code === "await_cycle");
		expect(failed.length).toBeGreaterThanOrEqual(1); // at least one side detects the cycle
	});
});

describe("runner: session accumulation", () => {
	it("settled runs publish variables later scripts reference directly", async () => {
		const { runner } = makeRunner(async () => [1, 2, 3]);
		await runner.start(
			script({ steps: [{ id: "issues", call: "svc.slow", reason: "r" }] }),
		);
		expect(sessionVars(runner)).toMatchObject({ issues: [1, 2, 3] });

		const next = await runner.start(
			validateScript(
				{ steps: [{ id: "count", let: "issues.length" }] },
				{ tools: TOOLS, variables: ["issues"] },
			),
		);
		expect(next).toMatchObject({ status: "done", output: 3 });
	});

	it("concurrent async runs merge without clobbering each other", async () => {
		const first = deferredTool();
		const second = deferredTool();
		const gates = [first.gate, second.gate];
		const { runner } = makeRunner(
			() => gates.shift() ?? Promise.resolve("exhausted"),
		);

		await runner.start(
			script({
				id: "a",
				await: false,
				steps: [{ id: "fromA", call: "svc.slow", reason: "r" }],
			}),
		);
		await runner.start(
			script({
				id: "b",
				await: false,
				steps: [{ id: "fromB", call: "svc.slow", reason: "r" }],
			}),
		);
		first.release("A");
		await runner.result("a");
		second.release("B");
		await runner.result("b");
		// b forked before a settled - a's contribution must survive b's merge.
		expect(sessionVars(runner)).toMatchObject({ fromA: "A", fromB: "B" });
	});

	it("a returned async run settles as 'returned'; restarting the same id with input continues it", async () => {
		const { runner, calls } = makeRunner(async () => "sent");
		const src = {
			id: "job",
			await: false,
			steps: [
				{ id: "gate", return: "!input.approved && { confirm: true }" },
				{ id: "send", call: "svc.slow", reason: "r" },
			],
		};
		const firstRun = await runner.start(script(src));
		expect(firstRun).toMatchObject({
			status: "done",
			returnedAt: "gate",
			output: { confirm: true },
		});
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(0);

		const secondRun = await runner.start(script(src), {
			input: { approved: true },
		});
		expect(secondRun).toMatchObject({ status: "done", output: "sent" });
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1);
	});
});

describe("runner: cancellation and digest bounds", () => {
	it("cancel discards the settlement: digest announces cancelled, awaiters reject", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate);
		await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		expect(runner.cancel("job")).toBe(true);
		expect(runner.digest()).toEqual({ job: { status: "cancelled" } });

		release("too late");
		const joined = await runner.start(
			script({ steps: [{ id: "v", call: "await.job", reason: "r" }] }),
		);
		expect(joined).toMatchObject({
			status: "error",
			error: { code: "run_cancelled" },
		});
		// The cancelled run's settlement was discarded - nothing it produced published.
		expect(sessionVars(runner)).toEqual({});
	});

	it("acknowledge suppresses the digest announcement but never consumes the value", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate);
		await runner.start(
			script({
				id: "job",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		release("delivered by push");
		await runner.result("job");
		// The host pushed the settlement into the conversation itself...
		runner.acknowledge("job");
		// ...so the digest stays silent - but the value remains readable.
		expect(runner.digest()).toEqual({});
		expect((await runner.result("job")).output).toBe("delivered by push");
		const joined = await runner.start(
			script({
				steps: [{ id: "v", call: "await.job", reason: "still joinable" }],
			}),
		);
		expect(joined).toMatchObject({
			status: "done",
			output: "delivered by push",
		});
	});

	it("oversized outputs are omitted from the digest but stay awaitable", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate, { maxDigestOutputBytes: 16 });
		await runner.start(
			script({
				id: "big",
				await: false,
				steps: [{ call: "svc.slow", reason: "r" }],
			}),
		);
		release("x".repeat(100));
		await runner.result("big");
		expect(runner.digest()).toEqual({
			big: { status: "done", outputOmitted: true },
		});
		const joined = await runner.start(
			script({
				steps: [
					{ id: "v", call: "await.big", reason: "r" },
					{ id: "n", let: "v.length" },
				],
			}),
		);
		expect(joined).toMatchObject({ status: "done", output: 100 });
	});
});

describe("runner: not-awaited steps", () => {
	it('a step with "await": false detaches as its own run; the rest returns now', async () => {
		const { gate, release } = deferredTool();
		const { runner, calls } = makeRunner(() => gate);
		const result = await runner.start(
			script({
				steps: [
					{ id: "fast", call: "svc.fast", args: { n: 1 }, reason: "now" },
					{
						id: "report",
						call: "svc.slow",
						await: false,
						reason: "background",
					},
					{ id: "now", let: "fast.fast" },
				],
			}),
		);
		// The main run settled without waiting for the slow step...
		expect(result).toMatchObject({ status: "done", output: true });
		// ...and the background step is its own pending run named by its step id.
		expect(runner.digest()).toMatchObject({ report: { status: "pending" } });
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1);

		release("landed");
		const settled = await runner.result("report");
		expect(settled).toMatchObject({ status: "done", output: "landed" });
		// Its output publishes as a session variable, like any run's.
		expect(sessionVars(runner)).toMatchObject({ report: "landed" });
		// And await.<stepId> joins it.
		const joined = await runner.start(
			script({ steps: [{ id: "v", call: "await.report", reason: "join" }] }),
		);
		expect(joined).toMatchObject({ status: "done", output: "landed" });
	});

	it("background steps see earlier steps' outputs through the session", async () => {
		const { gate, release } = deferredTool();
		const { runner, calls } = makeRunner(() => gate);
		await runner.start(
			script({
				steps: [
					{ id: "fast", call: "svc.fast", args: { n: 7 }, reason: "now" },
					{
						id: "bg",
						call: "svc.slow",
						await: false,
						args: { from: "=fast.args.n" },
						reason: "background",
					},
					{ id: "now", let: "'submitted'" },
				],
			}),
		);
		release("ok");
		await runner.result("bg");
		const bgCall = calls.find((c) => c.tool === "svc.slow");
		expect(bgCall?.args).toEqual({ from: 7 });
	});

	it("fail-fast: background steps do not fire when the main run errors", async () => {
		const { runner, calls } = makeRunner(async () => "unused");
		const result = await runner.start(
			script({
				steps: [
					{ id: "bg", call: "svc.slow", await: false, reason: "background" },
					{ id: "boom", let: "JSON.parse('{')" }, // valid statically, throws at run time
					{ id: "now", let: "'unreachable'" },
				],
			}),
		);
		expect(result.status).toBe("error");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(0);
	});

	it("validation: not-awaited steps are unreferencable, cannot be last, cannot be the whole script", () => {
		const asyncStep = { id: "bg", call: "svc.slow", await: false, reason: "r" };
		expect(() =>
			script({ steps: [asyncStep, { id: "n", let: "bg.length" }] }),
		).toThrowError(/not awaited.*await\.bg/s);
		expect(() =>
			script({ steps: [{ id: "a", let: "1" }, asyncStep] }),
		).toThrowError(/last step is not awaited/);
		expect(() => script({ steps: [asyncStep] })).toThrowError(
			/"await": false on the whole script/,
		);
		// Among concurrent independent steps the same rule holds: an unawaited
		// step is fine as long as nothing references it.
		expect(() =>
			script({
				steps: [
					asyncStep,
					{ id: "b", let: "2" },
					{ id: "n", let: "bg.length" },
				],
			}),
		).toThrowError(/not awaited.*await\.bg/s);
		expect(
			script({
				steps: [asyncStep, { id: "b", let: "2" }, { id: "n", let: "b" }],
			}).steps,
		).toHaveLength(3);
	});

	it("the await flag stays out of the step hash, so toggling it still reuses", async () => {
		const { runner, calls } = makeRunner(async () => "computed");
		const asyncForm = script({
			steps: [
				{ id: "report", call: "svc.slow", await: false, reason: "r" },
				{ id: "now", let: "'kicked off'" },
			],
		});
		await runner.start(asyncForm);
		await runner.result("report");
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1);

		// Resubmitting the step without the flag reuses the settled result - the
		// flag is scheduling metadata, not a different computation.
		const syncForm = script({
			steps: [{ id: "report", call: "svc.slow", reason: "r" }],
		});
		const reused = await runner.start(syncForm);
		expect(reused).toMatchObject({ status: "done", output: "computed" });
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1); // no re-call
	});
});

describe("runner: background-by-default tools (asyncTools)", () => {
	const makeAsyncToolRunner = (slow: () => Promise<unknown>) =>
		makeRunner(slow, { asyncTools: ["svc.slow"] });

	it("an unconsumed call to a background tool detaches without any flag", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeAsyncToolRunner(() => gate);
		const result = await runner.start(
			script({
				steps: [
					{ id: "report", call: "svc.slow", reason: "background by default" },
					{ id: "now", let: "'answered'" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: "answered" });
		expect(runner.digest()).toMatchObject({ report: { status: "pending" } });
		release("landed");
		expect((await runner.result("report")).output).toBe("landed");
	});

	it("consumption is the await: a referenced call stays synchronous", async () => {
		const { runner } = makeAsyncToolRunner(async () => ({ total: 1284 }));
		const result = await runner.start(
			script({
				steps: [
					{ id: "report", call: "svc.slow", reason: "consumed below" },
					{ id: "answer", let: "report.total" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: 1284 });
		expect(runner.digest()).toEqual({}); // nothing detached
	});

	it("the last step is the run's output, so it stays synchronous", async () => {
		const { runner } = makeAsyncToolRunner(async () => ({ total: 1284 }));
		const result = await runner.start(
			script({
				steps: [
					{ id: "report", call: "svc.slow", reason: "the answer itself" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: { total: 1284 } });
		expect(runner.digest()).toEqual({});
	});

	it('"await": true pins a background tool - wait for this one', async () => {
		const { runner } = makeAsyncToolRunner(async () => "confirmed");
		const result = await runner.start(
			script({
				steps: [
					{
						id: "report",
						call: "svc.slow",
						await: true,
						reason: "wait for it",
					},
					{ id: "now", let: "'after the wait'" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: "after the wait" });
		expect(runner.digest()).toEqual({}); // ran inline despite the tool default
	});

	it("wildcard patterns mark tool families as background", async () => {
		const { gate, release } = deferredTool();
		const { runner } = makeRunner(() => gate, { asyncTools: ["svc.*"] });
		const result = await runner.start(
			script({
				steps: [
					{ id: "bg", call: "svc.slow", reason: "matches svc.*" },
					{ id: "now", let: "1" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: 1 });
		expect(runner.digest()).toMatchObject({ bg: { status: "pending" } });
		release("ok");
		await runner.result("bg");
	});

	it("an unconsumed background step among independent steps detaches", async () => {
		const { gate, release } = deferredTool();
		const { runner, calls } = makeRunner(() => gate, {
			asyncTools: ["svc.slow"],
		});
		// The agent writes fast + slow as independent steps and only consumes
		// the fast one - the slow one must not block the answer.
		const result = await runner.start(
			script({
				steps: [
					{ id: "issues", call: "svc.fast", args: { n: 1 }, reason: "fast" },
					{ id: "closed", call: "svc.slow", reason: "slow report" },
					{ id: "out", let: "issues.args.n" },
				],
			}),
		);
		expect(result).toMatchObject({ status: "done", output: 1 });
		expect(runner.digest()).toMatchObject({ closed: { status: "pending" } });
		expect(calls.filter((c) => c.tool === "svc.slow")).toHaveLength(1); // fired in background
		release("landed");
		expect((await runner.result("closed")).output).toBe("landed");
	});

	it("background steps fire in script order - the report waits for the closes", async () => {
		const closes = deferredTool();
		const report = deferredTool();
		const calls: CallRequest[] = [];
		const runner = createRunner({
			deadlineMs: 25,
			asyncTools: ["svc.report"],
			handlers: {
				call: async (req) => {
					calls.push(req);
					if (req.tool === "svc.close") return closes.gate;
					if (req.tool === "svc.report") return report.gate;
					return "fast";
				},
			},
		});
		const src = validateScript(
			{
				steps: [
					{ id: "list", call: "svc.fast", reason: "answer now" },
					{
						id: "closeAll",
						call: "svc.close",
						await: false,
						reason: "slow side effect",
					},
					{
						id: "report",
						call: "svc.report",
						reason: "must reflect the closes",
					},
					{ id: "out", let: "list" },
				],
			},
			{ tools: ["svc.fast", "svc.close", "svc.report", "await.*"] },
		);
		const result = await runner.start(src);
		expect(result).toMatchObject({ status: "done", output: "fast" });
		// The closes fired; the report did NOT - its cluster waits in script order.
		expect(calls.map((c) => c.tool)).toContain("svc.close");
		expect(calls.map((c) => c.tool)).not.toContain("svc.report");

		closes.release([{ closed: 1 }]);
		await runner.result("closeAll");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls.map((c) => c.tool)).toContain("svc.report");
		report.release({ total: 5 });
		expect((await runner.result("report")).output).toEqual({ total: 5 });
	});

	it("a failed background step stops the chain - later background work never fires", async () => {
		const closes = deferredTool();
		const calls: CallRequest[] = [];
		const runner = createRunner({
			deadlineMs: 25,
			asyncTools: ["svc.report"],
			handlers: {
				call: async (req) => {
					calls.push(req);
					if (req.tool === "svc.close") return closes.gate;
					return "fast";
				},
			},
		});
		const src = validateScript(
			{
				steps: [
					{ id: "list", call: "svc.fast", reason: "answer now" },
					{
						id: "closeAll",
						call: "svc.close",
						await: false,
						reason: "will fail",
					},
					{
						id: "report",
						call: "svc.report",
						reason: "assumes the closes happened",
					},
					{ id: "out", let: "list" },
				],
			},
			{ tools: ["svc.fast", "svc.close", "svc.report", "await.*"] },
		);
		await runner.start(src);
		closes.fail(new Error("boom"));
		expect((await runner.result("closeAll")).status).toBe("error");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls.map((c) => c.tool)).not.toContain("svc.report");
	});

	it("a consumed background-by-default step waits", async () => {
		const { runner } = makeRunner(async () => ({ total: 9 }), {
			asyncTools: ["svc.slow"],
		});
		const result = await runner.start(
			script({
				steps: [
					{ id: "issues", call: "svc.fast", args: { n: 1 }, reason: "fast" },
					{ id: "closed", call: "svc.slow", reason: "slow but needed" },
					{ id: "out", let: "({ n: issues.args.n, total: closed.total })" },
				],
			}),
		);
		expect(result).toMatchObject({
			status: "done",
			output: { n: 1, total: 9 },
		});
		expect(runner.digest()).toEqual({}); // nothing detached
	});
});
