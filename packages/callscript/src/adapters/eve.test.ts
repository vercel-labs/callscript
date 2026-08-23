import { describe, expect, it } from "vitest";
import { callscript } from "../engine";
import { tool } from "../tool";
import { toEveTools } from "./eve";

const closeIssue = tool({
	name: "github.closeIssue",
	description: "close an issue by number",
	execute: (args: { number: number }) => ({ closed: args.number }),
});

describe("toEveTools", () => {
	it("returns all three tools as branded eve definitions", () => {
		const engine = callscript({ tools: [closeIssue] });
		const { execute, search, describe: describeTool } = toEveTools(engine);
		// eve's defineTool stamps a brand lifecycle code validates - the
		// definitions must not be raw literals
		for (const def of [execute, search, describeTool]) {
			expect(def.description.length).toBeGreaterThan(0);
			expect(def.inputSchema).toMatchObject({ type: "object" });
			expect(typeof def.execute).toBe("function");
			expect(Object.getOwnPropertySymbols(def).length).toBeGreaterThan(0);
		}
	});

	it("execute runs scripts and search finds tools, sharing a session", async () => {
		const engine = callscript({ tools: [closeIssue] });
		const { execute, search } = toEveTools(engine);
		const found = await (search.execute as any)({ query: "close issue" });
		expect(found).toContain("github.closeIssue");
		const first = await (execute.execute as any)({
			steps: [{ id: "done", call: "github.closeIssue", args: { number: 7 } }],
		});
		expect(first).toEqual({ status: "ok", output: { closed: 7 } });
		// the pair shares one scope: the next script reads the last run's output
		const second = await (execute.execute as any)({
			steps: [{ id: "n", let: "done.closed + 1" }],
		});
		expect(second).toEqual({ status: "ok", output: 8 });
	});

	it("invalid scripts come back as issues, not throws", async () => {
		const engine = callscript({ tools: [closeIssue] });
		const { execute } = toEveTools(engine);
		const result = await (execute.execute as any)({
			steps: [{ call: "github.nope", args: {} }],
		});
		expect(result.status).toBe("invalid");
		expect(result.issues.join("\n")).toContain("github.nope");
	});
});
