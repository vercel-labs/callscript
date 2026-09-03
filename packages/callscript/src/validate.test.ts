import { describe, expect, it } from "vitest";
import {
	analyzeScript,
	renderScript,
	scriptCalls,
	scriptedTools,
} from "./analyze";
import {
	createScriptValidator,
	ScriptValidationError,
	validateScript,
} from "./validate";

const validScript = {
	intent: "Close stale issues and notify the team",
	steps: [
		{
			id: "issues",
			call: "listIssues",
			args: { owner: "acme", repo: "api", state: "open" },
			reason: "Find open issues to check for staleness",
		},
		{
			id: "stale",
			let: "issues.filter(i => Date.now() - Date.parse(i.updated_at) > 60 * 864e5).slice(0, 20)",
		},
		{
			id: "close",
			call: "closeIssue",
			each: "stale.map(issue => ({ owner: 'acme', repo: 'api', issue_number: issue.number, state: 'closed' }))",
			max: 20,
			reason: "Close issues inactive for 60+ days",
			return: "!input.approved && { confirm: $calls.length }",
			onError: "skip",
		},
		{
			id: "notify",
			if: "stale.length > 0",
			call: "postMessage",
			args: { channel: "#eng", text: "=`Closed ${stale.length} stale issues`" },
			reason: "Tell the team what was cleaned up",
		},
	],
};

function issuesOf(fn: () => unknown): string[] {
	try {
		fn();
		return [];
	} catch (err) {
		if (err instanceof ScriptValidationError) {
			return err.issues.map((i) => `${i.path}: ${i.message}`);
		}
		throw err;
	}
}

