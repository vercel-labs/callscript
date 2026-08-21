import { describe, expect, it } from "vitest";
import { scriptEngine } from "./engine";
import { parseJsScript } from "./js";
import { tool } from "./tool";
import type { CallStep, LetStep, ReturnStep } from "./types";
import { ScriptValidationError, validateScript } from "./validate";

/* --------------------------------- helpers -------------------------------- */

const issuesOf = (fn: () => unknown): string[] => {
	try {
		fn();
	} catch (err) {
		if (err instanceof ScriptValidationError) {
			return err.issues.map((i) => `${i.path}: ${i.message}`);
		}
		throw err;
	}
	throw new Error("expected a ScriptValidationError");
};

/* ------------------------------- compilation ------------------------------- */

describe("statement forms", () => {
	it("const + await tool call -> call step; literal and expression args split", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api", page: 1 + 1 });
		`);
		expect(script.steps).toEqual([
			{
				id: "issues",
				call: "github.listIssues",
				args: { repo: "api", page: "=1 + 1" },
			},
		]);
	});

	it("const of a pure expression -> let step", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			const stale = issues.filter(i => i.stale);
		`);
		expect(script.steps[1]).toEqual({
			id: "stale",
			let: "issues.filter(i => i.stale)",
		});
	});

	it("leading comment becomes the intent; trailing return becomes output", () => {
		const script = parseJsScript(`
			// close stale issues
			const issues = await github.listIssues({ repo: "api" });
			return { count: issues.length };
		`);
		expect(script.intent).toBe("close stale issues");
		expect(script.output).toBe("{ count: issues.length }");
	});

	it("if (cond) return value -> a guarded return step", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			if (issues.length === 0) return { closed: 0 };
		`);
		const guard = script.steps[1] as ReturnStep;
		expect(guard.if).toBe("issues.length === 0");
		expect(guard.return).toBe("{ closed: 0 }");
	});

	it("Promise.all over .map -> an each fan-out, slice(0, N) as max", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			const closed = await Promise.all(
				issues.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
		`);
		const step = script.steps[1] as CallStep;
		expect(step.call).toBe("github.closeIssue");
		expect(step.each).toBe(
			'(issues.slice(0, 10)).map((i) => ({ repo: "api", number: i.number }))',
		);
		expect(step.max).toBe(10);
		expect(step.args).toBeUndefined();
	});

	it("for..of with one awaited call also fans out", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			for (const i of issues) {
				await github.closeIssue({ number: i.number });
			}
		`);
		const step = script.steps[1] as CallStep;
		expect(step.each).toBe("(issues).map((i) => ({ number: i.number }))");
	});

	it("Promise.all tuple destructures into concurrent steps", () => {
		const script = parseJsScript(`
			const [repos, users] = await Promise.all([
				github.listRepos({}),
				github.listUsers({}),
			]);
			const summary = await slack.post({ text: repos.length + users.length });
		`);
		const [a, b, c] = script.steps as [CallStep, CallStep, CallStep];
		expect(a).toEqual({ id: "repos", call: "github.listRepos", args: {} });
		expect(b).toEqual({ id: "users", call: "github.listUsers", args: {} });
		// The next effect waits on BOTH minus data-implied edges.
		expect(c.after).toBeUndefined(); // args reference repos and users - data already orders
	});

	it("call options ride the second argument", () => {
		const script = parseJsScript(`
			await github.closeIssue({ number: 1 }, { reason: "stale", suspend: true, onError: "skip" });
		`);
		const step = script.steps[0] as CallStep;
		expect(step.reason).toBe("stale");
		expect(step.suspend).toBe(true);
		expect(step.onError).toBe("skip");
	});

	it("try/catch -> onError skip, the catch param renamed to $errors.<id>", () => {
		const script = parseJsScript(`
			try {
				const closed = await github.closeIssue({ number: 1 });
			} catch (e) {
				await slack.post({ text: \`failed: \${e.message}\` });
			}
		`);
		const [close, post] = script.steps as [CallStep, CallStep];
		expect(close.onError).toBe("skip");
		expect(post.if).toBe("$errors.closed");
		expect(post.args).toEqual({
			text: "=`failed: ${$errors.closed.message}`",
		});
	});

	it("`let r; try { r = await ... }` desugars to the canonical try/catch", () => {
		// the dominant model idiom for a fallible call: the dead binding +
		// assign-in-try compiles to exactly what the const form produces
		const canonical = parseJsScript(`
			try {
				const closed = await github.closeIssue({ number: 1 });
			} catch (e) {
				await slack.post({ text: e.message });
			}
			return { closed };
		`);
		for (const init of ["", " = null", " = undefined"]) {
			const sugared = parseJsScript(`
				let closed${init};
				try {
					closed = await github.closeIssue({ number: 1 });
				} catch (e) {
					await slack.post({ text: e.message });
				}
				return { closed };
			`);
			expect(sugared.steps).toEqual(canonical.steps);
		}
	});

	it("`return await tool(...)` desugars to a call step + return of it", () => {
		// top-level: the call binds to a minted id, the output hands it back
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			return await slack.post({ text: "done" });
		`);
		const post = script.steps[1] as CallStep;
		expect(post.call).toBe("slack.post");
		expect(script.output).toBe(post.id);
		// guarded: the call inherits the guard, the return gates on it
		const guarded = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			if (issues.length === 0) return await slack.post({ text: "empty" });
			return { n: issues.length };
		`);
		const [, gCall, gReturn] = guarded.steps as [
			CallStep,
			CallStep,
			ReturnStep,
		];
		expect(gCall.call).toBe("slack.post");
		expect(gCall.if).toBe("issues.length === 0");
		expect(gReturn.if).toBe("issues.length === 0");
		expect(gReturn.return).toBe(gCall.id);
	});

	it("statements after the call in try run guarded on success", () => {
		// the happy-path return inside try - the dominant model idiom
		const script = parseJsScript(`
			try {
				const closed = await github.closeIssue({ number: 1 });
				return { ok: closed.closed };
			} catch (e) {
				const sent = await slack.post({ text: e.message });
				return { ok: false };
			}
		`);
		const [call, success, catchCall, catchReturn] = script.steps as [
			CallStep,
			ReturnStep,
			CallStep,
			ReturnStep,
		];
		expect(call.onError).toBe("skip");
		expect(success.if).toBe("!($errors.closed)");
		expect(success.return).toBe("{ ok: closed.closed }");
		expect(catchCall.if).toBe("$errors.closed");
		expect(catchReturn.if).toBe("$errors.closed");
		// a SECOND awaited call in the tail would not be covered by this
		// catch the way a real JS catch is - still one call per try
		expect(
			issuesOf(() =>
				parseJsScript(`
					try {
						const a = await github.closeIssue({ number: 1 });
						const b = await github.closeIssue({ number: 2 });
					} catch (e) {}
				`),
			).join(" "),
		).toContain("one tool call per try");
	});

	it("the try-assign desugar stays narrow", () => {
		// a live initializer is a real value, not the idiom - unchanged error
		expect(
			issuesOf(() =>
				parseJsScript(`
					let r = 5;
					try {
						r = await github.closeIssue({ number: 1 });
					} catch (e) {}
					return { r };
				`),
			).join(" "),
		).toContain("a try block starts with its one awaited tool call");
		// assigning the SAME name in catch too is a merge - still rejected
		expect(
			issuesOf(() =>
				parseJsScript(`
					let r;
					try {
						r = await github.closeIssue({ number: 1 });
					} catch (e) {
						r = await github.closeIssue({ number: 2 });
					}
					return { r };
				`),
			).join(" "),
		).toContain("single-assignment");
		// plain reassignment outside a try never desugars
		expect(
			issuesOf(() =>
				parseJsScript(`
					let r = 1;
					r = 2;
					return { r };
				`),
			).join(" "),
		).toContain("single-assignment");
	});

	it("if/else applies the condition (negated for else) to inner steps", () => {
		const script = parseJsScript(`
			const user = await auth.whoami({});
			if (user.admin) {
				await audit.log({ who: user.id });
			} else {
				await slack.post({ text: "not admin" });
			}
		`);
		const [, thenStep, elseStep] = script.steps as [
			CallStep,
			CallStep,
			CallStep,
		];
		expect(thenStep.if).toBe("user.admin");
		expect(elseStep.if).toBe("!(user.admin)");
	});

	it("un-awaited mounted tool call detaches; await job joins", () => {
		const script = parseJsScript(
			`
			const job = svc.export({ kind: "csv" });
			const done = await job;
		`,
			{ tools: ["svc.export"] },
		);
		const [detached, join] = script.steps as [CallStep, CallStep];
		expect(detached).toMatchObject({
			id: "job",
			call: "svc.export",
			await: false,
		});
		expect(join).toMatchObject({ id: "done", call: "await.job" });
	});

	it("without the registry, an un-awaited call compiles as a let", () => {
		const script = parseJsScript(`
			const stale = issues.filter(i => i.stale);
		`);
		expect((script.steps[0] as LetStep).let).toBe(
			"issues.filter(i => i.stale)",
		);
	});
});

