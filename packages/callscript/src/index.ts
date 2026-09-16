/* The callscript public API: the tool door (`callscript`), the tool
 * contract (`tool`), the JS frontend, the validator, and the inert plan
 * format. Adapters live under their own entry points: `callscript/ai-sdk`.
 * Everything else in src/ is internal - reachable, tested, but not part
 * of the v1 surface. */

// analysis + rendering - what an authorizer reads before approving
export { analyzeScript, renderScript } from "./analyze";
export { collectArgExprs } from "./args";
// prompt-building blocks for hosts that assemble their own cards
export {
	jsLanguageCard,
	renderJsonSchemaType,
	searchTools,
	toolCard,
	toolCards, type IntrospectableTool
} from "./describe";
// the durable runner - experimental, see durable.ts
export * from "./durable";
// the engine - mount tools, get the execute/search pair
export {
	callscript,
	earlyReturn, suspend, type AgentDescribeInput,
	type AgentExecuteResult,
	type AgentSearchInput,
	type AgentTool,
	type CompiledScriptTool, type RunInput,
	type ScriptEngine,
	type ScriptEngineOptions,
	type SessionOptions,
	type SessionRunner, type ToolsOptions
} from "./engine";
export { publishedVariables, stableStringify } from "./execute";
export { evalExpr } from "./expr/eval";
// the JS frontend - model-authored JS in, inert plan out
export { parseJsScript, type ParseJsOptions } from "./js";
// the tool contract - the one seam adapters (and literals) fill
export {
	tool, type AnyScriptTool,
	type JsonSchema,
	type ScriptTool,
	type ToolCallContext,
	type ToolMap
} from "./tool";

// the plan format - steps, limits, run records, and their guards
export * from "./types";
// the validator - the whole plan checked before anything runs
export {
	ScriptValidationError, validateScript, type ScriptIssue, type ValidateOptions
} from "./validate";