describe("validateScript", () => {
	it("accepts a valid script", () => {
		expect(() => validateScript(validScript)).not.toThrow();
	});

	it("normalizes the frictionless single-step form (no ids, no intent)", () => {
		const script = validateScript({
			steps: [
				{
					call: "gmail:GET /gmail/v1/users/{userId}/messages",
					args: { path_params: { userId: "me" } },
					reason: "find the latest message",
				},
			],
		});
		expect(script.intent).toBe("find the latest message");
		expect(script.steps[0]!.id).toBe("s1");
	});

	it("auto-assigned ids avoid collisions with explicit ones", () => {
		const script = validateScript({
			intent: "g",
			steps: [
				{ id: "s1", let: "1" },
				{ let: "s1 + 1" }, // gets s2
				{ call: "svc:GET /x", args: { v: "=s2" }, reason: "r" }, // gets s3
			],
		});
		expect(script.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("accepts any tool name by default, enforces a known-tool list when given", () => {
		expect(() =>
			validateScript({ steps: [{ call: "listIssues", reason: "r" }] }),
		).not.toThrow();

		const issues = issuesOf(() =>
			validateScript(
				{
					intent: "g",
					steps: [{ id: "a", call: "listIsues", reason: "r" }],
				},
				{ tools: ["listIssues", "closeIssue"] },
			),
		);
		expect(issues.join("\n")).toMatch(/Unknown tool "listIsues"/);
	});

	it("an unknown tool suggests the nearest mounted name", () => {
		const tools = ["github.listIssues", "github.closeIssue", "chat.post"];
		const message = (call: string) =>
			issuesOf(() =>
				validateScript({ steps: [{ call, reason: "r" }] }, { tools }),
			).join("\n");
		// a typo in the name
		expect(message("github.listIsues")).toMatch(
			/did you mean "github\.listIssues"\?/,
		);
		// the right tool under the wrong namespace
		expect(message("slack.post")).toMatch(/did you mean "chat\.post"\?/);
		// nothing close: no guess, a wrong one costs a retry too
		expect(message("deploy.rollback")).not.toMatch(/did you mean/);
		// the host's hint still rides along
		expect(
			issuesOf(() =>
				validateScript(
					{ steps: [{ call: "github.listIsues", reason: "r" }] },
					{ tools, unknownToolHint: "search for tools first" },
				),
			).join("\n"),
		).toMatch(/did you mean "github\.listIssues"\? - search for tools first/);
	});

	it("known-tool names ending in '.*' are prefix patterns", () => {
		const tools = ["shout", "github.*"];
		expect(() =>
			validateScript(
				{ steps: [{ call: "github.closeIssue", reason: "r" }] },
				{ tools },
			),
		).not.toThrow();

		// Outside the prefix, internal names, and the literal pattern all fail.
		for (const call of ["slack.send", "github.$fragment", "github.*"]) {
			const issues = issuesOf(() =>
				validateScript({ steps: [{ call, reason: "r" }] }, { tools }),
			);
			expect(issues.join("\n")).toMatch(/Unknown tool/);
		}
	});

	it("allows missing reason on call steps by default", () => {
		expect(() =>
			validateScript({
				intent: "g",
				steps: [{ id: "a", call: "github:GET /x" }],
			}),
		).not.toThrow();
	});

	it("requires reason on call steps with requireReason", () => {
		const issues = issuesOf(() =>
			validateScript(
				{ intent: "g", steps: [{ id: "a", call: "github:GET /x" }] },
				{ requireReason: true },
			),
		);
		expect(issues.join("\n")).toMatch(/reason is required/);
	});

	it("rejects duplicate ids and forward references", () => {
		const issues = issuesOf(() =>
			validateScript({
				intent: "g",
				steps: [
					{ id: "a", let: "b" }, // forward ref
					{ id: "a", let: "1" }, // duplicate
				],
			}),
		);
		expect(issues.join("\n")).toMatch(/Unknown reference "b"/);
		expect(issues.join("\n")).toMatch(/Duplicate step id/);
	});

	it("rejects ids that shadow globals", () => {
		const issues = issuesOf(() =>
			validateScript({ intent: "g", steps: [{ id: "Math", let: "1" }] }),
		);
		expect(issues.join("\n")).toMatch(/collides with a builtin/);
	});

	it("defaults an each step's max to the per-step limit and enforces limits", () => {
		const script = validateScript(
			{
				intent: "g",
				steps: [
					{ id: "xs", let: "[1, 2, 3]" },
					{
						id: "a",
						call: "svc:POST /x",
						each: "xs.map(x => ({ v: x }))", // max omitted
						reason: "r",
					},
				],
			},
			{ maxItemsPerStep: 25 },
		);
		const step = script.steps[1]!;
		expect("each" in step && step.max).toBe(25);

		const issues = issuesOf(() =>
			validateScript(
				{
					intent: "g",
					steps: [
						{ id: "xs", let: "[1]" },
						{
							id: "a",
							call: "svc:POST /x",
							each: "xs.map(x => ({ v: x }))",
							max: 500,
							reason: "r",
						},
					],
				},
				{ maxItemsPerStep: 100 },
			),
		);
		expect(issues.join("\n")).toMatch(/exceeds the limit/);
	});

	it("rejects the one-shape violations with pointed messages", () => {
		expect(
			issuesOf(() =>
				validateScript({
					steps: [{ id: "a", call: "svc", let: "1", reason: "r" }],
				}),
			).join("\n"),
		).toMatch(/"call" and "let" cannot share a step/);
		expect(
			issuesOf(() =>
				validateScript({ steps: [{ id: "a", let: "1", onError: "skip" }] }),
			).join("\n"),
		).toMatch(/"onError" only makes sense on a "call" step/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{ id: "xs", let: "[1]" },
						{
							id: "a",
							call: "svc",
							each: "xs.map(x => ({ v: x }))",
							args: { v: 1 },
							reason: "r",
						},
					],
				}),
			).join("\n"),
		).toMatch(/"each" yields every call's args/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [{ id: "a", call: "svc", max: 3, reason: "r" }],
				}),
			).join("\n"),
		).toMatch(/"max" bounds an "each" fan-out/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{ id: "a", call: "svc", reason: "r" },
						{ id: "b", parallel: [{ let: "1" }, { let: "2" }] },
					],
				}),
			).join("\n"),
		).toMatch(/"parallel" is gone/);
	});

	it("validates after edges: earlier step ids only", () => {
		expect(() =>
			validateScript({
				steps: [
					{ id: "a", call: "svc", reason: "r" },
					{ id: "b", call: "svc", reason: "r", after: ["a"] },
				],
			}),
		).not.toThrow();
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{ id: "a", call: "svc", reason: "r", after: ["b"] },
						{ id: "b", call: "svc", reason: "r" },
					],
				}),
			).join("\n"),
		).toMatch(/"after" may only name EARLIER steps/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [{ id: "a", call: "svc", reason: "r", after: ["ghost"] }],
				}),
			).join("\n"),
		).toMatch(/unknown step "ghost"/);
	});

	it("rejects invalid expressions inside args", () => {
		const issues = issuesOf(() =>
			validateScript({
				intent: "g",
				steps: [
					{ id: "a", call: "svc:GET /x", args: { v: "=x =" }, reason: "r" },
				],
			}),
		);
		expect(issues.join("\n")).toMatch(/steps\[0\]\.args/);
	});

	it("caps worst-case total calls", () => {
		const issues = issuesOf(() =>
			validateScript(
				{
					intent: "g",
					steps: [
						{ id: "xs", let: "[1]" },
						{
							id: "a",
							call: "svc:POST /x",
							each: "xs.map(x => ({ v: x }))",
							max: 90,
							reason: "r",
						},
						{
							id: "b",
							call: "svc:POST /y",
							each: "xs.map(x => ({ v: x }))",
							max: 90,
							reason: "r",
						},
					],
				},
				{ maxTotalCalls: 100 },
			),
		);
		expect(issues.join("\n")).toMatch(/Worst-case total calls/);
	});
});