describe("effect ordering", () => {
	it("sequential awaited calls chain via after; data edges suppress it", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			const closed = await github.closeIssue({ number: issues[0].number });
			const posted = await slack.post({ text: "done" });
		`);
		const [, close, post] = script.steps as [CallStep, CallStep, CallStep];
		// close reads issues - the data edge already orders it.
		expect(close.after).toBeUndefined();
		// post reads nothing of close - the JS statement order becomes an edge.
		expect(post.after).toEqual(["closed"]);
	});

	it("a data edge THROUGH a derivation also suppresses the chain", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			const stale = issues.filter(i => i.stale);
			const closed = await Promise.all(
				stale.map(i => github.closeIssue({ number: i.number })));
		`);
		// closed -> stale -> issues already orders it; no after edge.
		expect((script.steps[2] as CallStep).after).toBeUndefined();
	});

	it("Promise.all elements do not chain against each other", () => {
		const script = parseJsScript(`
			const first = await slack.post({ text: "one" });
			const [a, b] = await Promise.all([svc.one({}), svc.two({})]);
			const last = await slack.post({ text: "two" });
		`);
		const [, a, b, last] = script.steps as [
			CallStep,
			CallStep,
			CallStep,
			CallStep,
		];
		expect(a.after).toEqual(["first"]);
		expect(b.after).toEqual(["first"]);
		expect(last.after?.sort()).toEqual(["a", "b"]);
	});

	it("a detached call takes the edge but never becomes the frontier", () => {
		const script = parseJsScript(
			`
			const posted = await slack.post({ text: "hi" });
			const job = svc.export({});
			const after = await slack.post({ text: "bye" });
		`,
			{ tools: ["svc.export", "slack.post"] },
		);
		const [, job, last] = script.steps as [CallStep, CallStep, CallStep];
		expect(job.await).toBe(false);
		expect(job.after).toEqual(["posted"]);
		expect(last.after).toEqual(["posted"]);
	});
});

