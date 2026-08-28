import { describe, expect, it } from "vitest";
import { previewValue, renderJsonSchemaType, toolCard } from "./describe";
import { callscript } from "./engine";
import { tool } from "./tool";

/* ------------------------------- fixtures -------------------------------- */

const makeEngine = (
	opts: { requireReason?: boolean; format?: "js" | "json" } = {},
) => {
	const listIssues = tool({
		name: "issues.list",
		inputSchema: {
			type: "object",
			properties: {
				repo: { type: "string" },
				state: { enum: ["open", "closed"] },
			},
			required: ["repo"],
		},
		execute: (_args: { repo: string; state?: "open" | "closed" }) => [
			{ number: 1, title: "old bug", stale: true },
			{ number: 2, title: "fresh bug", stale: false },
		],
	});
	const closeIssue = tool({
		name: "issues.close",
		description: "close an issue by number",
		inputSchema: {
			type: "object",
			properties: { repo: { type: "string" }, number: { type: "number" } },
			required: ["repo", "number"],
		},
		outputSchema: {
			type: "object",
			properties: { closed: { type: "number" } },
			required: ["closed"],
		},
		errors: ["not_found"],
		execute: (args: { repo: string; number: number }) => ({
			closed: args.number,
		}),
	});
	return callscript({ tools: [listIssues, closeIssue], ...opts });
};

/* ------------------------------ type rendering ---------------------------- */

describe("renderJsonSchemaType", () => {
	it("renders primitives, enums, optionals, nesting, tuples", () => {
		expect(renderJsonSchemaType({ type: "string" })).toBe("string");
		expect(renderJsonSchemaType({ enum: ["a", "b"] })).toBe('"a" | "b"');
		expect(renderJsonSchemaType(undefined)).toBe("any");
		expect(
			renderJsonSchemaType({
				type: "object",
				properties: { repo: { type: "string" }, n: { type: "number" } },
				required: ["repo"],
			}),
		).toBe("{ repo: string, n?: number }");
		expect(
			renderJsonSchemaType({
				type: "object",
				properties: {
					user: {
						type: "object",
						properties: { id: { type: "string" } },
						required: ["id"],
					},
				},
				required: ["user"],
			}),
		).toBe("{ user: { id: string } }");
		expect(
			renderJsonSchemaType({
				type: "array",
				prefixItems: [{ type: "string" }, { type: "number" }],
			}),
		).toBe("[string, number]");
	});

	it("renders arrays with their element type", () => {
		expect(renderJsonSchemaType({ type: "array" })).toBe("any[]");
		expect(
			renderJsonSchemaType({ type: "array", items: { type: "string" } }),
		).toBe("string[]");
		expect(
			renderJsonSchemaType({
				type: "array",
				items: {
					type: "object",
					properties: {
						number: { type: "number" },
						stale: { type: "boolean" },
					},
					required: ["number", "stale"],
				},
			}),
		).toBe("{ number: number, stale: boolean }[]");
		expect(
			renderJsonSchemaType({
				type: "array",
				items: { enum: ["open", "closed"] },
			}),
		).toBe('("open" | "closed")[]');
	});

	it("renders unions, consts, integers, and open objects", () => {
		expect(
			renderJsonSchemaType({ anyOf: [{ type: "string" }, { type: "null" }] }),
		).toBe("string | null");
		expect(renderJsonSchemaType({ const: 42 })).toBe("42");
		expect(renderJsonSchemaType({ type: "integer" })).toBe("number");
		expect(renderJsonSchemaType({ type: "object" })).toBe("object");
		expect(
			renderJsonSchemaType({
				type: "object",
				additionalProperties: { type: "number" },
			}),
		).toBe("Record<string, number>");
	});
});

/* -------------------------------- tool cards ------------------------------ */

describe("toolCard", () => {
	it("renders the signature with description and error codes", () => {
		expect(
			toolCard({
				name: "issues.close",
				description: "close an issue by number",
				inputSchema: {
					type: "object",
					properties: { repo: { type: "string" }, number: { type: "number" } },
					required: ["repo", "number"],
				},
				outputSchema: {
					type: "object",
					properties: { closed: { type: "number" } },
					required: ["closed"],
				},
				errors: ["not_found"],
			}),
		).toBe(
			"issues.close({ repo: string, number: number }) -> { closed: number }\n" +
				"  close an issue by number\n" +
				"  errors: not_found",
		);
	});

	it("a schema-less tool renders as () with no return", () => {
		expect(toolCard({ name: "ping" })).toBe("ping()");
	});
});

describe("engine.describe", () => {
	it("renders signatures from the declared schemas", () => {
		const text = makeEngine().describe();
		expect(text).toContain(
			'issues.list({ repo: string, state?: "open" | "closed" })',
		);
		expect(text).toContain(
			"issues.close({ repo: string, number: number }) -> { closed: number }",
		);
		expect(text).toContain("errors: not_found");
	});

	it("teaches the JS surface by default", () => {
		const text = makeEngine().describe();
		expect(text).toContain("## callscript");
		expect(text).toContain("NEVER executed as JS");
		expect(text).toContain("Promise.all");
		// the tool cards still ride along
		expect(text).toContain(
			'issues.list({ repo: string, state?: "open" | "closed" })',
		);
	});

	it("format: 'json' carries the language card with the engine's limits and reason rule", () => {
		const text = makeEngine({
			requireReason: true,
			format: "json",
		}).describe();
		expect(text).toContain("## callscript");
		expect(text).toContain('"max" <= 100');
		expect(text).toContain("RUN by dependency");
		expect(text).toContain('every call step MUST carry a non-empty "reason"');
		expect(makeEngine({ format: "json" }).describe()).not.toContain(
			"MUST carry",
		);
	});

	it("a compiled script mounted as a tool renders like any tool", () => {
		const inner = makeEngine();
		const closeStale = inner.tool(
			"issues.closeStale",
			{
				steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
			},
			{ description: "close every stale issue in a repo" },
		);
		const outer = callscript({ tools: [closeStale] });
		expect(outer.describe()).toContain("issues.closeStale()");
		expect(outer.describe()).toContain("close every stale issue in a repo");
	});
});

