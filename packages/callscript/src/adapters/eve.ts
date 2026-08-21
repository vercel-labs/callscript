/**
 * The eve adapter: the engine's agent tool pair as eve tool
 * definitions. eve tools are files - one default export per
 * `agent/tools/<name>.ts` - so `toEveTools` returns BOTH definitions
 * and the agent re-exports each from its own file:
 *
 *   // lib/callscript.ts
 *   import { toEveTools } from "callscript/eve";
 *   export const { execute, search } = toEveTools(engine);
 *
 *   // agent/tools/execute.ts
 *   export { execute as default } from "../../lib/callscript";
 *
 *   // agent/tools/search.ts
 *   export { search as default } from "../../lib/callscript";
 *
 * The definitions go through eve's own `defineTool` (it brands them;
 * eve rejects raw object literals), so `eve` is a peer dependency of
 * this entry point. A dynamic tools file can also serve the pair from
 * one slot: `defineDynamic` handlers may return the record
 * `{ execute, search }` as-is.
 */
import { defineTool } from "eve/tools";
import type { AgentTool, AgentToolsOptions } from "../engine";

/** eve's (unexported) JSON schema shape, mirrored structurally - the
 * pair's schemas are plain JSON data, so the assertion only bridges the
 * nominal gap. */
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** The slice of an engine `toEveTools` reads - structural, so it takes
 * any engine without importing the full type. */
type AgentToolsHost = {
	agentTools(options?: AgentToolsOptions): {
		execute: AgentTool;
		search: AgentTool;
	};
};

/**
 * The engine as eve agent tools: `execute` runs one script against a
 * shared session scope (invalid scripts return their issues for the
 * model to retry), `search` finds mounted tools by keyword. Both are
 * branded `defineTool` results - export each as the default of its
 * `agent/tools/` file. `options` is `engine.agentTools`'s: `scope`
 * joins an existing session, `inlineTools` moves the cards behind
 * `search`, `names` renames the pair (the filename still decides the
 * model-facing name in eve - keep them in step).
 */
export const toEveTools = (
	engine: AgentToolsHost,
	options?: AgentToolsOptions,
): {
	execute: ReturnType<typeof defineTool>;
	search: ReturnType<typeof defineTool>;
} => {
	const pair = engine.agentTools(options);
	const wrap = (t: AgentTool) =>
		defineTool({
			description: t.description,
			// the pair's schemas are plain JSON Schema - eve takes them as is
			inputSchema: t.inputSchema as { [key: string]: JsonValue },
			execute: (input: unknown) => t.execute(input),
		});
	return { execute: wrap(pair.execute), search: wrap(pair.search) };
};