describe("teaching rejections", () => {
	it("while loops name the fan-out spelling", () => {
		const [msg] = issuesOf(() => parseJsScript(`while (true) { }`));
		expect(msg).toContain("Promise.all");
	});

	it("reassignment names single-assignment", () => {
		const issues = issuesOf(() => parseJsScript(`const a = 1;\na = 2;`));
		expect(issues.join("\n")).toContain("single-assignment");
	});

	it("a guard may return a falsy value - JS semantics exactly", async () => {
		const zero = tool({
			name: "t.count",
			execute: () => ({ n: 0 }),
		});
		const boom = tool({
			name: "t.boom",
			execute: () => {
				throw new Error("must not run");
			},
		});
		const engine = scriptEngine({ tools: [zero, boom] });
		const result = await engine.run({
			script: `
				const c = await t.count({});
				if (c.n === 0) return null;
				await t.boom({});
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toBe(null);
			expect(result.returnedAt).toBeDefined();
		}
	});

	it("await deep in an expression names the bind-first fix", () => {
		const issues = issuesOf(() =>
			parseJsScript(`const n = (await t.count({})) + 1;`),
		);
		expect(issues.join("\n")).toContain("bind it first");
	});

	it("issues carry source lines", () => {
		const issues = issuesOf(() =>
			parseJsScript(`const a = 1;\nwhile (true) { }`),
		);
		expect(issues[0]).toMatch(/^line 2:/);
	});

	it("unparseable JS reports the parse error", () => {
		const issues = issuesOf(() => parseJsScript(`const = ;`));
		expect(issues[0]).toContain("Not parseable as JavaScript");
	});

	it("banned expression syntax surfaces the expression grammar's message", () => {
		const issues = issuesOf(() => parseJsScript(`const s = new Set([1, 2]);`));
		expect(issues.join("\n")).toContain("filter");
	});
});

describe("through validateScript and the engine", () => {
	const listIssues = tool({
		name: "github.listIssues",
		execute: (args: { repo: string }) => [
			{ number: 1, stale: true, repo: args.repo },
			{ number: 2, stale: false, repo: args.repo },
			{ number: 3, stale: true, repo: args.repo },
		],
	});
	const closeIssue = tool({
		name: "github.closeIssue",
		execute: (args: { repo: string; number: number }) => ({
			closed: args.number,
		}),
	});

	it("validateScript accepts JS text directly", () => {
		const script = validateScript(
			`const issues = await github.listIssues({ repo: "api" });`,
			{ tools: ["github.listIssues"] },
		);
		expect(script.steps[0]).toMatchObject({
			id: "issues",
			call: "github.listIssues",
		});
	});

	it("engine.run executes a JS-surface script end to end", async () => {
		const engine = scriptEngine({ tools: [listIssues, closeIssue] });
		const result = await engine.run({
			script: `
				// close stale issues
				const issues = await github.listIssues({ repo: "api" });
				const stale = issues.filter(i => i.stale);
				if (stale.length === 0) return { closed: 0 };
				const closed = await Promise.all(
					stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
				return { count: closed.length, numbers: closed.map(c => c.closed) };
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ count: 2, numbers: [1, 3] });
		}
	});

	it("the js agent tool pair unwraps { script } and reports issues for retry", async () => {
		const engine = scriptEngine({ tools: [listIssues, closeIssue] });
		const { execute } = engine.agentTools();
		expect(execute.inputSchema).toMatchObject({
			type: "object",
			required: ["script"],
		});
		expect(execute.description).toContain("plain\nJavaScript");

		const ok = await execute.execute({
			script: `const issues = await github.listIssues({ repo: "api" });
				return { n: issues.length };`,
		});
		expect(ok).toMatchObject({ status: "ok", output: { n: 3 } });

		const invalid = await execute.execute({
			script: `while (true) { await github.listIssues({ repo: "api" }); }`,
		});
		expect(invalid.status).toBe("invalid");
		if (invalid.status === "invalid") {
			expect(invalid.issues[0]).toContain("Promise.all");
		}
	});

	it("format: 'json' keeps the JSON teaching surface", () => {
		const engine = scriptEngine({
			tools: [listIssues, closeIssue],
			format: "json",
		});
		const { execute } = engine.agentTools();
		expect(execute.inputSchema).toMatchObject({
			properties: { steps: expect.anything() },
		});
	});
});
