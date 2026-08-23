import { tool as aiTool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callscript } from "../engine";
import { fromAISDKTools } from "./ai-sdk";

/* ------------------------------- fixtures -------------------------------- */

const makeToolSet = () => {
	const closed: number[] = [];
	const set = {
		"github.listIssues": aiTool({
			description: "list the issues of a repo",
			inputSchema: z.object({
				repo: z.string(),
				state: z.enum(["open", "closed"]).optional(),
			}),
			execute: async ({ repo }) => [
				{ number: 1, title: "old bug", stale: true, repo },
				{ number: 2, title: "fresh bug", stale: false, repo },
				{ number: 3, title: "old chore", stale: true, repo },
			],
		}),
		"github.closeIssue": aiTool({
			description: "close an issue by number",
			inputSchema: z.object({ repo: z.string(), number: z.number() }),
			execute: async ({ number }) => {
				closed.push(number);
				return { closed: number };
			},
		}),
	};
	return { set, closed: () => closed };
};

/* --------------------------------- tests --------------------------------- */

describe("fromAISDKTools", () => {
	it("record keys become the registry names", () => {
		const { set } = makeToolSet();
		const engine = callscript({ tools: fromAISDKTools(set) });
		expect(engine.toolNames.sort()).toEqual([
			"github.closeIssue",
			"github.listIssues",
		]);
	});

	it("runs a script end to end through AI SDK executes", async () => {
		const { set, closed } = makeToolSet();
		const engine = callscript({ tools: fromAISDKTools(set) });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
					{ id: "stale", let: "issues.filter(i => i.stale)" },
					{
						id: "done",
						call: "github.closeIssue",
						each: "stale.map(i => ({ repo: 'api', number: i.number }))",
						max: 10,
					},
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual([{ closed: 1 }, { closed: 3 }]);
		}
		expect(closed()).toEqual([1, 3]);
	});

	it("validates args against the tool's schema before execute fires", async () => {
		const { set, closed } = makeToolSet();
		const engine = callscript({ tools: fromAISDKTools(set) });
		const result = await engine.run({
			script: {
				steps: [
					{ call: "github.closeIssue", args: { repo: "api", number: "one" } },
				],
			},
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("invalid_tool_args");
		}
		expect(closed()).toEqual([]); // never reached the tool
	});

	it("renders tool cards from the zod schemas", () => {
		const { set } = makeToolSet();
		const engine = callscript({ tools: fromAISDKTools(set) });
		const text = engine.describe();
		expect(text).toContain(
			'github.listIssues({ repo: string, state?: "open" | "closed" })',
		);
		expect(text).toContain("list the issues of a repo");
	});

	it("overrides add callscript-level metadata", () => {
		const { set } = makeToolSet();
		const tools = fromAISDKTools(set, {
			overrides: {
				"github.listIssues": { errors: ["rate_limited"] },
			},
		});
		const engine = callscript({ tools });
		const text = engine.describe();
		expect(text).toMatch(/github\.listIssues.*\n.*\n\s+errors: rate_limited/);
	});

	it("namespace prefixes every registry name", async () => {
		const flat = {
			ping: aiTool({
				inputSchema: z.object({}),
				execute: async () => "pong",
			}),
		};
		const engine = callscript({
			tools: fromAISDKTools(flat, { namespace: "net" }),
		});
		expect(engine.toolNames).toEqual(["net.ping"]);
		const result = await engine.run({
			script: { steps: [{ id: "p", call: "net.ping", args: {} }] },
		});
		expect(result.status).toBe("ok");
	});

	it("namespaced records mount side by side by spreading", () => {
		const a = {
			go: aiTool({ inputSchema: z.object({}), execute: async () => 1 }),
		};
		const b = {
			go: aiTool({ inputSchema: z.object({}), execute: async () => 2 }),
		};
		const engine = callscript({
			tools: [
				...fromAISDKTools(a, { namespace: "alpha" }),
				...fromAISDKTools(b, { namespace: "beta" }),
			],
		});
		expect(engine.toolNames.sort()).toEqual(["alpha.go", "beta.go"]);
	});

	it("overrides stay keyed by the record's own keys under a namespace", () => {
		const { set } = makeToolSet();
		const tools = fromAISDKTools(set, {
			namespace: "gh",
			overrides: { "github.listIssues": { errors: ["rate_limited"] } },
		});
		const engine = callscript({ tools });
		expect(engine.describe()).toMatch(
			/gh\.github\.listIssues[\s\S]*?rate_limited/,
		);
	});

	it("rejects execute-less (client-side) tools upfront", () => {
		expect(() =>
			fromAISDKTools({
				clientThing: { description: "no execute", inputSchema: z.object({}) },
			}),
		).toThrow(/has no execute/);
	});

	it("passes AI-SDK-shaped call options to execute", async () => {
		const seen: any[] = [];
		const probe = {
			probe: aiTool({
				inputSchema: z.object({ n: z.number() }),
				execute: async (args, options) => {
					seen.push(options);
					return args.n;
				},
			}),
		};
		const engine = callscript({ tools: fromAISDKTools(probe) });
		await engine.run({
			script: {
				steps: [{ id: "fan", call: "probe", each: "[{ n: 1 }, { n: 2 }]" }],
			},
		});
		expect(seen[0].toolCallId).toBe("fan[0]");
		expect(seen[1].toolCallId).toBe("fan[1]");
		expect(seen[0].messages).toEqual([]);
		expect(seen[0].experimental_context.stepId).toBe("fan");
	});
});
