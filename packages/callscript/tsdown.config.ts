import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		"ai-sdk": "./src/adapters/ai-sdk.ts",
		eve: "./src/adapters/eve.ts",
		mcp: "./src/adapters/mcp.ts",
	},
	format: ["esm"],
	fixedExtension: false,
	dts: true,
	clean: true,
	deps: { neverBundle: ["ai", "eve"] },
});
