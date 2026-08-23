/**
 * The MCP adapter: connect an MCP client directly and its listed tools
 * mount as callscript tools - the way Code Mode connects MCP servers,
 * without the sandbox. Structural: anything with `listTools`/`callTool`
 * fits (the official `@modelcontextprotocol/sdk` Client does), so this
 * adds no dependency.
 *
 *   import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 *   import { callscript } from "callscript";
 *   import { fromMCP } from "callscript/mcp";
 *
 *   const cs = callscript({
 *     tools: await fromMCP(client, { namespace: "github" }),
 *   });
 *
 * Listing is a snapshot: tools added to the server after `fromMCP`
 * resolves are not mounted - call it again and build a new engine to
 * pick them up.
 */
import type { JsonSchema, ScriptTool } from "../tool";

/** The slice of an MCP client this adapter reads - structural, so any
 * SDK version (or a hand-rolled object) fits. */
export type McpClientLike = {
	listTools(): Promise<{
		tools: ReadonlyArray<{
			name: string;
			description?: string;
			inputSchema?: unknown;
			outputSchema?: unknown;
		}>;
	}>;
	callTool(params: {
		name: string;
		arguments?: Record<string, unknown>;
	}): Promise<unknown>;
};

/** Per-tool extras the MCP shape cannot carry - callscript-level
 * metadata keyed by the tool's ORIGINAL name (pre-namespace). */
export type McpToolOverrides = Record<
	string,
	{
		/** Declared machine-readable error codes, for the tool card. */
		errors?: readonly string[];
		/** Overrides the tool's own description on the card. */
		description?: string;
	}
>;

export type FromMCPOptions = {
	/** Prefixes every registry name (`namespace: "github"` mounts
	 * `search_issues` as `github.search_issues`), so several servers
	 * mount side by side. */
	namespace?: string;
	/** Per-tool callscript metadata, keyed by the MCP tool names. */
	overrides?: McpToolOverrides;
};

/** The slice of an MCP call result this adapter reads. */
type McpCallResult = {
	content?: ReadonlyArray<{ type: string; text?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
};

/** Prefer `structuredContent`; otherwise join the text parts and parse
 * JSON when they hold it, so script steps see plain values instead of
 * content-block envelopes. */
const resultValue = (result: McpCallResult): unknown => {
	if (result.structuredContent !== undefined) return result.structuredContent;
	const texts = (result.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
	if (texts.length === 0) return result.content ?? null;
	const joined = texts.join("\n");
	try {
		return JSON.parse(joined);
	} catch {
		return joined;
	}
};

/**
 * Mount an MCP server's tools - the whole listing at once. Tool names
 * become the registry names (a `namespace` prefixes them), descriptions
 * and JSON Schemas render on the cards, and each call dispatches
 * through `client.callTool`. A result with `isError: true` fails the
 * step with code `mcp_tool_error`.
 */
export const fromMCP = async (
	client: McpClientLike,
	options: FromMCPOptions = {},
): Promise<ScriptTool[]> => {
	const { namespace, overrides = {} } = options;
	const { tools } = await client.listTools();
	return tools.map((tool) => {
		const name =
			namespace === undefined ? tool.name : `${namespace}.${tool.name}`;
		const extra = overrides[tool.name];
		return {
			name,
			description: extra?.description ?? tool.description,
			inputSchema: tool.inputSchema as JsonSchema | undefined,
			outputSchema: tool.outputSchema as JsonSchema | undefined,
			...(extra?.errors ? { errors: extra.errors } : {}),
			execute: async (args: unknown) => {
				const result = (await client.callTool({
					name: tool.name,
					arguments: (args ?? {}) as Record<string, unknown>,
				})) as McpCallResult;
				if (result?.isError) {
					const value = resultValue(result);
					throw Object.assign(
						new Error(
							typeof value === "string"
								? value
								: `MCP tool ${tool.name} failed`,
						),
						{ code: "mcp_tool_error" },
					);
				}
				return resultValue(result);
			},
		} as ScriptTool;
	});
};