describe("createScriptValidator", () => {
	it("with no defaults behaves like validateScript and returns the normalized script", () => {
		const validate = createScriptValidator();
		const script = validate(validScript);
		expect(script.intent).toBe(validScript.intent);
		expect(script.steps.map((s) => s.id)).toEqual([
			"issues",
			"stale",
			"close",
			"notify",
		]);
	});

	it("bakes in defaults", () => {
		const validate = createScriptValidator({ requireReason: true });
		const script = { intent: "g", steps: [{ id: "a", call: "github:GET /x" }] };
		expect(() => validate(script)).toThrow(ScriptValidationError);
		expect(issuesOf(() => validate(script)).join("\n")).toMatch(
			/reason is required/,
		);
	});

	it("allows per-call overrides over baked-in defaults", () => {
		const validate = createScriptValidator({ requireReason: true });
		const script = { intent: "g", steps: [{ id: "a", call: "github:GET /x" }] };
		expect(() => validate(script, { requireReason: false })).not.toThrow();
	});

	it("shallow-merges overrides: untouched defaults stay in effect", () => {
		const validate = createScriptValidator({
			tools: ["listIssues"],
			requireReason: true,
		});
		const script = { intent: "g", steps: [{ id: "a", call: "closeIssue" }] };
		const issues = issuesOf(() => validate(script, { requireReason: false }));
		expect(issues.join("\n")).toMatch(/Unknown tool "closeIssue"/);
		expect(issues.join("\n")).not.toMatch(/reason is required/);
	});

	it("enforces baked-in limits", () => {
		const validate = createScriptValidator({ maxSteps: 1 });
		const issues = issuesOf(() =>
			validate({
				intent: "g",
				steps: [
					{ id: "a", let: "1" },
					{ id: "b", let: "2" },
				],
			}),
		);
		expect(issues.join("\n")).toMatch(/Too many steps \(2 > 1\)/);
	});

	it("does not share state across calls", () => {
		const validate = createScriptValidator({ requireReason: true });
		const bad = { intent: "g", steps: [{ id: "a", call: "github:GET /x" }] };
		expect(() => validate(bad, { requireReason: false })).not.toThrow();
		expect(() => validate(bad)).toThrow(ScriptValidationError);
	});
});

describe("analyzeScript / renderScript", () => {
	it("computes the authorization surface", () => {
		const script = validateScript(validScript);
		const analysis = analyzeScript(script);
		expect(analysis.tools).toEqual(["listIssues", "closeIssue", "postMessage"]);
		expect(analysis.worstCaseCalls).toBe(22); // 1 + 20 + 1
		expect(analysis.returns).toEqual(["close"]);
		expect(analysis.calls.map((c) => c.returns)).toEqual([false, true, false]);
	});

	it("renders a human-readable summary", () => {
		const text = renderScript(validateScript(validScript));
		expect(text).toContain("Intent: Close stale issues");
		expect(text).toContain("[call ×≤20]");
		expect(text).toContain("[may END THE RUN here");
		expect(text).toContain("reason: Close issues inactive for 60+ days");
		expect(text).toContain("Returns: the output of `notify`");
	});

	it("reports return gates on call, let, and return-only steps", () => {
		const script = validateScript({
			intent: "g",
			steps: [
				{ id: "n", let: "5" },
				{ id: "guard", return: "n > 10 && { tooBig: n }" },
				{
					id: "s",
					call: "svc.op",
					reason: "gated over 3",
					return: "n > 3 && { gate: n }",
				},
			],
		});
		const analysis = analyzeScript(script);
		expect(analysis.returns).toEqual(["guard", "s"]);
		expect(analysis.calls.map((c) => c.returns)).toEqual([true]);
		const text = renderScript(script);
		expect(text).toContain("return early if `n > 10 && { tooBig: n }`");
		expect(text).toContain("[may END THE RUN here, if `n > 3 && { gate: n }`]");
	});
});

describe("scriptedTools", () => {
	it("collects unique tool names from raw input, including parallel branches", () => {
		expect(scriptedTools(validScript)).toEqual([
			"listIssues",
			"closeIssue",
			"postMessage",
		]);
		const parallel = {
			steps: [
				{
					id: "p",
					parallel: [
						{ id: "a", call: "x" },
						{ id: "b", call: "y" },
						{ id: "c", let: "1" },
					],
				},
				{ id: "d", call: "x" },
			],
		};
		expect(scriptedTools(parallel)).toEqual(["x", "y"]);
	});

	it("never throws on untrusted shapes", () => {
		expect(scriptedTools(undefined)).toEqual([]);
		expect(scriptedTools(null)).toEqual([]);
		expect(scriptedTools("script")).toEqual([]);
		expect(scriptedTools({ resume: "run-1" })).toEqual([]);
		expect(scriptedTools({ steps: "nope" })).toEqual([]);
		expect(
			scriptedTools({ steps: [null, 42, { call: 7 }, { parallel: {} }] }),
		).toEqual([]);
	});
});

describe("scriptCalls", () => {
	it("answers whether the script calls any of the given tools", () => {
		expect(scriptCalls(validScript, "closeIssue")).toBe(true);
		expect(scriptCalls(validScript, "refund", "postMessage")).toBe(true);
		expect(scriptCalls(validScript, "refund")).toBe(false);
		expect(scriptCalls(validScript)).toBe(false); // nothing asked, nothing matches
	});

	it("is false for untrusted shapes", () => {
		expect(scriptCalls(undefined, "x")).toBe(false);
		expect(scriptCalls({ resume: "run-1" }, "x")).toBe(false);
	});
});