/* ------------------------------ tool definition ---------------------------- */

describe("engine.toolDefinition", () => {
	it("defaults to the JS surface: language card + one string field", () => {
		const def = makeEngine().toolDefinition();
		expect(def.description).toContain("NEVER executed as JS");
		expect(def.description).toContain(
			'issues.list({ repo: string, state?: "open" | "closed" })',
		);
		const schema = def.inputSchema as any;
		expect(schema.required).toEqual(["script"]);
		expect(schema.properties.script.type).toBe("string");
	});

	it("format: 'json' pairs the base card + tool cards with the script JSON schema", () => {
		const def = makeEngine({ format: "json" }).toolDefinition();
		// prose half: what a schema cannot say, plus the signatures
		expect(def.description).toContain("## callscript");
		expect(def.description).toContain('"=issue.number"');
		expect(def.description).toContain("$errors.<stepId>");
		expect(def.description).toContain(
			'issues.list({ repo: string, state?: "open" | "closed" })',
		);
		// the step-shape catalog lives in the SCHEMA now, not the prose
		expect(def.description).not.toContain('{ "id": "x", "call": "tool.key"');
		// schema half: ONE annotated step shape under $defs
		const schema = def.inputSchema as any;
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["steps"]);
		expect(Object.keys(schema.$defs)).toEqual(["step"]);
		// the verb rule: at least one of call/let/return
		expect(schema.$defs.step.anyOf).toEqual([
			{ required: ["call"] },
			{ required: ["let"] },
			{ required: ["return"] },
		]);
		expect(schema.$defs.step.properties.args.description).toContain('"="');
		expect(schema.$defs.step.description).toContain("RUN by dependency");
	});

	it("renders against the engine's limits and reason rule", () => {
		const def = callscript({
			tools: [],
			requireReason: true,
			limits: { maxSteps: 7, maxItemsPerStep: 3 },
			format: "json",
		}).toolDefinition();
		const schema = def.inputSchema as any;
		expect(schema.properties.steps.maxItems).toBe(7);
		expect(schema.$defs.step.properties.max.maximum).toBe(3);
		expect(schema.$defs.step.anyOf[0]).toEqual({
			required: ["call", "reason"],
		});
		expect(def.description).toContain('"max" <= 3');
	});

	it("the schema shape accepts what validateScript accepts", () => {
		// structural sanity: every field the validator allows on a step has a
		// schema entry, so the annotated schema never contradicts the shape
		const engine = makeEngine();
		const script = engine.validate({
			intent: "close stale issues",
			steps: [
				{ id: "issues", call: "issues.list", args: { repo: "api" } },
				{ id: "stale", let: "issues.filter(i => i.stale)" },
				{ if: "stale.length === 0", return: "'nothing to do'" },
				{
					call: "issues.close",
					each: "stale.map(item => ({ repo: 'api', number: item.number }))",
					max: 10,
					onError: "skip",
					after: ["issues"],
				},
			],
			output: "stale.length",
		});
		const props = Object.keys(
			(makeEngine({ format: "json" }).toolDefinition().inputSchema as any).$defs
				.step.properties,
		);
		for (const step of script.steps) {
			for (const key of Object.keys(step)) {
				expect(props).toContain(key);
			}
		}
	});
});

/* ------------------------------ session card ------------------------------ */

describe("engine.context", () => {
	it("is empty without a state or before any run", () => {
		const engine = makeEngine();
		expect(engine.context()).toContain("(empty");
	});

	it("previews step outputs published by prior runs", async () => {
		const engine = makeEngine();
		const result = await engine.run({
			script: {
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{
						id: "stale",
						let: "issues.filter(i => i.stale).map(i => i.number)",
					},
				],
			},
		});
		const card = engine.context(result.state);
		expect(card).toContain("session variables");
		// a step output: first element preview + count
		expect(card).toMatch(
			/issues\s+= \[\{number: 1, title: "old bug", stale: true\}, …2 items\]/,
		);
		expect(card).toMatch(/stale\s+= \[1\]/);
	});
});

/* ------------------------------ value previews ---------------------------- */

describe("previewValue", () => {
	it("truncates long strings, deep objects, and wide objects", () => {
		expect(previewValue("x".repeat(60))).toBe(`"${"x".repeat(24)}…"`);
		expect(previewValue({ a: { b: { c: 1 } } })).toBe("{a: {b: {…}}}");
		expect(previewValue({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe(
			"{a: 1, b: 2, c: 3, d: 4, …}",
		);
		expect(previewValue([])).toBe("[]");
		expect(previewValue(null)).toBe("null");
		// short primitive lists show whole; object rows show fields + count
		expect(previewValue([1, 3, 5])).toBe("[1, 3, 5]");
		expect(previewValue([1, 2, 3, 4, 5, 6])).toBe("[1, …6 items]");
		expect(previewValue([{ n: 1 }, { n: 2 }])).toBe("[{n: 1}, …2 items]");
	});
});
