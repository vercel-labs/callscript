import { createTool } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callscript } from "../engine";
import { fromMastraTools } from "./mastra";

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
});
