import { isStepCount, jsonSchema, streamText, tool } from "ai";
import { type IntrospectableTool, searchTools, toolCards } from "callscript";

export const maxDuration = 60;

/** Caps on the client-controlled payload. */
const MAX_CONTEXT_CHARS = 24_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_TOOLS = 200;

/**
 * Streams a callscript authored by the model. The client sends the
 * user's prompt, the pinned-only system prompt (`engine.describe()`),
 * and the metadata of ALL mounted tools. Unpinned tools never enter the
 * base prompt - the model reaches them through an agent-level `search`
 * tool (the library's intended `agentTools()` shape): search mid-
 * generation, read the cards, then author a script that calls the
 * discovered tools directly.
 */
export async function POST(req: Request) {
	let mode: unknown;
	let prompt: unknown;
	let context: unknown;
	let tools: unknown;
	let previous: unknown;
	let session: unknown;
	let history: unknown;
	try {
		({ mode, prompt, context, tools, previous, session, history } =
			await req.json());
	} catch {
		return new Response("invalid json body", { status: 400 });
	}
	// the live session card: step results earlier runs already computed,
	// readable from any expression - the model should derive, not re-call
	const sessionCard =
		typeof session === "string" && session.trim().length > 0
			? session.slice(0, 8_000)
			: null;
	// codemode: the client's CF-style typed-API prompt IS the system
	// prompt (so the playground's system view shows exactly what the
	// model gets) and there is no search tool - the whole API is in it
	const isCodeMode = mode === "codemode";
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		return new Response("missing prompt", { status: 400 });
	}
	if (typeof context !== "string" || context.trim().length === 0) {
		return new Response("missing context", { status: 400 });
	}
	const registry: IntrospectableTool[] = (Array.isArray(tools) ? tools : [])
		.filter(
			(t): t is IntrospectableTool =>
				t !== null && typeof t === "object" && typeof t.name === "string",
		)
		.slice(0, MAX_TOOLS);

	// a repair round: the client validated the previous attempt against
	// the real engine and sends the rejected script with the validator's
	// pointed issues - fed back verbatim, as the library intends
	const repair =
		previous !== null &&
		typeof previous === "object" &&
		typeof (previous as { script?: unknown }).script === "string" &&
		Array.isArray((previous as { issues?: unknown }).issues)
			? {
					script: (previous as { script: string }).script.slice(0, 8_000),
					issues: (previous as { issues: unknown[] }).issues
						.filter((i): i is string => typeof i === "string")
						.slice(0, 40)
						.map((i) => i.slice(0, 400)),
				}
			: null;

	// prior conversation turns (code mode): each turn is the prompt the
	// user sent, the script the model replied with, and optionally what
	// running it produced - resent whole every generation, which is
	// exactly how code-mode agents keep context between tasks
	const turns = (Array.isArray(history) ? history : [])
		.filter(
			(t): t is { prompt: string; script: string; result?: string } =>
				t !== null &&
				typeof t === "object" &&
				typeof (t as { prompt?: unknown }).prompt === "string" &&
				typeof (t as { script?: unknown }).script === "string",
		)
		.slice(-8)
		.map((t) => ({
			prompt: t.prompt.slice(0, MAX_PROMPT_CHARS),
			script: t.script.slice(0, 32_000),
			// results ride whole - a truncated result is worse than a big one,
			// because the model may silently complete the missing values; the
			// slice is only a request-size backstop
			result: typeof t.result === "string" ? t.result.slice(0, 200_000) : null,
		}));
	// a turn's run result rides in front of the NEXT user prompt, so the
	// roles keep alternating user/assistant cleanly
	const withResult = (result: string | null, text: string) =>
		result === null
			? text
			: `Your previous script ran with this result:\n${result}\n\n${text}`;
	const historyMessages: { role: "user" | "assistant"; content: string }[] = [];
	for (let i = 0; i < turns.length; i++) {
		historyMessages.push({
			role: "user",
			content: withResult(i > 0 ? turns[i - 1].result : null, turns[i].prompt),
		});
		historyMessages.push({ role: "assistant", content: turns[i].script });
	}
	const lastResult = turns.length > 0 ? turns[turns.length - 1].result : null;

	const userPrompt = withResult(
		lastResult,
		(prompt as string).slice(0, MAX_PROMPT_CHARS),
	);
	const messages = repair
		? [
				...historyMessages,
				{ role: "user" as const, content: userPrompt },
				{ role: "assistant" as const, content: repair.script },
				{
					role: "user" as const,
					content: [
						"The engine REJECTED that script before execution:",
						...repair.issues.map((i) => `- ${i}`),
						"",
						"Fix every issue and reply with the corrected script only -",
						"same rules: bare JavaScript, no fences, no prose.",
					].join("\n"),
				},
			]
		: [...historyMessages, { role: "user" as const, content: userPrompt }];

	const result = streamText({
		model: "anthropic/claude-opus-4.8",
		system: isCodeMode
			? context.slice(0, MAX_CONTEXT_CHARS)
			: [
					"You author callscripts: short JavaScript programs that call the tools",
					"mounted on an engine. The language and the available tools:",
					"",
					context.slice(0, MAX_CONTEXT_CHARS),
					"",
					...(sessionCard !== null
						? [
								sessionCard,
								"",
								"The session values above are ALREADY computed from earlier",
								"runs and readable from any expression. When the user asks",
								"about them, derive the answer instead of re-calling tools -",
								"a script may be pure derivation with zero calls, e.g.",
								"`return { titles: closed.map(c => c.closed) };`.",
								"",
							]
						: []),
					"Not every mounted tool is listed above. If the listed tools are not",
					"enough, call the `search` tool first - it returns the cards of",
					"matching mounted tools, and a script may call any tool whose card",
					"you have seen.",
					"",
					"Rules for your reply:",
					"- While using the search tool, emit no other text.",
					"- Your text output must be ONLY the JavaScript source of one script -",
					"  no markdown fences, no prose before or after.",
					"- Start with a `// one-line intent` comment.",
					"- End with a `return`.",
				].join("\n"),
		messages,
		tools: isCodeMode
			? undefined
			: {
					search: tool({
						description:
							"find mounted tools by keyword - returns the tool cards of the best matches, including tools not listed in the system prompt",
						inputSchema: jsonSchema<{ query: string; limit?: number }>({
							type: "object",
							properties: {
								query: {
									type: "string",
									description:
										"keywords matched against tool names, descriptions, schemas",
								},
								limit: { type: "number" },
							},
							required: ["query"],
							additionalProperties: false,
						}),
						execute: async ({ query, limit }) => {
							const found = searchTools(registry, query, limit ?? 5);
							return found.length === 0 ? "no tools matched" : toolCards(found);
						},
					}),
				},
		// a couple of search rounds at most, then the script itself
		stopWhen: isCodeMode ? undefined : isStepCount(4),
	});
	// the plain text stream, with ONE machine line appended after it: the
	// usage this generation burned (all steps, search rounds included),
	// so the client can report real token numbers instead of guessing
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of result.textStream) {
					controller.enqueue(encoder.encode(chunk));
				}
				const usage = await result.totalUsage;
				controller.enqueue(
					encoder.encode(
						`\n␞${JSON.stringify({ inputTokens: usage.inputTokens ?? 0 })}`,
					),
				);
				controller.close();
			} catch (e) {
				controller.error(e);
			}
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
