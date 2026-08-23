import { describe, expect, it } from "vitest";
import { searchTools } from "./describe";
import { callscript, suspend } from "./engine";
import { tool } from "./tool";

/* ------------------------------- fixtures -------------------------------- */

const listIssues = tool({
	name: "github.listIssues",
	description: "list the issues of a repo",
	execute: (args: { repo: string }) => [
		{ number: 1, stale: true, repo: args.repo },
		{ number: 2, stale: false, repo: args.repo },
	],
});

const closeIssue = tool({
	name: "github.closeIssue",
	description: "close an issue by number",
	execute: (args: { repo: string; number: number }) => ({
		closed: args.number,
	}),
});

const post = tool({
	name: "slack.post",
	description: "post a message to a slack channel",
	execute: (_args: { channel: string; text: string }) => ({ ok: true }),
});

const engine = () => callscript({ tools: [listIssues, closeIssue, post] });

/* ------------------------------ searchTools ------------------------------- */

describe("searchTools", () => {
	const mounted = [listIssues, closeIssue, post];

	it("matches by name segment above description", () => {
		const hits = searchTools(mounted, "close issue");
		expect(hits[0]!.name).toBe("github.closeIssue");
	});

	it("matches by description keywords", () => {
		const hits = searchTools(mounted, "slack message");
		expect(hits.map((t) => t.name)).toContain("slack.post");
	});

	it("returns nothing for a foreign query", () => {
		expect(searchTools(mounted, "kubernetes")).toEqual([]);
	});

	it("lists in mount order for an empty query, bounded by limit", () => {
		expect(searchTools(mounted, "", 2).map((t) => t.name)).toEqual([
			"github.listIssues",
			"github.closeIssue",
		]);
	});
});

/* ---------------------------- engine.agentTools --------------------------- */

describe("engine.agentTools", () => {
	it("exposes an execute/search pair with schemas and cards", () => {
		const { execute, search } = engine().agentTools();
		expect(execute.name).toBe("execute");
		expect(search.name).toBe("search");
		// few tools mounted -> the cards inline into execute's description
		expect(execute.description).toContain("github.closeIssue");
		expect(execute.inputSchema).toMatchObject({ type: "object" });
		expect(search.inputSchema).toMatchObject({ required: ["query"] });
	});

	it("execute runs a script and strips session state from the result", async () => {
		const { execute } = engine().agentTools();
		const result = await execute.execute({
			steps: [
				{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
				{
					id: "closed",
					call: "github.closeIssue",
					each: "issues.filter(i => i.stale).map(i => ({ repo: 'api', number: i.number }))",
					max: 5,
				},
			],
		});
		expect(result).toEqual({ status: "ok", output: [{ closed: 1 }] });
	});

	it("execute returns every validation issue instead of throwing", async () => {
		const { execute } = engine().agentTools();
		const result = await execute.execute({
			steps: [
				{ id: "a", call: "github.nope", args: {} },
				{ id: "b", let: "missing.length" },
			],
		});
		expect(result.status).toBe("invalid");
		if (result.status === "invalid") {
			expect(result.issues.length).toBeGreaterThanOrEqual(2);
			expect(result.issues.join("\n")).toContain("github.nope");
		}
	});

	it("runs share the pair's scope: later scripts read earlier outputs", async () => {
		const { execute } = engine().agentTools();
		const first = await execute.execute({
			steps: [
				{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
			],
		});
		expect(first.status).toBe("ok");
		const second = await execute.execute({
			steps: [{ id: "count", let: "issues.length" }],
		});
		expect(second).toEqual({ status: "ok", output: 2 });
	});

	it("suspended runs surface suspensions and resume on the same scope", async () => {
		const gate = tool({
			name: "auth.verify",
			execute: (args: { code?: string }) => {
				if (args.code === undefined) throw suspend({ key: "otp" });
				return { ok: true };
			},
		});
		const e = callscript({ tools: [gate] });
		const scope = e.scope();
		const { execute } = e.agentTools({ scope });
		const script = {
			steps: [{ id: "v", call: "auth.verify", args: { code: "=input.code" } }],
		};
		const first = await execute.execute(script);
		expect(first.status).toBe("suspended");
		// the state rode the scope - a plain engine.run resumes it
		const resumed = await e.run({ script, input: { code: "42" } }, scope);
		expect(resumed.status).toBe("ok");
	});

	it("search returns matching cards and a pointed miss message", async () => {
		const { search } = engine().agentTools();
		const hit = await search.execute({ query: "close issue" });
		expect(hit).toContain("github.closeIssue");
		expect(hit).toContain("close an issue by number");
		const miss = await search.execute({ query: "kubernetes" });
		expect(miss).toContain("no tools matched");
	});

	it("inlineTools: false moves the cards behind search", () => {
		const { execute } = engine().agentTools({ inlineTools: false });
		expect(execute.description).not.toContain("github.closeIssue");
		expect(execute.description).toContain("`search`");
	});

	it("names carry through the pair and its cross-references", () => {
		const { execute, search } = engine().agentTools({
			inlineTools: false,
			names: { execute: "run_script", search: "find_tools" },
		});
		expect(execute.name).toBe("run_script");
		expect(search.name).toBe("find_tools");
		expect(execute.description).toContain("`find_tools`");
		expect(search.description).toContain("`run_script`");
	});
});
