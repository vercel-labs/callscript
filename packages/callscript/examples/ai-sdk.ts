/**
 * Mount AI SDK tools on an engine and hand the model the ready-made trio
 * (execute + search + describe). The model authors ONE script; the engine
 * runs it as an inert plan.
 *
 * Needs a model provider configured (e.g. ANTHROPIC_API_KEY):
 *   bun examples/ai-sdk.ts
 */
import { tool as aiTool, generateText } from "ai";
import { z } from "zod";
import { fromAISDKTools, toAISDKTools } from "../src/adapters/ai-sdk.ts";
import { callscript } from "../src/index.ts";

// Your existing AI SDK tools - executed server-side (they need an `execute`).
const tools = {
	listIssues: aiTool({
		description: "list the issues of a repo",
		inputSchema: z.object({
			repo: z.string(),
			state: z.enum(["open", "closed"]).optional(),
		}),
		execute: async () => [
			{ number: 1, title: "old bug", stale: true },
			{ number: 2, title: "fresh bug", stale: false },
		],
	}),
	closeIssue: aiTool({
		description: "close an issue by number",
		inputSchema: z.object({ repo: z.string(), number: z.number() }),
		execute: async ({ number }) => ({ closed: number }),
	}),
};

const engine = callscript({
	tools: fromAISDKTools(tools, { namespace: "github" }),
});

const { text } = await generateText({
	model: "anthropic/claude-sonnet-5",
	prompt: "Close every stale open issue in the 'api' repo.",
	tools: toAISDKTools(engine), // execute + search + describe
});

console.log(text);
