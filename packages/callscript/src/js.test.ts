import { describe, expect, it } from "vitest";
import { callscript } from "./engine";
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

describe("destructuring", () => {
	// the dominant model spelling for "read fields off a result": every
	// pattern desugars into the let steps the author could have written,
	// so the plan format, validation, and reconciliation see nothing new

	it("an object pattern on a call result reads fields off the minted call step", () => {
		const script = parseJsScript(`
			const { items, total } = await github.listIssues({ repo: "api" });
			return { n: items.length, total };
		`);
		expect(script.steps).toEqual([
			{ id: "s1", call: "github.listIssues", args: { repo: "api" } },
			{ id: "items", let: "s1.items" },
			{ id: "total", let: "s1.total" },
		]);
		expect(script.output).toBe("{ n: items.length, total }");
	});

	it("renames, defaults, nesting, string keys, and object rest", () => {
		const script = parseJsScript(`
			const res = await github.listIssues({ repo: "api" });
			const { items: list = [], meta: { page = 1 }, "x-total": total, ...rest } = res;
		`);
		expect(script.steps.slice(1)).toEqual([
			{ id: "list", let: "res.items === undefined ? ([]) : res.items" },
			{ id: "page", let: "res.meta.page === undefined ? (1) : res.meta.page" },
			{ id: "total", let: 'res["x-total"]' },
			{
				id: "rest",
				let: 'Object.fromEntries(Object.entries(res).filter(e => e[0] !== "items" && e[0] !== "meta" && e[0] !== "x-total"))',
			},
		]);
	});

	it("array patterns: index reads, holes skip, rest slices", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			const [first, , third, ...others] = issues;
		`);
		expect(script.steps.slice(1)).toEqual([
			{ id: "first", let: "issues[0]" },
			{ id: "third", let: "issues[2]" },
			{ id: "others", let: "issues.slice(3)" },
		]);
	});

	it("a nested pattern under a default reads from one minted id", () => {
		const script = parseJsScript(`
			const res = await github.listIssues({ repo: "api" });
			const { meta: { page } = { page: 0 } } = res;
		`);
		expect(script.steps.slice(1)).toEqual([
			{ id: "s1", let: "res.meta === undefined ? ({ page: 0 }) : res.meta" },
			{ id: "page", let: "s1.page" },
		]);
	});

	it("a path source is read directly; anything else is derived once", () => {
		const script = parseJsScript(`
			const res = await github.listIssues({ repo: "api" });
			const { total } = res.meta;
			const { length } = res.items.filter(i => i.stale);
		`);
		expect(script.steps.slice(1)).toEqual([
			{ id: "total", let: "res.meta.total" },
			{ id: "s1", let: "res.items.filter(i => i.stale)" },
			{ id: "length", let: "s1.length" },
		]);
	});

	it("inside try, the fields exist only when the call succeeded", () => {
		const script = parseJsScript(`
			try {
				const { closed } = await github.closeIssue({ number: 7 });
				const msg = \`closed \${closed}\`;
			} catch (e) {
				await slack.post({ text: e.message });
			}
		`);
		const [call, closed, msg, failed] = script.steps as [
			CallStep,
			LetStep,
			LetStep,
			CallStep,
		];
		expect(call).toEqual({
			id: "s1",
			call: "github.closeIssue",
			args: { number: 7 },
			onError: "skip",
		});
		expect(closed).toEqual({
			id: "closed",
			let: "s1.closed",
			if: "!($errors.s1)",
		});
		expect(msg).toEqual({
			id: "msg",
			let: "`closed ${closed}`",
			if: "!($errors.s1)",
		});
		expect(failed.if).toBe("$errors.s1");
		expect(failed.args).toEqual({ text: "=$errors.s1.message" });
	});

	it("a nested pattern in a Promise.all tuple reads off its own call", () => {
		const script = parseJsScript(`
			const [{ closed }, posted] = await Promise.all([
				github.closeIssue({ number: 7 }),
				slack.post({ text: "hi" }),
			]);
		`);
		expect(script.steps).toEqual([
			{ id: "s1", call: "github.closeIssue", args: { number: 7 } },
			{ id: "posted", call: "slack.post", args: { text: "hi" } },
			{ id: "closed", let: "s1.closed" },
		]);
	});

	it("minted ids never collide with names bound deep in a pattern", () => {
		const script = parseJsScript(`
			const { a: { s1 } } = await github.getThing({});
		`);
		expect(script.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
	});

	it("runs end to end through the engine", async () => {
		const listIssues = tool({
			name: "github.listIssues",
			execute: () => ({
				items: [{ number: 1 }, { number: 2 }, { number: 3 }],
				meta: { total: 3 },
			}),
		});
		const engine = callscript({ tools: [listIssues] });
		const result = await engine.run({
			script: `
				const { items, meta: { total, page = 1 }, missing = "none" } = await github.listIssues({});
				const [head, ...tail] = items;
				return { head, tail: tail.length, total, page, missing };
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({
				head: { number: 1 },
				tail: 2,
				total: 3,
				page: 1,
				missing: "none",
			});
		}
	});

	it("computed keys, forbidden keys, and destructured detached calls stay rejected", () => {
		expect(
			issuesOf(() =>
				parseJsScript(`
					const res = await github.listIssues({});
					const { [key]: v } = res;
				`),
			)[0],
		).toMatch(/computed key/);
		expect(
			issuesOf(() =>
				parseJsScript(`
					const res = await github.listIssues({});
					const { constructor } = res;
				`),
			)[0],
		).toMatch(/constructor/);
		expect(
			issuesOf(() =>
				parseJsScript(`const { id } = svc.export({});`, {
					tools: ["svc.export"],
				}),
			)[0],
		).toMatch(/detached call to one name/);
	});
});

describe("for..of bodies", () => {
	// a for..of IS Promise.all(list.map(...)), so its body may carry what
	// a map arrow can express - and nothing more

	it("an if guard around the call filters the list", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			for (const i of issues.slice(0, 10)) {
				if (i.stale) await github.closeIssue({ number: i.number });
			}
		`);
		expect(script.steps[1]).toEqual({
			id: "s1",
			call: "github.closeIssue",
			each: "(issues.slice(0, 10)).filter((i) => (i.stale)).map((i) => ({ number: i.number }))",
			max: 10,
		});
	});

	it("`if (cond) continue` skips items; local consts inline into the call", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			for (const i of issues) {
				const n = i.number;
				const doubled = n * 2;
				if (!i.stale) continue;
				await github.closeIssue({ number: doubled, tag: \`#\${n}\` });
			}
		`);
		expect((script.steps[1] as CallStep).each).toBe(
			"(issues).filter((i) => (!(!i.stale))).map((i) => ({ number: ((i.number) * 2), tag: `#${(i.number)}` }))",
		);
	});

	it("a guarded block may hold locals before its call; a bound call is fine", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			for (const i of issues) {
				if (i.stale) {
					const label = \`#\${i.number}\`;
					const r = await slack.post({ text: label });
				}
			}
		`);
		expect((script.steps[1] as CallStep).each).toBe(
			"(issues).filter((i) => (i.stale)).map((i) => ({ text: (`#${i.number}`) }))",
		);
	});

	it("runs end to end: only the guarded items dispatch, locals resolve", async () => {
		const closed: number[] = [];
		const listIssues = tool({
			name: "github.listIssues",
			execute: () => [
				{ number: 1, stale: true },
				{ number: 2, stale: false },
				{ number: 3, stale: true },
			],
		});
		const closeIssue = tool({
			name: "github.closeIssue",
			execute: (args: { number: number }) => {
				closed.push(args.number);
				return { closed: args.number };
			},
		});
		const engine = callscript({ tools: [listIssues, closeIssue] });
		const result = await engine.run({
			script: `
				const issues = await github.listIssues({});
				for (const i of issues) {
					const n = i.number;
					if (!i.stale) continue;
					await github.closeIssue({ number: n * 10 });
				}
			`,
		});
		expect(result.status).toBe("ok");
		expect(closed.sort()).toEqual([10, 30]);
	});

	it("a real loop body stays rejected with the fan-out spelling", () => {
		const message = /one awaited tool call.*Promise\.all\(list\.map/;
		expect(
			issuesOf(() =>
				parseJsScript(`
					for (const i of issues) {
						await github.closeIssue({ number: i.number });
						await slack.post({ text: "closed" });
					}
				`),
			)[0],
		).toMatch(message);
		expect(
			issuesOf(() =>
				parseJsScript(`
					for (const i of issues) {
						if (i.stale) await github.closeIssue({ number: i.number });
						else await slack.post({ text: "kept" });
					}
				`),
			)[0],
		).toMatch(message);
		expect(
			issuesOf(() =>
				parseJsScript(`
					for (const i of issues) {
						if (i.stale) return { first: i };
					}
				`),
			)[0],
		).toMatch(message);
	});
});

describe("await hoisting", () => {
	// an awaited call nested in an expression compiles into its own step
	// first, and the expression reads the step - the plan the author gets
	// by binding it, without the retry that used to demand the binding

	it("`return { x: await tool() }` hoists the call and projects its id", () => {
		const script = parseJsScript(`
			return { issues: await github.listIssues({ repo: "api" }), n: 1 };
		`);
		expect(script.steps).toEqual([
			{ id: "s1", call: "github.listIssues", args: { repo: "api" } },
		]);
		expect(script.output).toBe("{ issues: s1, n: 1 }");
	});

	it("an await inside a call's arguments hoists ahead of the call", () => {
		const script = parseJsScript(`
			const closed = await github.closeIssue({
				number: (await github.getIssue({ n: 1 })).number,
			});
		`);
		expect(script.steps).toEqual([
			{ id: "s1", call: "github.getIssue", args: { n: 1 } },
			{
				id: "closed",
				call: "github.closeIssue",
				args: { number: "=(s1).number" },
			},
		]);
	});

	it("several awaits hoist in source order and chain like statements", () => {
		const script = parseJsScript(`
			const total = (await a.count({})) + (await b.count({}));
			await slack.post({ text: total });
		`);
		const [first, second, total, post] = script.steps as [
			CallStep,
			CallStep,
			LetStep,
			CallStep,
		];
		expect(first).toEqual({ id: "s1", call: "a.count", args: {} });
		expect(second).toEqual({
			id: "s2",
			call: "b.count",
			args: {},
			after: ["s1"],
		});
		expect(total).toEqual({ id: "total", let: "(s1) + (s2)" });
		// the post reads total, which closes over both calls - no after edge
		expect(post.after).toBeUndefined();
	});

	it("hoists inside guards and catch blocks, renames intact", () => {
		const script = parseJsScript(`
			try {
				const closed = await github.closeIssue({ number: 1 });
			} catch (e) {
				const report = { text: e.message, sent: await slack.post({ text: e.message }) };
			}
		`);
		const [, post, report] = script.steps as [CallStep, CallStep, LetStep];
		expect(post).toMatchObject({
			id: "s1",
			call: "slack.post",
			args: { text: "=$errors.closed.message" },
			if: "$errors.closed",
		});
		expect(report).toEqual({
			id: "report",
			let: "{ text: $errors.closed.message, sent: s1 }",
			if: "$errors.closed",
		});
	});

	it("runs end to end through the engine", async () => {
		const listIssues = tool({
			name: "github.listIssues",
			execute: (args: { repo: string }) => [
				{ number: 1, repo: args.repo },
				{ number: 2, repo: args.repo },
			],
		});
		const engine = callscript({ tools: [listIssues] });
		const result = await engine.run({
			script: `
				const n = (await github.listIssues({ repo: "api" })).length;
				return { n, again: (await github.listIssues({ repo: "web" })).map(i => i.repo) };
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ n: 2, again: ["web", "web"] });
		}
	});

	it("a nested Promise.all and an await on a non-call stay rejected", () => {
		expect(
			issuesOf(() =>
				parseJsScript(`
					return { closed: await Promise.all(xs.map(x => t.close({ x }))) };
				`),
			)[0],
		).toMatch(/bind a fan-out first/);
		expect(
			issuesOf(() => parseJsScript(`return { v: (await job) + 1 };`))[0],
		).toMatch(/await belongs directly on a tool call/);
	});
});

describe("conditional assignment", () => {
	// `let x = a; if (cond) x = b;` is one derivation - the same plan as
	// `const x = cond ? b : a`, without the retry over reassignment

	it("`let x = a; if (c) x = b` becomes a conditional let", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			let label = "none";
			if (issues.length > 0) label = "some";
			return label;
		`);
		expect(script.steps[1]).toEqual({
			id: "label",
			let: '(issues.length > 0) ? ("some") : ("none")',
		});
		expect(script.output).toBe("label");
	});

	it("else branches, block bodies, and a dead initializer", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			let tone;
			if (issues.length > 5) { tone = "busy"; } else { tone = "calm"; }
			let first = null;
			if (issues.length > 0) first = issues[0];
			await slack.post({ text: \`\${tone}: \${first?.title ?? "-"}\` });
		`);
		expect(script.steps.slice(1, 3)).toEqual([
			{ id: "tone", let: '(issues.length > 5) ? ("busy") : ("calm")' },
			{ id: "first", let: "(issues.length > 0) ? (issues[0]) : (null)" },
		]);
		expect((script.steps[3] as CallStep).after).toBeUndefined();
	});

	it("inherits the enclosing guard", () => {
		const script = parseJsScript(`
			const issues = await github.listIssues({ repo: "api" });
			if (issues.length > 0) {
				let n = 0;
				if (issues[0].stale) n = 1;
				await slack.post({ text: n });
			}
		`);
		expect(script.steps[1]).toEqual({
			id: "n",
			let: "(issues[0].stale) ? (1) : (0)",
			if: "issues.length > 0",
		});
	});

	it("runs end to end through the engine", async () => {
		const listIssues = tool({
			name: "github.listIssues",
			execute: () => [{ number: 1 }, { number: 2 }],
		});
		const engine = callscript({ tools: [listIssues] });
		const result = await engine.run({
			script: `
				const issues = await github.listIssues({});
				let label = "none";
				if (issues.length > 1) label = "many";
				let first;
				if (issues.length > 0) first = issues[0].number; else first = -1;
				return { label, first };
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ label: "many", first: 1 });
		}
	});

	it("stays narrow: else-if chains, awaits in a branch, and other work keep the reassignment message", () => {
		const reassign = /single-assignment/;
		expect(
			issuesOf(() =>
				parseJsScript(`
					let label = "none";
					if (a) label = "x"; else if (b) label = "y";
				`),
			).join("\n"),
		).toMatch(reassign);
		expect(
			issuesOf(() =>
				parseJsScript(`
					let r = null;
					if (a) r = await t.fetch({});
				`),
			).join("\n"),
		).toMatch(reassign);
		expect(
			issuesOf(() =>
				parseJsScript(`
					let n = 0;
					if (a) { n = 1; await t.ping({}); }
				`),
			).join("\n"),
		).toMatch(reassign);
	});
});

describe("wrappers", () => {
	// a model picturing a module wraps top-level await; the body is the
	// script, so it compiles as the program

	it("an async IIFE unwraps: body statements, return as output, comment as intent", () => {
		for (const src of [
			`
				// close stale issues
				(async () => {
					const issues = await github.listIssues({ repo: "api" });
					return { n: issues.length };
				})();
			`,
			`
				// close stale issues
				await (async function () {
					const issues = await github.listIssues({ repo: "api" });
					return { n: issues.length };
				})();
			`,
		]) {
			const script = parseJsScript(src);
			expect(script.intent).toBe("close stale issues");
			expect(script.steps).toEqual([
				{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
			]);
			expect(script.output).toBe("{ n: issues.length }");
		}
	});

	it("`async function main() { ... } main()` unwraps the same way", () => {
		for (const tail of ["main();", "await main();"]) {
			const script = parseJsScript(`
				async function main() {
					const issues = await github.listIssues({ repo: "api" });
					if (issues.length === 0) return { n: 0 };
					return { n: issues.length };
				}
				${tail}
			`);
			expect(script.steps.map((s) => s.id)).toEqual(["issues", "s1"]);
			expect(script.output).toBe("{ n: issues.length }");
		}
	});

	it("names inside the wrapper still reserve their ids", () => {
		const script = parseJsScript(`
			(async () => {
				const s1 = await t.a({});
				return { x: await t.b({}) };
			})();
		`);
		expect(script.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("runs end to end through the engine", async () => {
		const listIssues = tool({
			name: "github.listIssues",
			execute: () => [{ number: 1 }, { number: 2 }],
		});
		const engine = callscript({ tools: [listIssues] });
		const result = await engine.run({
			script: `
				async function main() {
					const issues = await github.listIssues({});
					return { n: issues.length };
				}
				main();
			`,
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.output).toEqual({ n: 2 });
	});

	it("a .catch on the wrapper, or a main() not called plainly, is rejected with the reason", () => {
		expect(
			issuesOf(() =>
				parseJsScript(`
					(async () => {
						await github.listIssues({ repo: "api" });
					})().catch(console.error);
				`),
			).join("\n"),
		).toMatch(/drop the \.then\/\.catch/);
		expect(
			issuesOf(() =>
				parseJsScript(`
					async function main() {
						await github.listIssues({ repo: "api" });
					}
					main().catch(console.error);
				`),
			).join("\n"),
		).toMatch(/call the wrapper plainly.*main\(\)/);
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

	it("forEach names the Promise.all fan-out", () => {
		const issues = issuesOf(() =>
			parseJsScript(`
				const issues = await github.listIssues({ repo: "api" });
				issues.forEach(i => github.closeIssue({ number: i.number }));
			`),
		);
		expect(issues[0]).toMatch(
			/forEach cannot fan out.*Promise\.all\(list\.map/,
		);
	});

	it("console.log names the return-the-value fix", () => {
		const issues = issuesOf(() =>
			parseJsScript(`
				const issues = await github.listIssues({ repo: "api" });
				console.log(issues);
			`),
		);
		expect(issues[0]).toMatch(/console\.log has nowhere to print.*return/);
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
		const engine = callscript({ tools: [zero, boom] });
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

	it("await inside an arrow names the fan-out; inside a fan-out, the bind-first fix", () => {
		expect(
			issuesOf(() =>
				parseJsScript(`const n = xs.map(async x => await t.count({ x }));`),
			).join("\n"),
		).toMatch(/await inside an arrow.*Promise\.all\(list\.map/);
		expect(
			issuesOf(() =>
				parseJsScript(`
					const done = await Promise.all(xs.map(async x => t.close({ id: (await t.find({ x })).id })));
				`),
			).join("\n"),
		).toMatch(/fan-out's arguments cannot await.*const x = await/);
		expect(
			issuesOf(() =>
				parseJsScript(`
					for (const x of xs) {
						const found = { id: await t.find({ x }) };
						await t.close({ id: found.id });
					}
				`),
			).join("\n"),
		).toMatch(/for\.\.of body|cannot await/);
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
		const engine = callscript({ tools: [listIssues, closeIssue] });
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
		const engine = callscript({ tools: [listIssues, closeIssue] });
		const { execute } = engine.tools();
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
		const engine = callscript({
			tools: [listIssues, closeIssue],
			format: "json",
		});
		const { execute } = engine.tools();
		expect(execute.inputSchema).toMatchObject({
			properties: { steps: expect.anything() },
		});
	});
});
