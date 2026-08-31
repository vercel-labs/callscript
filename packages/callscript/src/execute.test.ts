import { describe, expect, it, vi } from "vitest";
import { executeScript, planExecution } from "./execute";
import {
	type CallRequest,
	type ExecuteResult,
	type Script,
	validateScript,
} from "./index";

const issues = [
	{ number: 1, updated_at: "2019-01-01T00:00:00Z" },
	{ number: 2, updated_at: "2099-01-01T00:00:00Z" }, // fresh
	{ number: 3, updated_at: "2018-01-01T00:00:00Z" },
];

function staleScript(): Script {
	return validateScript({
		intent: "Close stale issues and notify",
		steps: [
			{
				id: "issues",
				call: "github:GET /repos/{owner}/{repo}/issues",
				args: { owner: "acme", repo: "api" },
				reason: "list issues",
			},
			{
				id: "stale",
				let: "issues.filter(i => Date.parse(i.updated_at) < Date.parse('2026-01-01'))",
			},
			{
				id: "close",
				call: "github:PATCH /repos/{owner}/{repo}/issues/{n}",
				each: "stale.map(issue => ({ owner: 'acme', repo: 'api', n: issue.number, state: 'closed' }))",
				max: 10,
				reason: "close stale issues",
				// Approval gate: end the run with the resolved-calls preview until
				// the host re-executes with input.approved.
				return: "!input.approved && { confirm: $calls.map(c => c.args.n) }",
			},
			{
				id: "notify",
				if: "stale.length > 0",
				call: "slack:POST /chat.postMessage",
				args: { channel: "#eng", text: "=`Closed ${stale.length} issues`" },
				reason: "notify team",
			},
			{ id: "result", let: "({ closed: stale.map(i => i.number) })" },
		],
	});
}

function makeHandler(log: CallRequest[] = []) {
	return {
		log,
		call: vi.fn(async (req: CallRequest) => {
			log.push(req);
			if (req.tool.startsWith("github:GET")) return issues;
			if (req.tool.startsWith("github:PATCH"))
				return { ok: true, n: (req.args as { n: number }).n };
			if (req.tool.startsWith("slack:POST")) return { ts: "123" };
			throw new Error(`unexpected call ${req.tool}`);
		}),
	};
}

