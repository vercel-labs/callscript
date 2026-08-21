import { describe, expect, expectTypeOf, it } from "vitest";
import { scriptEngine, suspend } from "./engine";
import {
	EarlyReturnSignal,
	publishedVariables,
	SuspendSignal,
} from "./execute";
import { tool } from "./tool";
import { ScriptValidationError } from "./validate";

/* ------------------------------- fixtures -------------------------------- */

const makeTools = () => {
	let listCalls = 0;
	const listIssues = tool({
		name: "issues.list",
		execute: (_args: { repo: string }) => {
			listCalls++;
			return [
				{ number: 1, title: "old bug", stale: true },
				{ number: 2, title: "fresh bug", stale: false },
				{ number: 3, title: "old chore", stale: true },
			];
		},
	});
	const closeIssue = tool({
		name: "issues.close",
		execute: (args: { repo: string; number: number }) => ({
			closed: args.number,
		}),
	});
	return { listIssues, closeIssue, calls: () => listCalls };
};

/* --------------------- the session lives in the scope --------------------- */

describe("scope as session", () => {
	it("two runs sharing a scope share the session record - no state threading", async () => {
		const { listIssues, closeIssue, calls } = makeTools();
		const engine = scriptEngine({ tools: [listIssues, closeIssue] });
		const scope = engine.scope();

		const first = await engine.run(
			{
				script: {
					steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
				},
			},
			scope,
		);
		expect(first.status).toBe("ok");

		// `issues` has no producing step here - it is a session variable,
		// carried by the scope's accumulated state, validated at the door.
		const second = await engine.run(
			{
				script: {
					steps: [{ id: "titles", let: "issues.map(i => i.title)" }],
				},
			},
			scope,
		);
		expect(second.status).toBe("ok");
		if (second.status === "ok") {
			expect(second.output).toEqual(["old bug", "fresh bug", "old chore"]);
		}
		expect(calls()).toBe(1); // nothing re-fetched
	});

	it("without a shared scope, runs stay isolated", async () => {
		const { listIssues } = makeTools();
		const engine = scriptEngine({ tools: [listIssues] });
		await engine.run({
			script: {
				steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
			},
		});
		expect(() =>
			engine.run({
				script: { steps: [{ id: "t", let: "issues.length" }] },
			}),
		).toThrow(ScriptValidationError);
	});

	it("explicit state still wins over the scope", async () => {
		const { listIssues } = makeTools();
		const engine = scriptEngine({ tools: [listIssues] });
		const scope = engine.scope();
		const first = await engine.run(
			{
				script: {
					steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
				},
			},
			scope,
		);
		if (first.status !== "ok") throw new Error("expected ok");
		// A fresh scope plus the explicit record: the state option is honored.
		const second = await engine.run({
			script: { steps: [{ id: "n", let: "issues.length" }] },
			state: first.state,
		});
		expect(second.status).toBe("ok");
		if (second.status === "ok") expect(second.output).toBe(3);
	});

	it("tools read the session off the dispatch context's scope", async () => {
		const { listIssues } = makeTools();
		const readBack = tool({
			name: "session.stale",
			execute: (_args: void, ctx) =>
				ctx.scope?.state
					? publishedVariables(ctx.scope.state).stale
					: undefined,
		});
		const engine = scriptEngine({ tools: [listIssues, readBack] });
		const scope = engine.scope();

		await engine.run(
			{
				script: {
					steps: [
						{ id: "issues", call: "issues.list", args: { repo: "api" } },
						{
							id: "stale",
							let: "issues.filter(i => i.stale).map(i => i.number)",
						},
					],
				},
			},
			scope,
		);

		// A later run's TOOL reads the settled step's output off the scope.
		const second = await engine.run(
			{ script: { steps: [{ id: "got", call: "session.stale" }] } },
			scope,
		);
		expect(second.status).toBe("ok");
		if (second.status === "ok") expect(second.output).toEqual([1, 3]);
	});

	it("the scope's state is directly inspectable", async () => {
		const { listIssues } = makeTools();
		const engine = scriptEngine({ tools: [listIssues] });
		const scope = engine.scope();
		await engine.run(
			{
				script: {
					steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
				},
			},
			scope,
		);
		expect(scope.state?.steps.issues?.status).toBe("done");
	});
});

/* ---------------------------- scripts as tools ----------------------------- */

