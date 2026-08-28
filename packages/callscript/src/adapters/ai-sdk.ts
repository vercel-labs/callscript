/**
 * The AI SDK adapter: a `tools` set as you would hand `generateText` /
 * `streamText` becomes callscript tools - the record keys are the
 * registry names, `inputSchema` (zod, any standard schema, or the SDK's
 * `jsonSchema()`) renders on the tool card AND validates args at the
 * door, and `execute` dispatches with AI-SDK-shaped call options:
 *
 *   import { tool } from "ai";
 *   import { callscript } from "callscript";
 *   import { fromAISDKTools } from "callscript/ai-sdk";
 *
 *   const engine = callscript({
 *     tools: fromAISDKTools({ getWeather, closeIssue }),
 *   });
 *
 * Needs the `ai` package (a peer dependency) - the adapter uses its
 * `asSchema` to normalize whatever schema flavor each tool declares.
 */
import { asSchema, jsonSchema } from "ai";
import type { AgentTool, ToolsOptions } from "../engine";
import type { ScriptTool, ToolCallContext } from "../tool";

/** The slice of an AI SDK `Tool` this adapter reads - structural, so
 * any past/future SDK version (or a hand-rolled object) fits. */
export type AiSdkToolLike = {
	/** A plain string renders on the card; the SDK's dynamic form (a
	 * function of call context) is ignored - override per tool instead. */
	description?: string | ((options: any) => string);
	inputSchema?: unknown;
	outputSchema?: unknown;
	/** AI SDK server-side execute. Client-executed tools (no `execute`)
	 * cannot be mounted - a script run has nowhere to send them. */
	execute?: (input: any, options: any) => any;
};

/** Per-tool extras the AI SDK shape cannot carry - callscript-level
 * metadata keyed by the record's ORIGINAL key (pre-namespace). */
export type AiToolOverrides<T> = {
	[K in keyof T]?: {
		/** Declared machine-readable error codes, for the tool card. */
		errors?: readonly string[];
		/** Overrides the tool's own description on the card. */
		description?: string;
	};
};

export type FromAISDKToolsOptions<T, NS extends string | undefined> = {
	/** Prefixes every registry name (`namespace: "github"` mounts key
	 * `listIssues` as `github.listIssues`), so whole tool records mount
	 * side by side without renaming their keys. */
	namespace?: NS;
	/** Per-tool callscript metadata, keyed by the record's own keys. */
	overrides?: AiToolOverrides<T>;
};

type InputOf<T> = T extends { execute: (input: infer I, options: any) => any }
	? I
	: unknown;
type OutputOf<T> = T extends { execute: (input: any, options: any) => infer R }
	? Awaited<R>
	: unknown;

type NamespacedKey<
	NS extends string | undefined,
	K extends string,
> = NS extends string ? `${NS}.${K}` : K;

/** The adapter's return type: one typed callscript tool per entry, so
 * `engine.script` types `call`/`args`/arrow scopes off the SDK tools. */
export type AiScriptTools<T, NS extends string | undefined = undefined> = Array<
	{
		[K in keyof T & string]: ScriptTool<
			NamespacedKey<NS, K>,
			InputOf<T[K]>,
			OutputOf<T[K]>
		>;
	}[keyof T & string]
>;

const validationError = (name: string, detail: string): Error =>
	Object.assign(new Error(`${name}: invalid args - ${detail}`), {
		code: "invalid_tool_args",
	});

/**
 * Mount an AI SDK tool set - the whole record at once, however many
 * tools it holds. Record keys become the registry names; a `namespace`
 * prefixes them (`fromAISDKTools(github, { namespace: "github" })`
 * mounts `github.listIssues`, ...), so several records mount side by
 * side by spreading:
 *
 *   tools: [
 *     ...fromAISDKTools(github, { namespace: "github" }),
 *     ...fromAISDKTools(slack, { namespace: "slack" }),
 *   ]
 *
 * Args validate against each tool's `inputSchema` before `execute`
 * fires - a failure fails the step with code `invalid_tool_args`,
 * never reaching the tool.
 */
export const fromAISDKTools = <
	T extends Record<string, AiSdkToolLike>,
	const NS extends string | undefined = undefined,
>(
	tools: T,
	options: FromAISDKToolsOptions<T, NS> = {},
): AiScriptTools<T, NS> => {
	const { namespace } = options;
	const overrides: AiToolOverrides<T> = options.overrides ?? {};
	return Object.entries(tools).map(([key, tool]) => {
		const name = namespace === undefined ? key : `${namespace}.${key}`;
		const execute = tool.execute;
		if (typeof execute !== "function") {
			throw new Error(
				`fromAISDKTools: tool "${name}" has no execute - client-executed AI SDK ` +
					"tools cannot be mounted on a script engine",
			);
		}
		const input = tool.inputSchema
			? asSchema(tool.inputSchema as any)
			: undefined;
		const output = tool.outputSchema
			? asSchema(tool.outputSchema as any)
			: undefined;
		const extra = overrides[key as keyof T];
		return {
			name,
			description:
				extra?.description ??
				(typeof tool.description === "string" ? tool.description : undefined),
			inputSchema: input?.jsonSchema as Record<string, unknown> | undefined,
			outputSchema: output?.jsonSchema as Record<string, unknown> | undefined,
			...(extra?.errors ? { errors: extra.errors } : {}),
			execute: async (args: unknown, ctx: ToolCallContext) => {
				let resolved = args;
				if (input?.validate) {
					const checked = await input.validate(args);
					if (!checked.success) {
						throw validationError(name, checked.error.message);
					}
					resolved = checked.value;
				}
				// AI-SDK-shaped call options, so tools written for the SDK
				// read familiar fields; the full callscript context rides on
				// `experimental_context` for tools that want more.
				return execute(resolved, {
					toolCallId:
						ctx.itemIndex === undefined
							? ctx.stepId
							: `${ctx.stepId}[${ctx.itemIndex}]`,
					messages: [],
					experimental_context: ctx,
				});
			},
		} as AiScriptTools<T, NS>[number];
	});
};

/** The slice of an engine `toAISDKTools` reads - structural, so it takes
 * any engine without importing the full type. */
type ToolsHost = {
	tools(options?: ToolsOptions): {
		execute: AgentTool;
		search: AgentTool;
		describe: AgentTool;
	};
};

/**
 * The engine's tools (`engine.tools()`), wrapped for the AI SDK - hand
 * the record straight to `generateText`/`streamText`:
 *
 *   tools: toAISDKTools(engine)
 *
 * `execute` runs one script against a shared in-memory session (invalid
 * scripts return their issues for the model to retry); `search` finds
 * mounted tools by keyword and `describe` renders their full signature
 * cards, so the prompt never carries every tool definition ahead of
 * time. Renames via `options.names` carry through to the record keys,
 * so the model sees the names you chose.
 */
export const toAISDKTools = (
	engine: ToolsHost,
	options?: ToolsOptions,
): Record<
	string,
	{
		description: string;
		inputSchema: ReturnType<typeof jsonSchema>;
		execute: (args: any) => Promise<unknown>;
	}
> => {
	const trio = engine.tools(options);
	const wrap = (t: AgentTool) => ({
		description: t.description,
		inputSchema: jsonSchema(t.inputSchema as any),
		execute: (args: any) => t.execute(args),
	});
	return {
		[trio.execute.name]: wrap(trio.execute),
		[trio.search.name]: wrap(trio.search),
		[trio.describe.name]: wrap(trio.describe),
	};
};
