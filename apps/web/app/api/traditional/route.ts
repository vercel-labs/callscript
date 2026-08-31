import { generateText, jsonSchema, type ModelMessage, tool } from "ai";
import type { IntrospectableTool } from "callscript";

export const maxDuration = 60;

const MAX_TOOLS = 200;
const MAX_MESSAGES = 60;

/** Anthropic tool names cannot contain dots - mangle the registry names
 * and let the client unmangle when it dispatches. */
const mangle = (name: string) => name.replace(/\./g, "__");

/**
 * ONE round trip of classic tool calling, for the "traditional" mode
 * showcase: the tools are declared WITHOUT execute, so the model's tool
 * calls come back to the browser, which runs the real handlers and
 * posts the results into the next round. Every call = a full trip
 * through the model - exactly the loop callscript collapses into one
 * validated plan.
 */
export async function POST(req: Request) {
	let messages: unknown;
	let tools: unknown;
	try {
		({ messages, tools } = await req.json());
	} catch {
		return new Response("invalid json body", { status: 400 });
	}
	if (!Array.isArray(messages) || messages.length === 0) {
		return new Response("missing messages", { status: 400 });
	}
	if (messages.length > MAX_MESSAGES) {
		return new Response("conversation too long", { status: 400 });
	}
	const registry: IntrospectableTool[] = (Array.isArray(tools) ? tools : [])
		.filter(
			(t): t is IntrospectableTool =>
				t !== null && typeof t === "object" && typeof t.name === "string",
		)
		.slice(0, MAX_TOOLS);
	if (registry.length === 0) {
		return new Response("missing tools", { status: 400 });
	}

	const sdkTools = Object.fromEntries(
		registry.map((t) => [
			mangle(t.name),
			tool({
				description: t.description,
				inputSchema: jsonSchema(
					(t.inputSchema as object | undefined) ?? { type: "object" },
				),
				// no execute: calls return to the client, which owns the handlers
			}),
		]),
	);

	const result = await generateText({
		model: "anthropic/claude-opus-4.8",
		system: [
			"You are an agent completing the user's task with the available",
			"tools, calling them one at a time as needed. When the task is",
			"done, reply with one short sentence summarizing what happened.",
		].join("\n"),
		messages: messages as ModelMessage[],
		tools: sdkTools,
	});

	return Response.json({
		text: result.text,
		toolCalls: result.toolCalls.map((c) => ({
			toolCallId: c.toolCallId,
			toolName: c.toolName,
			input: c.input,
		})),
		// input tokens this round trip burned - the whole conversation
		// (schemas, prior results) is re-sent every trip
		tokens: result.usage.inputTokens ?? 0,
		// appended verbatim by the client so the next round sees this one
		messages: result.response.messages,
	});
}