describe("engine.tool - a script compiled into a tool", () => {
	const staleScript = {
		steps: [
			{
				id: "issues",
				call: "issues.list",
				args: { repo: "=input.repo ?? 'api'" },
			},
			{ id: "stale", let: "issues.filter(i => i.stale)" },
			{
				id: "close",
				call: "issues.close",
				each: "stale.map(issue => ({ repo: 'api', number: issue.number }))",
				max: 10,
				return:
					"!input.approved && { confirm: $calls.map(c => c.args.number) }",
			},
			{ id: "out", let: "({ closed: stale.map(i => i.number) })" },
		],
	} as const;

	it("compiles and calls; the card carries the description", async () => {
		const { listIssues, closeIssue } = makeTools();
		const engine = scriptEngine({ tools: [listIssues, closeIssue] });
		const closeStale = engine.tool("github.closeStale", staleScript, {
			description: "close every stale issue",
		});
		expect(closeStale.name).toBe("github.closeStale");
		expect(closeStale.$script).toBe(true);
		expect(closeStale.script.intent).toBeDefined();
		expect(closeStale.description).toBe("close every stale issue");

		const result = await closeStale.execute({ approved: true });
		expect(result).toEqual({ closed: [1, 3] });
	});

	it("an unknown tool fails at COMPILE time", () => {
		const { listIssues } = makeTools();
		const engine = scriptEngine({ tools: [listIssues] });
		expect(() =>
			engine.tool("bad", { steps: [{ call: "github.bogus" }] } as any),
		).toThrow(ScriptValidationError);
	});

	it("session externals compile; a missing one fails pointedly at call time", async () => {
		const { listIssues } = makeTools();
		const engine = scriptEngine({ tools: [listIssues] });
		const summarize = engine.tool("session.summarize", {
			steps: [{ id: "s", let: "issues.length" }],
		} as any);
		expect(summarize.external).toEqual(["issues"]);

		// Bare call: no session, no `issues` - refused before anything runs.
		expect(() => summarize.execute()).toThrow(/Unknown reference "issues"/);

		// In a scope whose session has it, the same call just works.
		const scope = engine.scope();
		await engine.run(
			{
				script: {
					steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
				},
			},
			scope,
		);
		await expect(summarize.execute(undefined, { scope })).resolves.toBe(3);
	});

	it("a return gate throws EarlyReturnSignal; re-calling in the scope resumes", async () => {
		const { listIssues, closeIssue, calls } = makeTools();
		const engine = scriptEngine({ tools: [listIssues, closeIssue] });
		const closeStale = engine.tool("github.closeStale", staleScript);
		const scope = engine.scope();

		const gate = await closeStale.execute({}, { scope }).then(
			() => {
				throw new Error("expected the gate to fire");
			},
			(thrown) => thrown,
		);
		expect(gate).toBeInstanceOf(EarlyReturnSignal);
		expect((gate as EarlyReturnSignal).value).toEqual({ confirm: [1, 3] });

		const result = await closeStale.execute({ approved: true }, { scope });
		expect(result).toEqual({ closed: [1, 3] });
		expect(calls()).toBe(1); // the list step was reused, not re-fetched
	});

	it("a suspension throws SuspendSignal; the answer resumes through input", async () => {
		const verify = tool({
			name: "otp.verify",
			execute: (args: { code?: string }) => {
				if (args.code === undefined) throw suspend({ key: "otp" });
				return { ok: args.code === "42" };
			},
		});
		const engine = scriptEngine({ tools: [verify] });
		const check = engine.tool("otp.check", {
			steps: [{ id: "r", call: "otp.verify", args: { code: "=input.code" } }],
		} as any);
		const scope = engine.scope();

		await expect(check.execute({}, { scope })).rejects.toThrow(SuspendSignal);
		await expect(check.execute({ code: "42" }, { scope })).resolves.toEqual({
			ok: true,
		});
	});

	it("mounts as a TOOL of another engine - and its gate ends the hosting run", async () => {
		const { listIssues, closeIssue, calls } = makeTools();
		const inner = scriptEngine({ tools: [listIssues, closeIssue] });
		const closeStale = inner.tool("github.closeStale", staleScript);

		const notify = tool({
			name: "slack.notify",
			execute: (args: { text: string }) => ({ sent: args.text }),
		});
		const outer = scriptEngine({ tools: [closeStale, notify] });
		expect(outer.tools).toContain("github.closeStale");

		const outerScript = outer.script({
			steps: [
				{
					id: "closed",
					call: "github.closeStale",
					args: { approved: "=input.approved" },
				},
				{
					id: "note",
					call: "slack.notify",
					args: { text: "=`closed ${closed.closed.length}`" },
				},
			],
		});
		const scope = outer.scope();

		// The INNER gate fires - the OUTER run ends early with its payload.
		const first = await outer.run({ script: outerScript }, scope);
		expect(first.status).toBe("ok");
		if (first.status === "ok") {
			expect(first.returnedAt).toBe("closed");
			expect(first.output).toEqual({ confirm: [1, 3] });
		}

		// Approve: the shared scope carries BOTH sessions - the inner run
		// reuses its settled list step, the outer continues past the gate.
		const second = await outer.run(
			{ script: outerScript, input: { approved: true } },
			scope,
		);
		expect(second.status).toBe("ok");
		if (second.status === "ok") {
			expect(second.output).toEqual({ sent: "closed 2" });
		}
		expect(calls()).toBe(1);
	});
});

