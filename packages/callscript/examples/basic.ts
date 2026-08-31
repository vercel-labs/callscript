/**
 * The model would author the `script` string; here we write it by hand to
 * show the whole flow: mount tools, validate the JS (rejected before anything
 * runs), then execute it as an inert plan.
 *
 *   bun examples/basic.ts
 */
import { callscript, tool } from "../src/index.ts";

const listIssues = tool({
	name: "github.listIssues",
	description: "list the issues of a repo",
	inputSchema: {
		type: "object",
		properties: {
			repo: { type: "string" },
			state: { enum: ["open", "closed"] },
		},
		required: ["repo"],
	},
	execute: (_args: { repo: string; state?: "open" | "closed" }) => [
		{ number: 1, title: "old bug", stale: true },
		{ number: 2, title: "fresh bug", stale: false },
		{ number: 3, title: "old chore", stale: true },
	],
});

const closeIssue = tool({
	name: "github.closeIssue",
	description: "close an issue by number",
	inputSchema: {
		type: "object",
		properties: { repo: { type: "string" }, number: { type: "number" } },
		required: ["repo", "number"],
	},
	errors: ["not_found"],
	execute: (args: { repo: string; number: number }) => ({
		closed: args.number,
	}),
});

const engine = callscript({ tools: [listIssues, closeIssue] });

// The JS surface - what the model writes. Parsed into a plan, never executed.
const script = `
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter((i) => i.stale);
if (stale.length === 0) return { closed: 0 };
const closed = await Promise.all(
  stale.slice(0, 10).map((i) => github.closeIssue({ repo: "api", number: i.number })),
);
return { count: closed.length, numbers: stale.map((i) => i.number) };
`;

// Validate first: unknown tools, bad args, unbound refs - all reported here,
// before a single tool fires. Throws on a bad script.
engine.validate(script);

// Execute the inert plan. Steps run in dependency order; the fan-out is
// bounded by the visible `.slice(0, 10)`.
const result = await engine.run({ script });
if (result.status === "ok") console.log("result:", result.output);
else console.log("run did not finish:", result.status, result);

// Try an invalid script to see the validator reject it:
try {
	engine.validate(`while (true) { await github.closeIssue({ number: 1 }); }`);
} catch (e) {
	console.log("\nrejected:", (e as Error).message);
}
