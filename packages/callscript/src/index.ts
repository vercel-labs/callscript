/* The tool door - the primary surface of this package. Adapters live
 * under their own entry points: `callscript/ai-sdk`, `callscript/better-tools`. */

export * from "./analyze";
export * from "./args";
export * from "./describe";
export * from "./durable";
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
	scriptEngine,
	suspend,
} from "./engine";
export * from "./execute";
export { type EvalOptions, evalExpr } from "./expr/eval";
export {
	collectRefs,
	ExprError,
	type ExprErrorCode,
	FORBIDDEN_PROPS,
	GLOBAL_NAMES,
	parseExpr,
	patternNames,
	validateNode,
} from "./expr/parse";
export { fnToExpr, resolveFnExprs } from "./fn-expr";
export { type ParseJsOptions, parseJsScript } from "./js";
export * from "./runner";
export * from "./schema";
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
export type {
	Expr,
	ExprFn,
	ExprLike,
	ExprScope,
	TypedCallStep,
	TypedLetStep,
	TypedReturnStep,
	TypedScript,
	TypedScriptOf,
	TypedStep,
	TypedStepsOf,
	WithExprs,
} from "./typed";
export * from "./types";
export * from "./validate";
export * from "./wildcard";
