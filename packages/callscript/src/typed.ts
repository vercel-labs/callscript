/**
 * Typed script AUTHORING. A script written in TS against an engine is
 * checked like code: `call` is the union of mounted tool names, `args`
 * is that tool's argument type (the first parameter of its `execute`)
 * with any leaf (or whole subtree) replaceable by an `"=expr"` string.
 * Every expression position also takes a JS-native arrow (`ExprFn`),
 * transpiled to its string form at the door - see fn-expr.ts.
 *
 * Authoring arrows are SCOPE-TYPED: the binding a call step produces is
 * the called tool's return type, so a later arrow destructuring that id
 * gets the real shape (`({ issues }) => issues.filter(i => i.stale)`
 * with `issues` typed from `github.listIssues`). The machinery is one
 * reverse-mapped tuple (`Marks`) whose element gathers each step's `id`
 * and `call` literals; the scope before step N folds the elements before
 * it. TypeScript never feeds a context-sensitive arrow's return back
 * into the tuple, so a `let` step's OWN emit stays `any` - only call
 * steps contribute real types. Names no step produces (session
 * variables, `input`, `$calls`, a forEach binding) stay `any` through
 * the scope's index-signature fallback.
 */
import type { ErrorMode } from "./types";

/** The slice of a tool the type machinery reads: the `name` literal and
 * the `execute` signature (args in, result out). Any `ScriptTool` fits;
 * so does anything structurally similar an adapter returns. */
export type IntrospectableToolType = {
	name: string;
	execute: (args: any, ...rest: any[]) => any;
};

/** An embedded expression: any string starting with `=`. */
export type Expr = `=${string}`;

/** What an authoring arrow destructures from: the step outputs, session
 * variables, `input`, and (in a call step's `return`) `$calls`. The
 * engine doors narrow this per step; bare `TypedScript` stays loose. */
export type ExprScope = Record<string, any>;

/**
 * A JS-native expression: an arrow whose single parameter DESTRUCTURES
 * every name the body reads - `({ issues }) => issues.filter(i => i.stale)`.
 * Transpiled to its string form at the door (never executed), so the
 * script stays inert data; a captured outer variable is rejected.
 */
export type ExprFn<R = unknown, S = ExprScope> = (scope: S) => R;

/** An expression position: the string form or the authoring arrow. */
export type ExprLike<S = ExprScope> = string | ExprFn<unknown, S>;

/**
 * Literal JSON of shape `T`, except any leaf or subtree may be an
 * expression instead - `{ number: "=issue.number" }` or
 * `{ number: ({ issue }) => issue.number }` against `{ number: number }`.
 */
export type WithExprs<T, S = ExprScope> = [T] extends [never]
	? never
	: T extends string
		? T | Expr | ExprFn<T, S>
		: T extends number | boolean | null | undefined
			? T | Expr | ExprFn<T, S>
			: T extends readonly (infer U)[]
				? readonly WithExprs<U, S>[] | Expr | ExprFn<T, S>
				: T extends object
					? { [K in keyof T]: WithExprs<T[K], S> } | Expr | ExprFn<T, S>
					: T | Expr | ExprFn<T, S>;

/** `M` is this step's slot in the inferred `Marks` tuple: the `id` (and,
 * on a call step, the `call` key) land there as literal candidates. The
 * bare forms leave it `unknown`, and `unknown & string = string`. */
type StepGates<M = unknown, S = ExprScope> = {
	/** Unique name; later expressions reference this step's output by it. */
	id?: M & string;
	/** Expression; falsy skips the step (output undefined). */
	if?: ExprLike<S>;
	/** Expression evaluated BEFORE the step's action: truthy ends the run
	 * here with that value. On a call step it sees `$calls`. A return-gated
	 * step is a FENCE: everything before it settles first. */
	return?: ExprLike<S>;
	/** Explicit ordering: EARLIER step ids to wait for when no data flows. */
	after?: readonly string[];
};

/** The args slot for a tool taking `A`: omittable when the tool takes
 * nothing (or everything is optional), otherwise required - with
 * expressions allowed anywhere, including the whole thing. An untyped
 * tool (`A = any` - e.g. a compiled script) leaves the slot open. */
type ArgsSlot<A, S = ExprScope> = 0 extends 1 & A
	? { args?: any }
	: [A] extends [void | undefined]
		? { args?: Expr }
		: Record<never, never> extends A
			? { args?: WithExprs<A, S> | Expr }
			: { args: WithExprs<A, S> | Expr };

type CallStepOf<F, M = unknown, S = ExprScope> = F extends {
	name: infer K extends string;
	execute: (args: infer A, ...rest: any[]) => any;
}
	? StepGates<M, S> & {
			/** The tool to invoke, by NAME. */
			call: K & M;
			/** Why the agent is making this call - approval cards, audit logs. */
			reason?: string;
			onError?: ErrorMode;
			/** Gate this step behind a "confirm" suspension. */
			suspend?: boolean;
			/** false: fire without waiting (detaches under a session). */
			await?: boolean;
		} & (
				| ({ each?: undefined; max?: undefined } & ArgsSlot<A, S>)
				| {
						/** Fan out: expression yielding the ARRAY of args - one
						 * call per element (the element IS that call's args). */
						each: ExprLike<S>;
						/** Bound on elements (defaults to the per-step limit). */
						max?: number;
						args?: undefined;
				  }
			)
	: never;

