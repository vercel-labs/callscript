/**
 * The Mastra adapter: native Mastra tools become callscript tools, and
 * callscript's execute/search/describe trio becomes native Mastra tools.
 *
 * Mastra is an optional peer dependency. It is only needed when this
 * entrypoint is imported.
 *
 * Mastra schemas are normalized through its Standard Schema helpers so the
 * same input validation and JSON Schema cards work for Zod, Standard Schema,
 * and JSON Schema tool definitions. Direct calls do not fabricate Mastra
 * agent or workflow context; use a Mastra Agent when those features are
 * required.
 */
import {
	standardSchemaToJSONSchema,
	toStandardSchema,
} from "@mastra/core/schema";
import { createTool, isValidationError, type Tool } from "@mastra/core/tools";
import type { AgentTool, ToolsOptions } from "../engine";
import type { JsonSchema, ScriptTool, ToolCallContext } from "../tool";

/** The slice of a Mastra Tool or ToolAction this adapter reads. */
export type MastraToolLike = {
	id?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	execute?: (...args: any[]) => any;
};

/** Per-tool callscript metadata keyed by the original record key. */
export type MastraToolOverrides<T> = {
	[K in keyof T]?: {
		/** Declared machine-readable error codes for the callscript card. */
		errors?: readonly string[];
		/** Overrides the Mastra description on the callscript card. */
		description?: string;
	};
};

/** Options for importing Mastra tools into a callscript engine. */
export type FromMastraToolsOptions<T, NS extends string | undefined> = {
	/** Prefix every record key with this namespace. */
	namespace?: NS;
	/** Callscript metadata overrides keyed by the original record keys. */
	overrides?: MastraToolOverrides<T>;
};

type InputOf<T> = T extends {
	execute?: (input: infer I, ...args: any[]) => any;
}
	? I
	: unknown;
type OutputOf<T> = T extends {
	execute?: (...args: any[]) => infer R;
}
	? Awaited<R>
	: unknown;

type NamespacedKey<
	NS extends string | undefined,
	K extends string,
> = NS extends string ? `${NS}.${K}` : K;

/** One typed callscript tool per Mastra record entry. */
export type MastraScriptTools<
	T extends Record<string, MastraToolLike>,
	NS extends string | undefined = undefined,
> = Array<
	{
		[K in keyof T & string]: ScriptTool<
			NamespacedKey<NS, K>,
			InputOf<T[K]>,
			OutputOf<T[K]>
		>;
	}[keyof T & string]
>;

type NormalizedSchema = {
	standard: ReturnType<typeof toStandardSchema>;
	json: JsonSchema;
};

const normalizeSchema = (
	schema: unknown,
	io: "input" | "output",
): NormalizedSchema => {
	const standard = toStandardSchema(schema as any);
	return {
		standard,
		json: standardSchemaToJSONSchema(standard, { io }) as JsonSchema,
	};
};

const invalidArgs = (name: string, detail: string): Error =>
	Object.assign(new Error(`${name}: invalid args - ${detail}`), {
		code: "invalid_tool_args",
	});

const mastraValidation = (name: string, detail: string): Error =>
	Object.assign(new Error(`${name}: Mastra validation failed - ${detail}`), {
		code: "mastra_validation_error",
	});

/**
 * Mount a Mastra tool record on a callscript engine.
 *
 * Record keys become the callscript registry names; namespace prefixes them,
 * and overrides remain keyed by the original record keys. Native Mastra
 * Tool instances keep their own validation, output transformation, and hook
 * behavior after callscript validates the incoming arguments.
 *
 * A Mastra execution context is not synthesized for direct callscript
 * dispatch. The supplied tool is called with its validated input and no
 * context argument, so Mastra creates its normal empty context where its
 * runtime supports that behavior.
 */
export const fromMastraTools = <
	T extends Record<string, MastraToolLike>,
	const NS extends string | undefined = undefined,
>(
	tools: T,
	options: FromMastraToolsOptions<T, NS> = {},
): MastraScriptTools<T, NS> => {
	const { namespace } = options;
	const overrides: MastraToolOverrides<T> = options.overrides ?? {};
	return Object.entries(tools).map(([key, tool]) => {
		const name = namespace === undefined ? key : `${namespace}.${key}`;
		const execute = tool.execute;
		if (typeof execute !== "function") {
			throw new Error(
				`fromMastraTools: tool "${name}" has no execute - client-executed ` +
					"Mastra tools cannot be mounted on a script engine",
			);
		}

		const input =
			tool.inputSchema === undefined
				? undefined
				: normalizeSchema(tool.inputSchema, "input");
		const output =
			tool.outputSchema === undefined
				? undefined
				: normalizeSchema(tool.outputSchema, "output");
		const extra = overrides[key as keyof T];

		return {
			name,
			description: extra?.description ?? tool.description,
			inputSchema: input?.json,
			outputSchema: output?.json,
			...(extra?.errors ? { errors: extra.errors } : {}),
			execute: async (args: unknown, _ctx: ToolCallContext) => {
				let resolved = args;
				if (input !== undefined) {
					let inputArgs = args;
					if (inputArgs === undefined || inputArgs === null) {
						const inputType = (input.json as { type?: unknown }).type;
						if (inputType === "object") {
							inputArgs = {};
						} else if (inputType === "array") {
							inputArgs = [];
						}
					}
					const checked = await input.standard["~standard"].validate(inputArgs);
					if (!("value" in checked)) {
						throw invalidArgs(
							name,
							checked.issues.map((issue) => issue.message).join("; "),
						);
					}
					resolved = checked.value;
				}

				const result = await execute(resolved);
				if (isValidationError(result)) {
					const detail = [
						result.message,
						...result.validationErrors.errors,
					].join("; ");
					throw mastraValidation(name, detail);
				}
				return result;
			},
		} as MastraScriptTools<T, NS>[number];
	});
};

/** The slice of a callscript engine consumed by toMastraTools. */
type ToolsHost = {
	tools(options?: ToolsOptions): {
		execute: AgentTool;
		search: AgentTool;
		describe: AgentTool;
	};
};

/**
 * Wrap a callscript engine's execute/search/describe trio as native Mastra
 * Tool instances. The returned record can be passed directly to a Mastra
 * Agent's tools configuration.
 *
 * The record keys and Mastra ids use the names returned by engine.tools(),
 * including any options.names overrides. Directly executing a wrapper runs
 * callscript's tool surface and does not add Mastra agent orchestration.
 */
export const toMastraTools = (
	engine: ToolsHost,
	options?: ToolsOptions,
): Record<string, Tool> => {
	const trio = engine.tools(options);
	const wrap = (source: AgentTool): Tool =>
		createTool({
			id: source.name,
			description: source.description,
			inputSchema: source.inputSchema,
			execute: async (args) => source.execute(args),
		});

	return {
		[trio.execute.name]: wrap(trio.execute),
		[trio.search.name]: wrap(trio.search),
		[trio.describe.name]: wrap(trio.describe),
	};
};
