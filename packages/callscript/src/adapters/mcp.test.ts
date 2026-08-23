import { describe, expect, it } from "vitest";
import { callscript } from "../engine";
import { fromMCP, type McpClientLike } from "./mcp";

/* ------------------------------- fixtures -------------------------------- */

const makeClient = () => {
	const calls: Array<{ name: string; arguments?: Record<string, unknown> }> =
		[];
	const client: McpClientLike = {
		listTools: async () => ({
			tools: [
				{
					name: "list_issues",
					description: "list the issues of a repo",
					inputSchema: {
						type: "object",
						properties: { repo: { type: "string" } },
						required: ["repo"],
					},
				},
				{
					name: "close_issue",
					description: "close an issue by number",
					inputSchema: {
						type: "object",
						properties: { number: { type: "number" } },
						required: ["number"],
					},
				},
				{ name: "fail_tool" },
				{ name: "text_tool" },
			],
		}),
		callTool: async (params) => {
			calls.push(params);
			switch (params.name) {
				case "list_issues":
					return {
						content: [{ type: "text", text: "ignored when structured" }],
						structuredContent: [
							{ number: 1, stale: true },
							{ number: 2, stale: false },
							{ number: 3, stale: true },
						],
					};
				case "close_issue":
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ closed: params.arguments?.number }),
							},
						],
					};
				case "text_tool":
					return { content: [{ type: "text", text: "plain words" }] };
				case "fail_tool":
					return {
						isError: true,
						content: [{ type: "text", text: "server exploded" }],
					};
				default:
					throw new Error(`unknown tool ${params.name}`);
			}
		},
	};
	return { client, calls };
};

/* --------------------------------- tests --------------------------------- */

describe("fromMCP", () => {
	it("mounts the listing under a namespace, cards carried over", async () => {
		const { client } = makeClient();
		const tools = await fromMCP(client, { namespace: "github" });
		const engine = callscript({ tools });
		expect(engine.toolNames.sort()).toEqual([
			"github.close_issue",
			"github.fail_tool",
			"github.list_issues",
			"github.text_tool",
		]);
		const listed = tools.find((t) => t.name === "github.list_issues");
		expect(listed?.description).toBe("list the issues of a repo");
		expect(listed?.inputSchema).toMatchObject({ type: "object" });
	});

	it("runs a script end to end through callTool", async () => {
		const { client, calls } = makeClient();
		const engine = callscript({ tools: await fromMCP(client) });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "issues", call: "list_issues", args: { repo: "api" } },
					{ id: "stale", let: "issues.filter(i => i.stale)" },
					{
						id: "done",
						call: "close_issue",
						each: "stale.map(i => ({ number: i.number }))",
						max: 10,
					},
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			// structuredContent preferred; text JSON parsed for close_issue
			expect(result.output).toEqual([{ closed: 1 }, { closed: 3 }]);
		}
		expect(calls.map((c) => c.name)).toEqual([
			"list_issues",
			"close_issue",
			"close_issue",
		]);
	});

	it("plain text results come back as strings", async () => {
		const { client } = makeClient();
		const engine = callscript({ tools: await fromMCP(client) });
		const result = await engine.run({
			script: { steps: [{ id: "t", call: "text_tool", args: {} }] },
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toBe("plain words");
		}
	});

	it("isError results fail the step with code mcp_tool_error", async () => {
		const { client } = makeClient();
		const engine = callscript({ tools: await fromMCP(client) });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "boom", call: "fail_tool", args: {}, onError: "skip" },
					{ id: "seen", let: "$errors.boom" },
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toMatchObject({
				code: "mcp_tool_error",
				message: "server exploded",
			});
		}
	});

	it("overrides add errors and description metadata", async () => {
		const { client } = makeClient();
		const tools = await fromMCP(client, {
			overrides: {
				list_issues: { errors: ["not_found"], description: "overridden" },
			},
		});
		const listed = tools.find((t) => t.name === "list_issues");
		expect(listed?.errors).toEqual(["not_found"]);
		expect(listed?.description).toBe("overridden");
	});
});
