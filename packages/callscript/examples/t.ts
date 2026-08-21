import { scriptEngine, tool } from "../src/index.ts";

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
	outputSchema: {
		type: "array",
		items: {
			type: "object",
			properties: {
				number: { type: "number" },
				title: { type: "string" },
				stale: { type: "boolean" },
			},
			required: ["number", "title", "stale"],
		},
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

const engine = scriptEngine({
	tools: [listIssues, closeIssue],
	requireReason: true,
});

console.log("1. the STATIC prompt context - engine.describe():\n");
console.log(engine.describe());

console.log(
	"\n\n1b. the engine as ONE agent tool - engine.toolDefinition():\n",
);
const def = engine.toolDefinition();
console.log("--- description (base card + tool signatures) ---\n");
console.log(def.description);

console.log("\n\n2. the LIVE prompt context - engine.context(scope):\n");

const scope = engine.scope({ user: { id: "u1", name: "Ada" } });
console.log("before any run:");
console.log(engine.context(scope));

await engine.run(
	{
		script: {
			steps: [
				{
					id: "issues",
					call: "github.listIssues",
					args: { repo: "api" },
					reason: "find stale issues",
				},
				{ id: "stale", let: "issues.filter(i => i.stale).map(i => i.number)" },
			],
		},
	},
	scope,
);

console.log("\nafter a run settled two steps:");
console.log(engine.context(scope));
