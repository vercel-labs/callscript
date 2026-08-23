/**
 * Try callscript with the Vercel AI SDK end to end: define the tools
 * with the SDK's own `tool()`, mount them through the `fromAISDKTools` adapter,
 * hand the model the engine as ONE tool (`toolDefinition()`), and run
 * the script it authors.
 *
 *   bun test/ai-sdk.ts   (from the package root; reads .env for AI_GATEWAY_API_KEY)
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import { fromAISDKTools } from "../src/adapters/ai-sdk.ts";
import { callscript } from "../src/index.ts";

/* a toy tool set - exactly what you would hand generateText's `tools` */

const listIssues = tool({
	description: "list the issues of a repo",
	inputSchema: z.object({
		repo: z.string(),
		state: z.enum(["open", "closed"]).optional(),
	}),
	execute: async () => [
		{ number: 1, title: "old bug", stale: true },
		{ number: 2, title: "fresh bug", stale: false },
		{ number: 3, title: "old chore", stale: true },
	],
});

const closeIssue = tool({
	description: "close an issue by number",
	inputSchema: z.object({ repo: z.string(), number: z.number() }),
	execute: async ({ repo, number }) => {
		console.log(`  [tool] closing #${number} in ${repo}`);
		return { closed: number };
	},
});

const post = tool({
	description: "post a message to a slack channel",
	inputSchema: z.object({ channel: z.string(), text: z.string() }),
	execute: async ({ channel, text }) => {
		console.log(`  [tool] slack ${channel}: ${text}`);
		return { ok: true };
	},
});

const engine = callscript({
	tools: fromAISDKTools({
		"github.listIssues": listIssues,
		"github.closeIssue": closeIssue,
		"slack.post": post,
	}),
});

/* 1. the model writes the script - toolDefinition() pairs the prose
 * (baseCard + tool cards) with the script format as a JSON schema */

const task =
	"Close every stale open issue in the 'api' repo, then post a one-line " +
	"summary to #eng saying how many were closed.";

const { description, inputSchema } = engine.toolDefinition();

console.log(`task: ${task}\n\nauthoring...`);

/* 2. validate at the door - a rejected script goes back to the model
 * with every issue, verbatim; the accepted one runs */

let script: unknown;

await generateText({
	model: "anthropic/claude-sonnet-5",
	system: "You act by writing ONE callscript. Call `execute` with it.",
	messages: [{ role: "user", content: task }],
	tools: {
		execute: {
			description,
			inputSchema: z.object({
				script: z
					.string()
					.describe("The script to run, as a JSON string matching the format."),
			}),
			execute: async (input: { script: string }) => {
				try {
					script = engine.validate(JSON.parse(input.script));
					return { ok: true };
				} catch (err) {
					return { ok: false, issues: String(err) };
				}
			},
		},
	},
});
void inputSchema; // hand this to hosts whose tool interface takes a schema

if (script === undefined) {
	console.log("the model never authored a script");
	process.exit(1);
}

console.log(`\nthe model wrote:\n${engine.render(script as any)}\nrunning...`);

const run = await engine.run({ script });

if (run.status === "ok") {
	console.log("\nstatus: ok");
	console.log("output:", JSON.stringify(run.output, null, 2));
} else if (run.status === "error") {
	console.log(`\nstatus: error at step "${run.at}"`);
	console.log(run.error);
} else {
	console.log("\nstatus: suspended");
	console.log(run.suspensions);
}
