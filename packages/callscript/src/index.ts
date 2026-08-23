/* The callscript public API: the tool door (`callscript`), the tool
 * contract (`tool`), the JS frontend, the validator, and the inert plan
 * format. Adapters live under their own entry points: `callscript/ai-sdk`.
 * Everything else in src/ is internal - reachable, tested, but not part
 * of the v1 surface. */

// the engine - mount tools, get the execute/search pair
export {
	type AgentExecuteResult,
	type AgentSearchInput,
	type AgentTool,
	type AgentToolsOptions,
	type CompiledScriptTool,
	earlyReturn,
	type RunInput,
	type ScriptEngine,
	type ScriptEngineOptions,
	type SessionOptions,
	type SessionRunner,
	callscript,
	suspend,
} from "./engine";

// the tool contract - the one seam adapters (and literals) fill
export {
	type AnyScriptTool,
	createScope,
	type JsonSchema,
	type ScriptScope,
	type ScriptTool,
	type ToolCallContext,
	type ToolMap,
	tool,
} from "./tool";

// the JS frontend - model-authored JS in, inert plan out
export { type ParseJsOptions, parseJsScript } from "./js";

// the validator - the whole plan checked before anything runs
export {
	type ScriptIssue,
	ScriptValidationError,
	type ValidateOptions,
	validateScript,
} from "./validate";

// analysis + rendering - what an authorizer reads before approving
export { analyzeScript, renderScript } from "./analyze";

// prompt-building blocks for hosts that assemble their own cards
export {
	type IntrospectableTool,
	jsLanguageCard,
	renderJsonSchemaType,
	searchTools,
	toolCard,
	toolCards,
} from "./describe";

// session inspection
export { publishedVariables } from "./execute";

// the plan format - steps, limits, run records, and their guards
export * from "./types";

// the durable runner - experimental, see durable.ts
export * from "./durable";
