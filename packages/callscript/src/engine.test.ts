import { describe, expect, it } from "vitest";
import { callscript, earlyReturn, suspend } from "./engine";
import { tool } from "./tool";
import { ScriptValidationError } from "./validate";

/* ------------------------------- fixtures -------------------------------- */

const listIssues = tool({
	name: "issues.list",
	execute: (args: { repo: string }) => [
		{ number: 1, title: "old bug", stale: true, repo: args.repo },
		{ number: 2, title: "fresh bug", stale: false, repo: args.repo },
		{ number: 3, title: "old chore", stale: true, repo: args.repo },
	],
});

const closeIssue = tool({
	name: "issues.close",
	execute: (args: { repo: string; number: number }) => ({
		closed: args.number,
	}),
});

/** A declared refusal: the thrown error's `code` is the step error code. */
const charge = tool({
	name: "pay.charge",
	errors: ["insufficient_funds"],
	execute: (args: { amount: number }) => {
		if (args.amount > 5) {
			throw Object.assign(new Error("insufficient funds"), {
				code: "insufficient_funds",
				balance: 5,
			});
		}
		return { charged: args.amount };
	},
});

const tools = [listIssues, closeIssue, charge] as const;

/* --------------------------------- tests --------------------------------- */

describe("the tool registry", () => {
	it("tools are the mounted tools' names", () => {
		const engine = callscript({ tools });
		expect(engine.toolNames.sort()).toEqual(
			["issues.list", "issues.close", "pay.charge"].sort(),
		);
	});

	it("a call naming no mounted tool fails validation, not dispatch", () => {
		const engine = callscript({ tools });
		expect(() =>
			engine.run({
				script: { steps: [{ call: "github.listIssues", args: {} }] },
			}),
		).toThrow(ScriptValidationError);
	});

	it("two different tools under one name are rejected at engine creation", () => {
		const a = tool({ name: "dup.name", execute: () => 1 });
		const b = tool({ name: "dup.name", execute: () => 2 });
		expect(() => callscript({ tools: [a, b] })).toThrow(
			/share the name "dup\.name"/,
		);
	});

	it("the SAME tool mounted twice is fine", () => {
		expect(callscript({ tools: [listIssues, listIssues] }).toolNames).toEqual([
			"issues.list",
		]);
	});
});