describe("typed script authoring", () => {
	const { listIssues, closeIssue } = makeTools();
	const engine = scriptEngine({ tools: [listIssues, closeIssue] });

	it("engine.script validates and normalizes a typed literal", () => {
		const script = engine.script({
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{
					id: "close",
					call: "issues.close",
					each: "issues.map(i => ({ repo: 'api', number: i.number }))",
					max: 5,
				},
			],
		});
		expect(script.intent).toBeDefined();
		expect(script.steps).toHaveLength(2);
	});

	it("types an authoring arrow's scope from earlier CALL steps", () => {
		type Issue = { number: number; title: string; stale: boolean };
		const typeOnly = () => {
			engine.script({
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{
						id: "stale",
						let: ({ issues }) => {
							expectTypeOf(issues).toEqualTypeOf<Issue[]>();
							return issues.filter((i) => i.stale);
						},
					},
					{
						id: "close",
						call: "issues.close",
						// args expression positions see the same scope
						args: { repo: "api", number: ({ issues }) => issues[0]!.number },
					},
					{
						id: "note",
						// a call step's binding survives intervening let steps;
						// a let step's own emit is `any` (not inferable - see typed.ts)
						let: ({ close, stale }) => {
							expectTypeOf(close).toEqualTypeOf<{ closed: number }>();
							expectTypeOf(stale).toBeAny();
							return close.closed;
						},
					},
				],
				output: ({ issues }) => {
					expectTypeOf(issues).toEqualTypeOf<Issue[]>();
					return issues.length;
				},
			});

			// session names no step produces stay open (any), so cross-run
			// reads keep working untyped
			engine.script({
				steps: [{ id: "note", let: ({ user, ghosts }) => user.name + ghosts }],
			});

			// engine.tool gets the same scope typing
			engine.tool("issues.audit", {
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{
						id: "titles",
						let: ({ issues }) => {
							expectTypeOf(issues).toEqualTypeOf<Issue[]>();
							return issues.map((i) => i.title);
						},
					},
				],
			});
		};
		expect(typeOnly).toBeInstanceOf(Function);
	});

	it("rejects reads a call-step binding cannot satisfy at the TYPE level", () => {
		const typeOnly = () => {
			engine.script({
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{
						id: "bad",
						// @ts-expect-error - `issues` is Issue[]: .bogus does not exist
						let: ({ issues }) => issues.bogus,
					},
				],
			});
			engine.script({
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					// @ts-expect-error - `number` wants a number, .title is a string
					{
						id: "bad",
						call: "issues.close",
						args: { repo: "api", number: ({ issues }) => issues[0]!.title },
					},
				],
			});
		};
		expect(typeOnly).toBeInstanceOf(Function);
	});

	it("rejects unknown tools and wrong arg shapes at the TYPE level", () => {
		const typeOnly = () => {
			engine.script({
				steps: [
					// @ts-expect-error - "github.bogus" is not a mounted tool name
					{ call: "github.bogus" },
				],
			});
			engine.script({
				steps: [
					// @ts-expect-error - `number` takes a number or an "=expr" string
					{ call: "issues.close", args: { repo: "api", number: "two" } },
				],
			});
			engine.script({
				steps: [
					// @ts-expect-error - `issues.close` requires args
					{ call: "issues.close" },
				],
			});
		};
		expect(typeOnly).toBeInstanceOf(Function);
	});
});
