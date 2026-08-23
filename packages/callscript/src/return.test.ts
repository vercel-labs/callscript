import { describe, expect, it, vi } from "vitest";
import {
	type CallContext,
	type CallRequest,
	earlyReturn,
	type Script,
	validateScript,
} from "./index";
import { executeScript } from "./execute";

describe("script-declared return", () => {
	it("gates on input and re-evaluates on re-execute", async () => {
		const script: Script = validateScript({
			intent: "conditional gate",
			steps: [
				{ id: "amount", let: "150" },
				{
					id: "refund",
					call: "billing.refund",
					args: { amount: "=amount" },
					reason: "refund the customer",
					return:
						"amount > 100 && !input.approved && { needsApproval: amount }",
				},
			],
		});
		const handlers = { call: async (req: CallRequest) => req.args };

		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		expect(first.returnedAt).toBe("refund");
		expect(first.output).toEqual({ needsApproval: 150 });

		const second = await executeScript(script, {
			handlers,
			state: JSON.parse(JSON.stringify(first.record)),
			input: { approved: true },
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.returnedAt).toBeUndefined();
		expect(second.output).toEqual({ amount: 150 });
	});

	it("runs straight through when the return expression is falsy", async () => {
		const script: Script = validateScript({
			intent: "conditional gate",
			steps: [
				{ id: "amount", let: "50" },
				{
					id: "refund",
					call: "billing.refund",
					args: { amount: "=amount" },
					reason: "refund the customer",
					return: "amount > 100 && { needsApproval: amount }",
				},
			],
		});
		const result = await executeScript(script, {
			handlers: { call: async (req: CallRequest) => req.args },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toEqual({ amount: 50 });
	});

	it("a return-only step is a guard clause; falsy settles as done/undefined", async () => {
		const make = (items: string) =>
			validateScript({
				intent: "guard",
				steps: [
					{ id: "stale", let: items },
					{ id: "empty", return: "stale.length === 0 && { closed: 0 }" },
					{
						id: "close",
						call: "svc.close",
						each: "stale.map(s => ({ v: s }))",
						reason: "r",
					},
					{ id: "out", let: "({ closed: close.length })" },
				],
			});
		const handlers = { call: async () => "ok" };

		const empty = await executeScript(make("[]"), { handlers });
		expect(empty.status).toBe("ok");
		if (empty.status !== "ok") return;
		expect(empty.returnedAt).toBe("empty");
		expect(empty.output).toEqual({ closed: 0 });

		const busy = await executeScript(make("[1, 2]"), { handlers });
		expect(busy.status).toBe("ok");
		if (busy.status !== "ok") return;
		expect(busy.returnedAt).toBeUndefined();
		expect(busy.output).toEqual({ closed: 2 });
		expect(busy.record.steps.empty?.status).toBe("done");
		expect(busy.record.steps.empty?.output).toBeUndefined();
	});

	it("a return-only step WITH an if is a JS guard: the value may be falsy", async () => {
		const make = (count: string) =>
			validateScript({
				intent: "guard",
				steps: [
					{ id: "n", let: count },
					{ id: "empty", if: "n === 0", return: "null" },
					{ id: "work", call: "svc.op", reason: "r" },
				],
			});
		const handlers = { call: async () => "worked" };

		// The condition holds -> the run ends with the falsy value itself.
		const zero = await executeScript(make("0"), { handlers });
		expect(zero.status).toBe("ok");
		if (zero.status !== "ok") return;
		expect(zero.returnedAt).toBe("empty");
		expect(zero.output).toBe(null);
		expect(zero.record.steps.work).toBeUndefined();

		// The condition fails -> the step skips and the run continues.
		const busy = await executeScript(make("3"), { handlers });
		expect(busy.status).toBe("ok");
		if (busy.status !== "ok") return;
		expect(busy.returnedAt).toBeUndefined();
		expect(busy.output).toBe("worked");
		expect(busy.record.steps.empty?.status).toBe("skipped");
	});

	it("an if on a CALL step's return gate keeps the truthy-gate semantics", async () => {
		// `if` skips the whole step; when it passes, the gate still decides
		// truthily - a falsy gate value means "make the calls".
		const script = validateScript({
			intent: "call gate unchanged",
			steps: [
				{
					id: "s",
					if: "true",
					call: "svc.op",
					reason: "r",
					return: "false && { paused: true }",
				},
			],
		});
		const result = await executeScript(script, {
			handlers: { call: async () => "ran" },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.returnedAt).toBeUndefined();
		expect(result.output).toBe("ran");
	});

	it("a post-step gate reads the previous step's settled output (checkpoint pattern)", async () => {
		const script: Script = validateScript({
			intent: "pause after a batch that had failures",
			steps: [
				{ id: "batch", call: "svc.op", reason: "do work" },
				{
					id: "inspect",
					return: "batch.failed > 0 && !input.ack && { failed: batch.failed }",
				},
				{ id: "after", let: "'ran'" },
			],
		});
		const run = (failed: number, state?: never, input?: unknown) =>
			executeScript(script, {
				handlers: { call: async () => ({ failed }) },
				state,
				input,
			});

		const paused = await executeScript(script, {
			handlers: { call: async () => ({ failed: 2 }) },
		});
		expect(paused.status).toBe("ok");
		if (paused.status !== "ok") return;
		expect(paused.returnedAt).toBe("inspect");
		expect(paused.output).toEqual({ failed: 2 });
		// The batch itself is SETTLED - the pause is after it.
		expect(paused.record.steps.batch?.status).toBe("done");

		// Acknowledge and continue: the batch is not re-run.
		const calls = vi.fn(async () => ({ failed: 2 }));
		const resumed = await executeScript(script, {
			handlers: { call: calls },
			state: paused.record,
			input: { ack: true },
		});
		expect(resumed.status).toBe("ok");
		if (resumed.status !== "ok") return;
		expect(resumed.output).toBe("ran");
		expect(calls).not.toHaveBeenCalled();

		const through = await run(0);
		expect(through.status).toBe("ok");
		if (through.status !== "ok") return;
		expect(through.output).toBe("ran");
	});

	it("if beats return: a skipped step never returns", async () => {
		const script: Script = validateScript({
			intent: "skip beats return",
			steps: [
				{
					id: "s",
					if: "false",
					call: "svc.op",
					reason: "never",
					return: "{ paused: true }",
				},
				{ id: "after", let: "'ran'" },
			],
		});
		const result = await executeScript(script, {
			handlers: { call: async () => "x" },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe("ran");
	});

	it("forgives the args '=' marker on a return expression", async () => {
		const script: Script = validateScript({
			intent: "marker",
			steps: [
				{
					id: "s",
					call: "svc.op",
					reason: "gated",
					return: "=({ gated: true })",
				},
			],
		});
		expect(script.steps[0]).toMatchObject({ return: "({ gated: true })" });
		const result = await executeScript(script, {
			handlers: { call: async () => "ok" },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.returnedAt).toBe("s");
	});

	it("keeps outputs referenced only by a return expression alive", async () => {
		// `flag` is referenced nowhere but the return expression - the live
		// output-release pass must not drop it before the gate evaluates.
		const script: Script = validateScript({
			intent: "retention",
			steps: [
				{ id: "flag", let: "true" },
				{ id: "mid", call: "svc.a", reason: "unrelated" },
				{
					id: "gated",
					call: "svc.b",
					reason: "gated by flag",
					return: "flag && { hold: true }",
				},
			],
		});
		const result = await executeScript(script, {
			handlers: { call: async (req: CallRequest) => req.tool },
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.returnedAt).toBe("gated");
	});

	it("rejects return expressions with unknown references", () => {
		expect(() =>
			validateScript({
				intent: "bad refs",
				steps: [
					{
						id: "s",
						call: "svc.op",
						each: "[1, 2].map(item => ({ i: item }))",
						max: 5,
						reason: "gated",
						// Step-level gate, evaluated once before the calls: anything
						// undeclared is out of scope.
						return: "nope && { x: 1 }",
					},
				],
			}),
		).toThrowError(/steps\[0\]\.return/);
	});

	it("rejects $calls outside a call step's return expression", () => {
		expect(() =>
			validateScript({
				intent: "misplaced $calls",
				steps: [
					{ id: "a", call: "svc.op", reason: "r" },
					{ id: "b", let: "$calls.length" },
				],
			}),
		).toThrowError(
			/"\$calls" is only available in a call step's "return" expression/,
		);
	});

	it("rejects step ids that shadow `input`", () => {
		expect(() =>
			validateScript({ intent: "shadow", steps: [{ id: "input", let: "1" }] }),
		).toThrowError(/reserved/);
	});
});

describe("handler earlyReturn", () => {
	function tokenGatedHandler() {
		const seen: Array<{ req: CallRequest; ctx: CallContext }> = [];
		let token: string | undefined;
		return {
			seen,
			grant(value: string) {
				token = value;
			},
			call: vi.fn(async (req: CallRequest, ctx: CallContext) => {
				seen.push({ req, ctx });
				if (req.tool !== "notion.get_page") return { ok: true };
				if (!token) {
					throw earlyReturn({
						kind: "link",
						title: "Notion needs your approval",
						url: `https://notion.so/approve/${(req.args as { page: string }).page}`,
					});
				}
				return {
					content: `doc for ${(req.args as { page: string }).page}`,
					via: token,
				};
			}),
		};
	}

	it("ends the run with the handler's value, then re-dispatches on re-execute", async () => {
		const script: Script = validateScript({
			intent: "read a doc",
			steps: [
				{
					id: "doc",
					call: "notion.get_page",
					args: { page: "p1" },
					reason: "read",
				},
				{ id: "out", let: "doc.content" },
			],
		});
		const handler = tokenGatedHandler();

		const first = await executeScript(script, { handlers: handler });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		expect(first.returnedAt).toBe("doc");
		expect(first.output).toMatchObject({ kind: "link" });
		const step = first.record.steps.doc!;
		expect(step.status).toBe("returned");
		expect(step.attempts).toBe(1);
		// A returned dispatch does not count as a performed call.
		expect(step.calls ?? 0).toBe(0);
		// First dispatch saw attempt 0.
		expect(handler.seen[0]!.ctx.attempt).toBe(0);

		// JSON round-trip: the parked record must survive serialization.
		const record = JSON.parse(JSON.stringify(first.record));

		handler.grant("tok_1");
		const second = await executeScript(script, {
			handlers: handler,
			state: record,
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.output).toBe("doc for p1");
		// The re-dispatch saw the prior attempt count.
		expect(handler.seen.at(-1)!.ctx.attempt).toBe(1);
	});

	it("re-executes only the never-completed each items", async () => {
		const script: Script = validateScript({
			intent: "read three docs",
			steps: [
				{ id: "pages", let: "['a', 'b', 'c']" },
				{
					id: "docs",
					call: "get_page",
					each: "pages.map(p => ({ page: p }))",
					max: 5,
					reason: "read all",
				},
				{ id: "out", let: "docs.map(d => d.content ?? 'blocked')" },
			],
		});
		// Only page "b" is gated; a and c succeed immediately.
		let approved = false;
		const calls: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				const page = (req.args as { page: string }).page;
				calls.push(page);
				if (page !== "b") return { content: page };
				if (!approved) throw earlyReturn({ kind: "approval", page: "b" });
				return { content: "b-approved" };
			},
		};

		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("ok");
		if (first.status !== "ok") return;
		expect(first.returnedAt).toBe("docs");
		expect(first.output).toEqual({ kind: "approval", page: "b" });
		// Done items are retained with outputs; the returned slot is unset.
		const items = first.record.steps.docs!.items!;
		expect(items[0]!.status).toBe("done");
		expect(items[1]).toBeUndefined();
		expect(items[2]!.status).toBe("done");
		expect(calls).toEqual(["a", "b", "c"]);

		approved = true;
		const second = await executeScript(script, {
			handlers,
			state: first.record,
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		expect(second.output).toEqual(["a", "b-approved", "c"]);
		// Only "b" re-dispatched.
		expect(calls).toEqual(["a", "b", "c", "b"]);
	});

	it("multiple items returning early yield the earliest item's value", async () => {
		const script: Script = validateScript({
			intent: "batch",
			steps: [
				{
					id: "batch",
					call: "svc.op",
					each: "[1, 2, 3].map(i => ({ i }))",
					max: 5,
					reason: "all gated",
				},
			],
		});
		const handlers = {
			call: async (req: CallRequest) => {
				throw earlyReturn({ gate: (req.args as { i: number }).i });
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.returnedAt).toBe("batch");
		expect(result.output).toEqual({ gate: 1 });
		expect(result.record.steps.batch!.attempts).toBe(1);
	});

	it("onError fail takes precedence over a sibling item's early return", async () => {
		const script: Script = validateScript({
			intent: "mixed outcomes",
			steps: [
				{
					id: "mix",
					call: "svc.op",
					each: "[1, 2].map(i => ({ i }))",
					max: 5,
					reason: "one fails hard, one returns",
				},
			],
		});
		const handlers = {
			call: async (req: CallRequest) => {
				const i = (req.args as { i: number }).i;
				if (i === 1) throw new Error("boom");
				throw earlyReturn({ gate: true });
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("error");
		if (result.status !== "error") return;
		expect(result.error.message).toBe("boom");
	});

	it("script return and handler return compose: gate first, then handler wait", async () => {
		const script: Script = validateScript({
			intent: "gated and token-gated",
			steps: [
				{
					id: "s",
					call: "svc.op",
					args: { v: 1 },
					reason: "risky",
					return: "!input.approved && { confirm: $calls }",
				},
				{ id: "out", let: "s" },
			],
		});
		let token: string | undefined;
		const handlers = {
			call: async (req: CallRequest) => {
				if (!token) throw earlyReturn({ kind: "token-needed" });
				return req.args;
			},
		};

		// 1: the script's own gate fires with the calls preview.
		const gated = await executeScript(script, { handlers });
		expect(gated.status).toBe("ok");
		if (gated.status !== "ok") return;
		expect(gated.returnedAt).toBe("s");
		expect(gated.output).toMatchObject({ confirm: [{ args: { v: 1 } }] });

		// 2: approved → dispatches → the handler parks the run on its token.
		const waiting = await executeScript(script, {
			handlers,
			state: gated.record,
			input: { approved: true },
		});
		expect(waiting.status).toBe("ok");
		if (waiting.status !== "ok") return;
		expect(waiting.returnedAt).toBe("s");
		expect(waiting.output).toEqual({ kind: "token-needed" });

		// 3: token arrives; approval must be piped again (input is ephemeral).
		token = "tok_1";
		const done = await executeScript(script, {
			handlers,
			state: waiting.record,
			input: { approved: true },
		});
		expect(done.status).toBe("ok");
		if (done.status !== "ok") return;
		expect(done.returnedAt).toBeUndefined();
		expect(done.output).toEqual({ v: 1 });
	});
});
