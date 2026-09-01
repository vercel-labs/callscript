/**
 * Provider-free Mastra adapter tour.
 *
 *   bun examples/mastra.ts
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fromMastraTools, toMastraTools } from "../src/adapters/mastra.ts";
import { callscript } from "../src/index.ts";

const weather = createTool({
	id: "weather-source",
	description: "look up a city's weather",
	inputSchema: z.object({ city: z.string() }),
	outputSchema: z.object({ temperature: z.number() }),
	execute: async ({ city }) => ({ temperature: city.length }),
});

const engine = callscript({
	tools: fromMastraTools({ weather }),
});

const result = await engine.run({
	script: `
const forecast = await weather({ city: "Brisbane" });
return forecast;
`,
});
console.log("callscript result:", result);

// A real Mastra application can pass this record to:
// new Agent({ ..., tools: toMastraTools(engine) })
const mastraTools = toMastraTools(engine);
console.log("Mastra tools:", Object.keys(mastraTools));
