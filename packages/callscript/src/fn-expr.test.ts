import { describe, expect, it } from "vitest";
import { scriptEngine } from "./engine";
import { fnToExpr } from "./fn-expr";
import { tool } from "./tool";
import { ScriptValidationError } from "./validate";

/* ------------------------------- fixtures -------------------------------- */

const listIssues = tool({
	name: "issues.list",
	execute: (_args: { repo: string }) => [
		{ number: 1, title: "old bug", stale: true },
		{ number: 2, title: "fresh bug", stale: false },
		{ number: 3, title: "old chore", stale: true },
	],
});

const closeIssue = tool({
	name: "issues.close",
	execute: (args: { repo: string; number: number }) => ({
		closed: args.number,
	}),
});

const engine = scriptEngine({ tools: [listIssues, closeIssue] });

/* ------------------------------- transpile -------------------------------- */

describe("fnToExpr", () => {
	it("transpiles the body, dropping the destructuring parameter", () => {
		expect(
			fnToExpr(({ issues }) => issues.filter((i: any) => i.stale), "t"),
		).toBe("issues.filter((i) => i.stale)");
	});

	it("keeps parenthesized object bodies re-parseable", () => {
		const expr = fnToExpr(({ stale }) => ({ closed: stale.length }), "t");
		expect(expr).toBe("({ closed: stale.length })");
	});

	it("zero-parameter arrows work", () => {
		expect(fnToExpr(() => 42, "t")).toBe("42");
	});

	it("REJECTS a captured variable - closures never cross", () => {
		const limit = 5;
		expect(() => fnToExpr(({ issues }) => issues.slice(0, limit), "t")).toThrow(
			/"limit" is not in the expression's scope/,
		);
	});

	it("rejects reading a name the parameter did not destructure", () => {
		expect(() =>
			fnToExpr(({ issues }) => issues.slice(0, (input as any).n), "t"),
		).toThrow(ScriptValidationError);
	});

	it("rejects an identifier parameter with the destructuring hint", () => {
		expect(() => fnToExpr((c: any) => c.issues, "t")).toThrow(/destructure/);
	});

	it("aliased destructuring rewrites back to the env name", () => {
		// Authors may alias, and transpilers rename shadowed bindings
		// (esbuild: `({ input })` -> `({ input: input2 })`) - the KEY is the
		// env name, so alias references rewrite back to it.
		expect(fnToExpr(({ issues: list }: any) => list.length, "t")).toBe(
			"issues.length",
		);
		// An inner arrow REBINDING the alias is left alone (the transpiler
		// may rename the inner binding - either way, `\1` proves it stays
		// self-consistent and the outer alias did not leak in).
		expect(
			fnToExpr(
				({ issues: list }: any) => list.map((list: any) => list.id),
				"t",
			),
		).toMatch(/^issues\.map\(\((\w+)\) => \1\.id\)$/);
	});

	it("rejects defaults, nesting, and rest in the parameter", () => {
		expect(() => fnToExpr(({ issues = [] }: any) => issues, "t")).toThrow(
			ScriptValidationError,
		);
	});

	it("rejects block bodies and statements", () => {
		expect(() =>
			fnToExpr(({ xs }) => {
				return xs.length;
			}, "t"),
		).toThrow(/block body/);
	});

	it("rejects non-arrow functions", () => {
		expect(() =>
			fnToExpr(function named({ xs }: any) {
				return xs;
			}, "t"),
		).toThrow(ScriptValidationError);
	});
});

/* ----------------------------- through the doors -------------------------- */

// `input` exists at runtime but the parameter is the WHOLE contract - it
// must be destructured like everything else (declared here for the
// capture-rejection test above, where it is NOT a parameter name).
declare const input: unknown;

describe("arrows in scripts", () => {
	it("let / each / args / return arrows run end to end", async () => {
		const result = await engine.run({
			script: engine.script({
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{
						id: "stale",
						let: ({ issues }) => issues.filter((i: any) => i.stale),
					},
					{
						id: "close",
						call: "issues.close",
						each: ({ stale }) =>
							stale.map((issue: any) => ({
								repo: "api",
								number: issue.number,
							})),
						max: 10,
						return: ({ input, $calls }) =>
							!input.approved && { confirm: $calls.length },
					},
					{ id: "out", let: ({ stale }) => ({ closed: stale.length }) },
				],
			}),
			input: { approved: true },
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.output).toEqual({ closed: 2 });
	});

	it("the gate arrow fires like its string twin", async () => {
		const script = engine.script({
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{
					id: "close",
					call: "issues.close",
					each: ({ issues }) =>
						issues.map((issue: any) => ({ repo: "api", number: issue.number })),
					max: 10,
					return: ({ input, $calls }) =>
						!input.approved && {
							confirm: $calls.map((c: any) => c.args.number),
						},
				},
			],
		});
		const gated = await engine.run({ script });
		expect(gated.status).toBe("ok");
		if (gated.status === "ok") {
			expect(gated.returnedAt).toBe("close");
			expect(gated.output).toEqual({ confirm: [1, 2, 3] });
		}
	});

	it("output and if arrows normalize too", async () => {
		const script = engine.script({
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{
					id: "note",
					if: ({ issues }) => issues.length > 0,
					let: ({ issues }) => `${issues.length} issues`,
				},
			],
			output: ({ note }) => ({ note }),
		});
		const result = await engine.run({ script });
		expect(result.status).toBe("ok");
		if (result.status === "ok")
			expect(result.output).toEqual({ note: "3 issues" });
	});

	it("the normalized script is pure data - no functions survive", () => {
		const script = engine.script({
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{
					id: "stale",
					let: ({ issues }) => issues.filter((i: any) => i.stale),
				},
			],
		});
		expect(typeof (script.steps[1] as { let: unknown }).let).toBe("string");
		expect(JSON.parse(JSON.stringify(script))).toEqual(script);
	});

	it("a capture inside a script reports the step's path", () => {
		const max = 2;
		expect(() =>
			engine.script({
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{ id: "top", let: ({ issues }) => issues.slice(0, max) },
				],
			}),
		).toThrow(/steps\[1\]\.let.*"max" is not in the expression's scope/s);
	});

	it("engine.tool compiles arrow-authored scripts", async () => {
		const staleNumbers = engine.tool("issues.staleNumbers", {
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{
					id: "stale",
					let: ({ issues }) =>
						issues.filter((i: any) => i.stale).map((i: any) => i.number),
				},
			],
		});
		expect((staleNumbers.script.steps[1] as { let: string }).let).toContain(
			"filter",
		);
		await expect(staleNumbers.execute()).resolves.toEqual([1, 3]);
	});
});
