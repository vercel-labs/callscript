import { createTool, Tool } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callscript } from "../engine";
import { tool } from "../tool";
import { fromMastraTools, toMastraTools } from "./mastra";

describe("fromMastraTools", () => {
	it("mounts a native createTool under its record key and executes it", async () => {
		const weather = createTool({
			id: "weather-source",
			description: "look up a city's weather",
			inputSchema: z.object({ city: z.string() }),
			outputSchema: z.object({ temperature: z.number() }),
			execute: async ({ city }) => ({ temperature: city.length }),
		});

		const mounted = fromMastraTools({ weather });
		const engine = callscript({ tools: mounted });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "forecast", call: "weather", args: { city: "Brisbane" } },
				],
			},
		});

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ temperature: 8 });
		}
	});

	it("renders schemas and keeps the record key separate from the Mastra id", () => {
		const source = createTool({
			id: "source-weather",
			description: "source description",
			inputSchema: z.object({ city: z.string() }),
			outputSchema: z.object({ temperature: z.number() }),
			execute: async () => ({ temperature: 1 }),
		});
		const [mounted] = fromMastraTools({ weather: source });

		expect(mounted?.name).toBe("weather");
		expect(mounted?.description).toBe("source description");
		expect(mounted?.inputSchema).toMatchObject({ type: "object" });
		expect(mounted?.outputSchema).toMatchObject({ type: "object" });
		expect(source.id).toBe("source-weather");
	});

	it("supports namespaces and overrides keyed by original record keys", () => {
		const source = createTool({
			id: "source-ping",
			description: "source",
			inputSchema: z.object({}),
			execute: async () => "pong",
		});
		const [mounted] = fromMastraTools(
			{ ping: source },
			{
				namespace: "net",
				overrides: {
					ping: { description: "override", errors: ["offline"] },
				},
			},
		);

		expect(mounted).toMatchObject({
			name: "net.ping",
			description: "override",
			errors: ["offline"],
		});
	});

	it("rejects invalid input before Mastra execute runs", async () => {
		let calls = 0;
		const source = createTool({
			id: "source-close",
			description: "close",
			inputSchema: z.object({ number: z.number() }),
			execute: async () => {
				calls += 1;
				return "closed";
			},
		});
		const engine = callscript({ tools: fromMastraTools({ close: source }) });
		const result = await engine.run({
			script: { steps: [{ call: "close", args: { number: "one" } }] },
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("invalid_tool_args");
		}
		expect(calls).toBe(0);
	});

	it("maps Mastra output validation results to mastra_validation_error", async () => {
		const source = createTool({
			id: "source-broken",
			description: "broken output",
			inputSchema: z.object({}),
			outputSchema: z.object({ ok: z.boolean() }),
			execute: async () => ({
				ok: "not boolean" as unknown as boolean,
			}),
		});
		const engine = callscript({ tools: fromMastraTools({ broken: source }) });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "bad", call: "broken", args: {}, onError: "skip" },
					{ id: "error", let: "$errors.bad" },
				],
			},
		});

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toMatchObject({
				code: "mastra_validation_error",
			});
		}
	});

	it("rejects execute-less tools while mounting", () => {
		expect(() =>
			fromMastraTools({
				clientOnly: { id: "client-only", description: "not executable" },
			}),
		).toThrow(/has no execute/);
	});
});

describe("toMastraTools", () => {
	it("returns native Mastra execute, search, and describe tools", async () => {
		const ping = tool({
			name: "ping",
			description: "return pong",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			execute: async () => "pong",
		});
		const engine = callscript({ tools: [ping] });
		const mounted = toMastraTools(engine);
		const executeTool = mounted.execute;
		if (executeTool === undefined) {
			throw new Error("Mastra execute tool was not returned");
		}

		expect(Object.keys(mounted).sort()).toEqual([
			"describe",
			"execute",
			"search",
		]);
		expect(executeTool).toBeInstanceOf(Tool);
		expect(executeTool.id).toBe("execute");
		expect(executeTool.description).toContain("callscript");
		expect(executeTool.inputSchema).toMatchObject({
			"~standard": expect.anything(),
		});

		const result = await executeTool.execute?.(
			{ script: "const result = await ping({}); return result;" },
			undefined as never,
		);
		expect(result).toMatchObject({ status: "ok", output: "pong" });
	});

	it("preserves custom engine tool names in the Mastra record", () => {
		const engine = callscript({
			tools: [
				tool({
					name: "ping",
					description: "return pong",
					inputSchema: { type: "object" },
					execute: async () => "pong",
				}),
			],
		});
		const mounted = toMastraTools(engine, {
			names: { execute: "run", search: "find", describe: "inspect" },
		});

		expect(Object.keys(mounted).sort()).toEqual(["find", "inspect", "run"]);
		expect(mounted.run?.id).toBe("run");
	});
});
