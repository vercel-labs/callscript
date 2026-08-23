/**
 * Input-addressed memoization for DECLARED-idempotent tools: same tool +
 * same resolved args -> one dispatch per scope. The memo table rides the
 * scope (like the session state), so runs sharing a scope share it;
 * failures never cache.
 */
import { describe, expect, it } from "vitest";
import { callscript } from "./engine";
import { tool } from "./tool";

const makeTools = () => {
	let lookups = 0;
	let posts = 0;
	const lookup = tool({
		name: "svc.lookup",
		idempotent: true,
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		execute: (args: { id: string }) => {
			lookups++;
			return { id: args.id, n: lookups };
		},
	});
	const post = tool({
		name: "svc.post",
		execute: (args: { id: string }) => {
			posts++;
			return { id: args.id, n: posts };
		},
	});
	return {
		tools: [lookup, post] as const,
		counts: () => ({ lookups, posts }),
	};
};

describe("idempotent tool memoization", () => {
	it("dedupes same-args calls - including CONCURRENT independent steps", async () => {
		const { tools, counts } = makeTools();
		const engine = callscript({ tools });
		const result = await engine.run(
			{
				script: {
					steps: [
						{ id: "a", call: "svc.lookup", args: { id: "x" }, reason: "r" },
						{ id: "b", call: "svc.lookup", args: { id: "x" }, reason: "r" },
						{ id: "c", call: "svc.lookup", args: { id: "y" }, reason: "r" },
						{ id: "out", let: "[a.n, b.n, c.id]" },
					],
				},
			},
			engine.scope(),
		);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		// a and b (same args) shared one dispatch; c (different args) got its own.
		expect(result.output).toEqual([1, 1, "y"]);
		expect(counts().lookups).toBe(2);
	});

	it("non-idempotent tools always dispatch", async () => {
		const { tools, counts } = makeTools();
		const engine = callscript({ tools });
		await engine.run(
			{
				script: {
					steps: [
						{ id: "a", call: "svc.post", args: { id: "x" }, reason: "r" },
						{
							id: "b",
							call: "svc.post",
							args: { id: "x" },
							reason: "r",
							after: ["a"],
						},
					],
				},
			},
			engine.scope(),
		);
		expect(counts().posts).toBe(2);
	});

	it("the memo table rides the scope - runs sharing a scope share it", async () => {
		const { tools, counts } = makeTools();
		const engine = callscript({ tools });
		const scope = engine.scope();
		const script = {
			steps: [{ id: "a", call: "svc.lookup", args: { id: "x" }, reason: "r" }],
		};
		await engine.run({ script }, scope);
		await engine.run(
			{
				script: {
					steps: [
						{ id: "b", call: "svc.lookup", args: { id: "x" }, reason: "r" },
					],
				},
			},
			scope,
		);
		expect(counts().lookups).toBe(1);

		// A fresh scope has its own table.
		await engine.run({ script }, engine.scope());
		expect(counts().lookups).toBe(2);
	});

	it("without a scope there is no table - every run dispatches", async () => {
		const { tools, counts } = makeTools();
		const engine = callscript({ tools });
		const script = {
			steps: [{ id: "a", call: "svc.lookup", args: { id: "x" }, reason: "r" }],
		};
		await engine.run({ script });
		await engine.run({ script });
		expect(counts().lookups).toBe(2);
	});

	it("failures never cache - the retry dispatches again", async () => {
		let attempts = 0;
		const flaky = tool({
			name: "svc.flaky",
			idempotent: true,
			execute: (_args: { id: string }) => {
				attempts++;
				if (attempts === 1) throw new Error("transient");
				return "ok";
			},
		});
		const engine = callscript({ tools: [flaky] });
		const scope = engine.scope();
		const script = {
			steps: [{ id: "a", call: "svc.flaky", args: { id: "x" }, reason: "r" }],
		};
		const first = await engine.run({ script }, scope);
		expect(first.status).toBe("error");
		const second = await engine.run({ script }, scope);
		expect(second.status).toBe("ok");
		expect(attempts).toBe(2);
	});

	it("the tool card advertises idempotence", () => {
		const { tools } = makeTools();
		const engine = callscript({ tools });
		const text = engine.describe();
		expect(text).toContain("svc.lookup({ id: string })");
		expect(text).toMatch(
			/svc\.lookup.*\n\s+idempotent \(same args -> one call per session\)/,
		);
		expect(text).not.toMatch(/svc\.post.*\n\s+idempotent/);
	});
});