describe("dispatch through the tool door", () => {
	it("runs a script end to end", async () => {
		const engine = callscript({ tools });
		const result = await engine.run({
			script: {
				steps: [
					{
						id: "issues",
						call: "issues.list",
						args: { repo: "api" },
						reason: "list",
					},
					{
						id: "stale",
						let: "issues.filter(i => i.stale).map(i => i.number)",
					},
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.output).toEqual([1, 3]);
	});

	it("the dispatch context carries step id, reason, and item index", async () => {
		const seen: Array<{ stepId: string; reason?: string; itemIndex?: number }> =
			[];
		const probe = tool({
			name: "probe.call",
			execute: (args: { n: number }, ctx) => {
				seen.push({
					stepId: ctx.stepId,
					reason: ctx.reason,
					itemIndex: ctx.itemIndex,
				});
				return args.n;
			},
		});
		const engine = callscript({ tools: [probe] });
		await engine.run({
			script: {
				steps: [
					{
						id: "fan",
						call: "probe.call",
						each: "[{ n: 1 }, { n: 2 }]",
						reason: "probing",
					},
				],
			},
		});
		expect(seen).toEqual([
			{ stepId: "fan", reason: "probing", itemIndex: 0 },
			{ stepId: "fan", reason: "probing", itemIndex: 1 },
		]);
	});

	it("each fans out, one call per element", async () => {
		const engine = callscript({ tools });
		const result = await engine.run({
			script: {
				steps: [
					{ id: "issues", call: "issues.list", args: { repo: "api" } },
					{ id: "stale", let: "issues.filter(i => i.stale)" },
					{
						id: "closed",
						call: "issues.close",
						each: "stale.map(issue => ({ repo: 'api', number: issue.number }))",
						max: 10,
					},
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual([{ closed: 1 }, { closed: 3 }]);
		}
	});
});

describe("errors and signals", () => {
	it("a thrown error's code becomes the step error code", async () => {
		const engine = callscript({ tools });
		const result = await engine.run({
			script: { steps: [{ call: "pay.charge", args: { amount: 100 } }] },
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("insufficient_funds");
		}
	});

	it("onError skip turns a refusal into undefined and continues", async () => {
		const engine = callscript({ tools });
		const result = await engine.run({
			script: {
				steps: [
					{
						id: "paid",
						call: "pay.charge",
						args: { amount: 100 },
						onError: "skip",
					},
					{ id: "out", let: "({ paid: paid ?? 'declined' })" },
				],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ paid: "declined" });
		}
	});

	it("earlyReturn thrown from a tool ends the run with its payload", async () => {
		const device = tool({
			name: "auth.device",
			execute: () => {
				throw earlyReturn({ kind: "link", url: "https://auth/dev" });
			},
		});
		const engine = callscript({ tools: [device] });
		const result = await engine.run({
			script: { steps: [{ id: "link", call: "auth.device" }] },
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.returnedAt).toBe("link");
			expect(result.output).toEqual({ kind: "link", url: "https://auth/dev" });
		}
	});

	it("suspend parks the run; re-executing with input resumes", async () => {
		const verify = tool({
			name: "otp.verify",
			execute: (args: { code?: string }) => {
				if (args.code === undefined) {
					throw suspend({
						key: "otp",
						interaction: { id: "otp", kind: "code" },
					});
				}
				return { ok: args.code === "42" };
			},
		});
		const engine = callscript({ tools: [verify] });
		const script = {
			steps: [
				{ id: "check", call: "otp.verify", args: { code: "=input.code" } },
			],
		};

		const first = await engine.run({ script });
		expect(first.status).toBe("suspended");
		if (first.status !== "suspended") return;
		expect(first.suspensions[0]?.key).toBe("otp");

		const second = await engine.run({
			script,
			state: first.state,
			input: { code: "42" },
		});
		expect(second.status).toBe("ok");
		if (second.status === "ok") expect(second.output).toEqual({ ok: true });
	});
});

describe("options threaded to the engine", () => {
	it("requireReason rejects call steps without one", () => {
		const engine = callscript({ tools, requireReason: true });
		expect(() =>
			engine.run({
				script: { steps: [{ call: "issues.list", args: { repo: "api" } }] },
			}),
		).toThrow(/reason is required/);
	});

	it("limits apply (maxSteps)", () => {
		const engine = callscript({ tools, limits: { maxSteps: 1 } });
		expect(() =>
			engine.run({
				script: {
					steps: [
						{ id: "a", call: "issues.list", args: { repo: "x" } },
						{ id: "b", let: "a.length" },
					],
				},
			}),
		).toThrow(/Too many steps/);
	});

	it("analyze and render work off the validated script", () => {
		const engine = callscript({ tools });
		const script = engine.validate({
			steps: [
				{
					id: "issues",
					call: "issues.list",
					args: { repo: "api" },
					reason: "list",
				},
			],
		});
		expect(engine.analyze(script).tools).toEqual(["issues.list"]);
		expect(engine.render(script)).toContain("issues.list");
	});
});

describe("sessions", () => {
	it("published variables flow between runs, validated at the door", async () => {
		const engine = callscript({ tools });
		const sess = engine.session();

		const first = await sess.start({
			steps: [{ id: "issues", call: "issues.list", args: { repo: "api" } }],
		});
		expect(first.status).toBe("done");

		// `issues` has no producing step here - it is a session variable.
		const second = await sess.start({
			steps: [{ id: "titles", let: "issues.map(i => i.title)" }],
		});
		expect(second.status).toBe("done");
		if (second.status === "done") {
			expect(second.output).toEqual(["old bug", "fresh bug", "old chore"]);
		}
	});

	it("detached runs join via await.<id>", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = tool({
			name: "reports.slow",
			execute: async () => {
				await gate;
				return { report: "done" };
			},
		});
		const engine = callscript({ tools: [slow, listIssues] });
		const sess = engine.session({ deadlineMs: 0 });

		const started = await sess.start({
			id: "bg",
			await: false,
			steps: [{ id: "r", call: "reports.slow" }],
		});
		expect(started.status).toBe("pending");

		release();
		const joined = await sess.start({
			steps: [
				{
					id: "joined",
					call: "await.bg",
					reason: "collect the background run",
				},
			],
		});
		expect(joined.status).toBe("done");
		if (joined.status === "done") {
			expect(joined.output).toEqual({ report: "done" });
		}
	});
});