/** One call step per mounted tool - `call` discriminates, `args` narrows. */
export type TypedCallStep<Fns, M = unknown, S = ExprScope> = {
	[K in keyof Fns]: CallStepOf<Fns[K], M, S>;
}[keyof Fns];

export type TypedLetStep<M = unknown, S = ExprScope> = StepGates<M, S> & {
	/** Pure derivation: binds the expression's value to `id`. */
	let: ExprLike<S>;
};

/** A step that is ONLY a conditional early return - a guard clause. */
export type TypedReturnStep<M = unknown, S = ExprScope> = {
	id?: M & string;
	if?: ExprLike<S>;
	return: ExprLike<S>;
	/** Explicit ordering: EARLIER step ids to wait for when no data flows. */
	after?: readonly string[];
};

export type TypedStep<Fns, M = unknown, S = ExprScope> =
	| TypedCallStep<Fns, M, S>
	| TypedLetStep<M, S>
	| TypedReturnStep<M, S>;

export type TypedScript<Fns> = {
	version?: "2";
	/** Agent-chosen run name (sessions: joined via `await.<id>`). */
	id?: string;
	/** false: the run may detach under a session. */
	await?: boolean;
	/** One-line intent; derived from the first call's reason when omitted. */
	intent?: string;
	steps: readonly TypedStep<Fns>[];
	/** Expression projecting the run's output; default: the last step's. */
	output?: ExprLike;
};

/* ----------------------- scope inference machinery ----------------------- */
/*
 * Constraints TypeScript imposes on this design (all verified against the
 * compiler, not chosen):
 *
 * - the arrows' contextual scope can only draw on ONE inferred tuple: a
 *   second type parameter is not resolved yet when contextual typing
 *   happens, so `id` and `call` share a slot and are split back apart by
 *   Extract/Exclude against the mounted fn keys
 * - a context-sensitive arrow's return type never lands in the tuple, so
 *   a `let` step's emit is `any`, never its arrow's return
 * - the emit conditional must be non-distributive: an id-less call step
 *   excludes to `never`, and a distributive conditional would turn the
 *   whole scope into `never`
 */

/** The mounted tool names - the literal `call` values. */
type FnKeysOf<Fns> = {
	[K in keyof Fns]: Fns[K] extends { name: infer Key extends string }
		? Key
		: never;
}[keyof Fns];

/** The (awaited) return type of the tool mounted under `Key`. */
type ReturnOfKey<Fns, Key> = {
	[K in keyof Fns]: Fns[K] extends {
		name: infer FK extends string;
		execute: (args: any, ...rest: any[]) => infer R;
	}
		? Key extends FK
			? Awaited<R>
			: never
		: never;
}[keyof Fns];

/** What one settled step binds into the session namespace: its `id`
 * (the mark minus any tool name) maps to the called tool's return - or
 * `any` when nothing typed produced it (a `let`/`return` step's id). */
type StepEmit<Fns, Mark> = [Exclude<Mark, FnKeysOf<Fns>>] extends [
	infer Id extends string,
]
	? [Extract<Mark, FnKeysOf<Fns>>] extends [never]
		? { [P in Id]: any }
		: { [P in Id]: ReturnOfKey<Fns, Extract<Mark, FnKeysOf<Fns>>> }
	: Record<never, never>;

/** Fold the marks BEFORE index `I` into the bindings those steps produce.
 * An `I` that is never a tuple index (see `ScopeAll`) folds everything. */
type ScopeBefore<
	Fns,
	Marks extends readonly unknown[],
	I extends PropertyKey,
	Counter extends readonly unknown[] = [],
	Acc = unknown,
> = `${Counter["length"]}` extends I
	? Acc
	: Marks extends readonly [infer H, ...infer T]
		? ScopeBefore<Fns, T, I, [...Counter, unknown], Acc & StepEmit<Fns, H>>
		: Acc;

/** Every step's bindings - the scope of the `output` expression. */
type ScopeAll<Fns, Marks extends readonly unknown[]> = ScopeBefore<
	Fns,
	Marks,
	"",
	[],
	unknown
>;

/** The known bindings plus the open remainder of the session namespace
 * (variables, `input`, `$calls`, forEach bindings). Declared properties
 * win over the index signature, so known ids keep their types. */
type ScopedExprScope<Known> = Known & Record<string, any>;

/** The steps as ONE reverse-mapped tuple: element `I`'s literals (id,
 * call key) infer into `Marks[I]`, and its expression arrows are typed
 * against the fold of the marks before it. */
export type TypedStepsOf<Fns, Marks extends readonly unknown[]> = {
	[I in keyof Marks]: TypedStep<
		Fns,
		Marks[I],
		ScopedExprScope<ScopeBefore<Fns, Marks, I>>
	>;
};

/** `TypedScript`, with authoring arrows typed from the steps before them.
 * The engine doors (`engine.script`, `engine.tool`) infer `Marks` per
 * call site; this type is not meant to be written by hand. */
export type TypedScriptOf<Fns, Marks extends readonly unknown[]> = {
	version?: "2";
	/** Agent-chosen run name (sessions: joined via `await.<id>`). */
	id?: string;
	/** false: the run may detach under a session. */
	await?: boolean;
	/** One-line intent; derived from the first call's reason when omitted. */
	intent?: string;
	steps: TypedStepsOf<Fns, Marks>;
	/** Expression projecting the run's output; default: the last step's. */
	output?: ExprLike<ScopedExprScope<ScopeAll<Fns, Marks>>>;
};
