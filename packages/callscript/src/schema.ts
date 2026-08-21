import { z } from "zod";
import type { Script } from "./types";

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

export const ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const idSchema = z
	.string()
	.regex(ID_PATTERN, "id must be a valid identifier (letters, digits, _)");

/** Optional on input - validateScript auto-assigns s1, s2, ... when omitted. */
const optionalIdSchema = idSchema.optional();

/**
 * ONE step shape. The verb is whichever of `call` / `let` / `return` is
 * present (at least one, and `call`/`let` never together - checked by
 * validateScript with pointed messages, not here). Everything else rides
 * along: guards (`if`, `return`), ordering (`after`), and the call-only
 * fields (`args`/`each`/`max`/`reason`/`onError`/`suspend`/`await`).
 */
export const stepSchema = z.strictObject({
	id: optionalIdSchema,
	if: z.string().min(1).optional(),
	return: z.string().min(1).optional(),
	/** Explicit ordering edges: earlier step ids to wait for (effect
	 * ordering when no data flows). */
	after: z.array(idSchema).optional(),
	call: z.string().min(1, "call names the tool to invoke").optional(),
	let: z.string().min(1).optional(),
	args: jsonValueSchema.optional(),
	/** Fan out: expression yielding the ARRAY of args, one call per element. */
	each: z.string().min(1).optional(),
	/** Bound on `each` elements - defaults to the per-step limit; the static
	 * bound always exists. */
	max: z.number().int().min(1).optional(),
	reason: z.string().min(1).optional(),
	onError: z.enum(["fail", "skip"]).optional(),
	/** Self-declared scrutiny: gate this step behind a "confirm" suspension. */
	suspend: z.boolean().optional(),
	/** false: fire without waiting (detaches under a runner) · true: wait
	 * explicitly (pins a background-by-default tool). Default: wait, except
	 * host-declared asyncTools. */
	await: z.boolean().optional(),
});

/** Agent-chosen run name (see `Script.id`): step-id grammar, no dots. */
const runIdSchema = idSchema.optional();

export const scriptSchema = z.object({
	version: z.literal("2").optional(),
	id: runIdSchema,
	await: z.boolean().optional(),
	intent: z.string().min(1).optional(),
	/** Deprecated alias of `intent` - validateScript normalizes it. */
	goal: z.string().min(1).optional(),
	steps: z.array(stepSchema).min(1),
	/** Expression projecting the run's output; defaults to the last step's value. */
	output: z.string().min(1).optional(),
});

/** The script shell with steps left raw - validateScript validates each step itself. */
export const scriptShellSchema = z.object({
	version: z.literal("2").optional(),
	id: runIdSchema,
	await: z.boolean().optional(),
	intent: z.string().min(1).optional(),
	/** Deprecated alias of `intent` - validateScript normalizes it. */
	goal: z.string().min(1).optional(),
	steps: z.array(z.record(z.string(), z.unknown())).min(1),
	/** Expression projecting the run's output; defaults to the last step's value. */
	output: z.string().min(1).optional(),
});

export type ScriptInput = z.input<typeof scriptSchema>;

/** Structural parse only. Prefer `validateScript` which also checks semantics and normalizes. */
export function parseScriptShape(input: unknown): Script {
	return scriptSchema.parse(input) as Script;
}