describe("executeScript", () => {
	it("returns early at a gated step with the $calls preview, then re-executes past it", async () => {
		const script = staleScript();
		const handler = makeHandler();

		// First run: no input.approved → the run RETURNS at "close".
		const first = await executeScript(script, { handlers: handler });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		expect(first.returnedAt).toBe("close");
		// The output carries the resolved concrete calls (issues 1 and 3).
		expect(first.output).toEqual({ confirm: [1, 3] });
		expect(first.record.status).toBe("returned");
		expect(first.record.at).toBe("close");
		expect(first.record.steps.close?.status).toBe("returned");
		// Only the read ran so far.
		expect(handler.call).toHaveBeenCalledTimes(1);

		// Re-execute with approval piped in: settled steps reuse, writes fire.
		const second = await executeScript(script, {
			handlers: handler,
			state: JSON.parse(JSON.stringify(first.record)), // survives serialization
			input: { approved: true },
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.returnedAt).toBeUndefined();
		expect(second.output).toEqual({ closed: [1, 3] });
		// 1 (initial read, not re-run) + 2 writes + 1 slack = 4 total handler calls.
		expect(handler.call).toHaveBeenCalledTimes(4);
	});

	it("re-executing without new input just returns again, counting attempts", async () => {
		const script = staleScript();
		const handler = makeHandler();
		const first = await executeScript(script, { handlers: handler });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		const again = await executeScript(script, {
			handlers: handler,
			state: first.record,
		});
		expect(again.status).toBe("ok");
		if (again.status !== "ok") return;
		expect(again.returnedAt).toBe("close");
		expect(again.record.steps.close?.attempts).toBe(2);
		expect(handler.call).toHaveBeenCalledTimes(1); // read reused, nothing re-ran
	});

	it("the $calls preview is exactly what runs after the re-execute", async () => {
		const script = staleScript();
		const handler = makeHandler();
		const first = await executeScript(script, { handlers: handler });
		if (first.status !== "ok") return;
		const preview = (first.output as { confirm: number[] }).confirm;
		const log: CallRequest[] = [];
		const second = await executeScript(script, {
			handlers: makeHandler(log),
			state: first.record,
			input: { approved: true },
		});
		expect(second.status).toBe("ok");
		const written = log
			.filter((r) => r.tool.startsWith("github:PATCH"))
			.map((r) => (r.args as { n: number }).n);
		expect(written).toEqual(preview);
	});

	it("skips steps whose `if` is falsy", async () => {
		const script = validateScript({
			intent: "conditional",
			steps: [
				{ id: "xs", let: "[]" },
				{
					id: "notify",
					if: "xs.length > 0",
					call: "slack:POST /chat.postMessage",
					args: { text: "hi" },
					reason: "r",
				},
				{ id: "out", let: "notify === undefined" },
			],
		});
		const handler = makeHandler();
		const result = await executeScript(script, { handlers: handler });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(true);
		expect(handler.call).not.toHaveBeenCalled();
	});

	it("fails the run when the each list exceeds max", async () => {
		const script = validateScript({
			intent: "too many",
			steps: [
				{ id: "xs", let: "[1, 2, 3]" },
				{
					id: "a",
					call: "svc:POST /x",
					each: "xs.map(x => ({ v: x }))",
					max: 2,
					reason: "r",
				},
			],
		});
		const result = await executeScript(script, { handlers: makeHandler() });
		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.error.message).toMatch(/more than max/);
		expect(result.record.status).toBe("error");
	});

	it("onError: skip records item failures and continues", async () => {
		const script = validateScript({
			intent: "partial failure",
			steps: [
				{ id: "xs", let: "[1, 2, 3]" },
				{
					id: "a",
					call: "svc:POST /x",
					each: "xs.map(x => ({ v: x }))",
					max: 3,
					reason: "r",
					onError: "skip",
				},
				{ id: "ok", let: "a.filter(r => r !== undefined).length" },
			],
		});
		const call = vi.fn(async (req: CallRequest) => {
			const v = (req.args as { v: number }).v;
			if (v === 2) throw new Error("boom");
			return v * 10;
		});
		const result = await executeScript(script, { handlers: { call } });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(2);
		expect(result.record.steps.a?.items?.[1]?.status).toBe("error");
	});

	it("rejects scripts that declare removed fields (checkpoint/retry)", () => {
		for (const extra of [{ checkpoint: true }, { retry: { max: 2 } }]) {
			expect(() =>
				validateScript({
					intent: "removed",
					steps: [{ id: "a", call: "svc:GET /flaky", reason: "r", ...extra }],
				}),
			).toThrow();
		}
	});

	it("accepts a step's self-declared scrutiny flag (suspend: true)", () => {
		const script = validateScript({
			intent: "gated",
			steps: [{ id: "a", call: "svc:GET /flaky", reason: "r", suspend: true }],
		});
		expect((script.steps[0] as { suspend?: boolean }).suspend).toBe(true);
	});

	it("stops on failure by default and reports the failing step", async () => {
		const script = validateScript({
			intent: "fail fast",
			steps: [
				{ id: "a", call: "svc:GET /x", reason: "r" },
				{ id: "b", call: "svc:GET /y", reason: "r" },
			],
		});
		const call = vi.fn(async (req: CallRequest) => {
			if (req.tool === "svc:GET /y") throw new Error("nope");
			return 1;
		});
		const result = await executeScript(script, { handlers: { call } });
		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.at).toBe("b");
		expect(result.error.message).toBe("nope");
	});

	it("re-executing an errored run retries the failed step, reusing the prefix", async () => {
		const script = validateScript({
			intent: "retry by re-execute",
			steps: [
				{ id: "a", call: "svc:GET /x", reason: "r" },
				{ id: "b", call: "svc:GET /y", reason: "r" },
			],
		});
		let healthy = false;
		const calls: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				calls.push(req.tool);
				if (req.tool === "svc:GET /y" && !healthy) throw new Error("nope");
				return req.tool;
			},
		};
		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("error");
		healthy = true;
		const second = await executeScript(script, {
			handlers,
			state: first.record,
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.output).toBe("svc:GET /y");
		// "a" ran once; "b" ran twice (the failure and the retry).
		expect(calls).toEqual(["svc:GET /x", "svc:GET /y", "svc:GET /y"]);
	});

	describe("reconciliation", () => {
		const twoStep = () =>
			validateScript({
				intent: "editable",
				steps: [
					{ id: "a", call: "svc:GET /x", reason: "r" },
					{ id: "b", let: "a + 1" },
				],
			});

		it("an edited step re-runs; the settled prefix is reused", async () => {
			const calls: string[] = [];
			const handlers = {
				call: async (req: CallRequest) => {
					calls.push(req.tool);
					return 41;
				},
			};
			const first = await executeScript(twoStep(), { handlers });
			expect(first.status).toBe("ok");
			if (first.status !== "ok") return;
			expect(first.output).toBe(42);

			// Edit the derivation, extend the script, re-execute against the record.
			const edited = validateScript({
				intent: "editable",
				steps: [
					{ id: "a", call: "svc:GET /x", reason: "r" },
					{ id: "b", let: "a + 2" },
					{ id: "c", let: "b * 10" },
				],
			});
			const second = await executeScript(edited, {
				handlers,
				state: first.record,
			});
			expect(second.status).toBe("ok");
			if (second.status !== "ok") return;
			expect(second.output).toBe(430);
			expect(calls).toEqual(["svc:GET /x"]); // the call step never re-ran
		});

		it("a run against an unrelated record just runs everything", async () => {
			const handlers = { call: async () => 41 };
			const first = await executeScript(twoStep(), { handlers });
			if (first.status !== "ok") return;
			const other = validateScript({
				intent: "different",
				steps: [{ id: "z", let: "1" }],
			});
			const result = await executeScript(other, {
				handlers,
				state: first.record,
			});
			expect(result.status).toBe("ok");
			if (result.status !== "ok") return;
			expect(result.output).toBe(1);
		});

		it("planExecution previews reuse vs run, flagging changed call steps", async () => {
			const handlers = { call: async () => 41 };
			const first = await executeScript(twoStep(), { handlers });
			if (first.status !== "ok") return;

			const fresh = planExecution(twoStep());
			expect(fresh.map((p) => [p.id, p.action, p.why])).toEqual([
				["a", "run", "new"],
				["b", "run", "new"],
			]);

			const same = planExecution(twoStep(), first.record);
			expect(same.map((p) => [p.id, p.action, p.why])).toEqual([
				["a", "reuse", "settled"],
				["b", "reuse", "settled"],
			]);

			const edited = validateScript({
				intent: "editable",
				steps: [
					{ id: "a", call: "svc:GET /x", args: { page: 2 }, reason: "r" },
					{ id: "b", let: "a + 1" },
				],
			});
			const plan = planExecution(edited, first.record);
			const a = plan.find((p) => p.id === "a")!;
			expect(a.action).toBe("run");
			expect(a.why).toBe("changed");
			expect(a.tool).toBe("svc:GET /x"); // side effects re-fire — hosts gate on this
		});

		it("re-runs a released step when an edited script needs its output again", async () => {
			const script = validateScript({
				intent: "big payload",
				steps: [
					{ id: "big", call: "svc:GET /rows", reason: "fetch" },
					{ id: "n", let: "big.rows.length" },
					{
						id: "done",
						call: "svc:POST /report",
						args: { n: "=n" },
						reason: "report",
					},
				],
			});
			let fetches = 0;
			const handlers = {
				call: async (req: CallRequest) => {
					if (req.tool === "svc:GET /rows") {
						fetches++;
						return { rows: [1, 2, 3] };
					}
					return "ok";
				},
			};
			const first = await executeScript(script, { handlers });
			if (first.status !== "ok") return;
			expect(first.record.steps.big?.released).toBe(true);

			// A new step wants `big` back — but its output was dropped. The
			// producer must re-run rather than silently feeding undefined.
			const edited = validateScript({
				intent: "big payload",
				steps: [
					{ id: "big", call: "svc:GET /rows", reason: "fetch" },
					{ id: "n", let: "big.rows.length" },
					{
						id: "done",
						call: "svc:POST /report",
						args: { n: "=n" },
						reason: "report",
					},
					{ id: "first_row", let: "big.rows[0]" },
				],
			});
			const plan = planExecution(edited, first.record);
			expect(plan.find((p) => p.id === "big")).toMatchObject({
				action: "run",
				why: "released",
			});
			const second = await executeScript(edited, {
				handlers,
				state: first.record,
			});
			expect(second.status).toBe("ok");
			if (second.status !== "ok") return;
			expect(second.output).toBe(1);
			expect(fetches).toBe(2);
		});
	});

	it("defaults output to the last step's value", async () => {
		const script = validateScript({
			intent: "default output",
			steps: [
				{ id: "a", call: "svc:GET /x", reason: "r" },
				{ id: "b", let: "a + 1" },
			],
		});
		const result: ExecuteResult = await executeScript(script, {
			handlers: { call: async () => 41 },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe(42);
	});

	it("binds `input` in every expression, ephemerally", async () => {
		const script = validateScript({
			intent: "input",
			steps: [
				{
					id: "a",
					call: "svc:GET /x",
					args: { code: "=input.code" },
					reason: "r",
				},
				{ id: "b", let: "[a.code, input.limit ?? 10]" },
			],
		});
		const result = await executeScript(script, {
			handlers: { call: async (req: CallRequest) => req.args },
			input: { code: "1234", limit: 3 },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toEqual(["1234", 3]);
		// input itself is never persisted in the record.
		expect(JSON.stringify(result.record)).not.toContain('1234","limit');
	});

	describe("memory", () => {
		const bigThenCount = () =>
			validateScript({
				intent: "big payload, small result",
				steps: [
					{ id: "big", call: "svc:GET /rows", reason: "fetch" },
					{ id: "n", let: "big.rows.length" },
					{
						id: "done",
						call: "svc:POST /report",
						args: { n: "=n" },
						reason: "report",
					},
				],
			});
		const handlers = {
			call: async (req: CallRequest) =>
				req.tool === "svc:GET /rows"
					? { rows: Array.from({ length: 500 }, (_, i) => i) }
					: "ok",
		};

		it("releases outputs after their last static reference (default)", async () => {
			const result = await executeScript(bigThenCount(), { handlers });
			expect(result.status).toBe("ok");
			if (result.status !== "ok") return;
			expect(result.output).toBe("ok");
			// `big` was last referenced by `n`; its payload is gone from the record.
			expect(result.record.steps.big?.output).toBeUndefined();
			expect(result.record.steps.big?.released).toBe(true);
			expect(result.record.steps.big?.status).toBe("done");
		});

		it("retainOutputs: 'all' keeps every output", async () => {
			const result = await executeScript(bigThenCount(), {
				handlers,
				retainOutputs: "all",
			});
			expect(result.status).toBe("ok");
			if (result.status !== "ok") return;
			expect(result.record.steps.big?.output).toEqual({
				rows: Array.from({ length: 500 }, (_, i) => i),
			});
			expect(result.record.steps.big?.released).toBeUndefined();
		});

		it("rejects call results over maxCallResultBytes", async () => {
			const script = validateScript({
				intent: "huge result",
				steps: [{ id: "a", call: "svc:GET /huge", reason: "r" }],
			});
			const result = await executeScript(script, {
				handlers: { call: async () => "x".repeat(1000) },
				limits: { maxCallResultBytes: 100 },
			});
			expect(result.status).toBe("error");
			if (result.status !== "error") return;
			expect(result.error.code).toBe("result_too_large");
			expect(result.error.message).toMatch(/maxCallResultBytes/);
		});

		it("oversized results respect onError: 'skip'", async () => {
			const script = validateScript({
				intent: "huge but skippable",
				steps: [
					{ id: "a", call: "svc:GET /huge", reason: "r", onError: "skip" },
					{ id: "b", let: "a ?? 'skipped'" },
				],
			});
			const result = await executeScript(script, {
				handlers: { call: async () => "x".repeat(1000) },
				limits: { maxCallResultBytes: 100 },
			});
			expect(result.status).toBe("ok");
			if (result.status !== "ok") return;
			expect(result.output).toBe("skipped");
		});

		it("strips per-item outputs once an each step aggregates", async () => {
			const script = validateScript({
				intent: "each bookkeeping",
				steps: [
					{ id: "xs", let: "[1, 2, 3]" },
					{
						id: "a",
						call: "svc:GET /x",
						reason: "r",
						each: "xs.map(x => ({ v: x }))",
						max: 3,
					},
				],
			});
			const result = await executeScript(script, {
				handlers: {
					call: async (req: CallRequest) => (req.args as { v: number }).v * 10,
				},
			});
			expect(result.status).toBe("ok");
			if (result.status !== "ok") return;
			expect(result.output).toEqual([10, 20, 30]);
			expect(result.record.steps.a?.items?.every((i) => !("output" in i))).toBe(
				true,
			);
		});
	});
});
