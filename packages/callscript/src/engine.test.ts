import { describe, expect, it } from "vitest";
import { earlyReturn, scriptEngine, suspend } from "./engine";
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

/** Tools share per-session state through the scope's vars - the same
 * cells expressions read, writable from any dispatch. */
const login = tool({
	name: "auth.login",
	execute: (args: { id: string }, ctx) => {
		if (ctx.scope) ctx.scope.vars.cs_user = { id: args.id, name: "Ada" };
		return { ok: true };
	},
});

const whoami = tool({
	name: "auth.whoami",
	execute: (_args: void, ctx) => {
		const user = ctx.scope?.vars.cs_user;
		if (user === undefined) {
			throw Object.assign(new Error("auth.whoami: no user in scope"), {
				code: "missing_required_var",
			});
		}
		return user as { id: string; name: string };
	},
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

const tools = [listIssues, closeIssue, login, whoami, charge] as const;

/* --------------------------------- tests --------------------------------- */

describe("the tool registry", () => {
	it("tools are the mounted tools' names", () => {
		const engine = scriptEngine({ tools });
		expect(engine.tools.sort()).toEqual(
			[
				"issues.list",
				"issues.close",
				"auth.login",
				"auth.whoami",
				"pay.charge",
			].sort(),
		);
	});

	it("a call naming no mounted tool fails validation, not dispatch", () => {
		const engine = scriptEngine({ tools });
		expect(() =>
			engine.run({
				script: { steps: [{ call: "github.listIssues", args: {} }] },
			}),
		).toThrow(ScriptValidationError);
	});

	it("two different tools under one name are rejected at engine creation", () => {
		const a = tool({ name: "dup.name", execute: () => 1 });
		const b = tool({ name: "dup.name", execute: () => 2 });
		expect(() => scriptEngine({ tools: [a, b] })).toThrow(
			/share the name "dup\.name"/,
		);
	});

	it("the SAME tool mounted twice is fine", () => {
		expect(scriptEngine({ tools: [listIssues, listIssues] }).tools).toEqual([
			"issues.list",
		]);
	});
});

describe("dispatch through the tool door", () => {
	it("runs a script end to end", async () => {
		const engine = scriptEngine({ tools });
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
		const engine = scriptEngine({ tools: [probe] });
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
		const engine = scriptEngine({ tools });
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

describe("scope vars across steps", () => {
	it("a var set by one step's tool is read by the next - one run, one scope", async () => {
		const engine = scriptEngine({ tools });
		const result = await engine.run(
			{
				script: {
					steps: [
						{ id: "session", call: "auth.login", args: { id: "u1" } },
						{ id: "me", call: "auth.whoami", after: ["session"] },
					],
				},
			},
			engine.scope(),
		);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ id: "u1", name: "Ada" });
		}
	});

	it("a tool needing scope state fails its step when nothing set it", async () => {
		const engine = scriptEngine({ tools });
		const result = await engine.run(
			{ script: { steps: [{ id: "me", call: "auth.whoami" }] } },
			engine.scope(),
		);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("missing_required_var");
		}
	});

	it("scope(seed) seeds the vars for the whole run", async () => {
		const engine = scriptEngine({ tools });
		const scope = engine.scope({ cs_user: { id: "u9", name: "Grace" } });
		const result = await engine.run(
			{ script: { steps: [{ id: "me", call: "auth.whoami" }] } },
			scope,
		);
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ id: "u9", name: "Grace" });
		}
	});

	it("seeded vars are readable from expressions", async () => {
		const engine = scriptEngine({ tools });
		const scope = engine.scope({ cs_user: { id: "u1", name: "Ada" } });
		const result = await engine.run(
			{ script: { steps: [{ id: "name", let: "cs_user.name" }] } },
			scope,
		);
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.output).toBe("Ada");
	});
});

describe("errors and signals", () => {
	it("a thrown error's code becomes the step error code", async () => {
		const engine = scriptEngine({ tools });
		const result = await engine.run({
			script: { steps: [{ call: "pay.charge", args: { amount: 100 } }] },
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("insufficient_funds");
		}
	});

	it("onError skip turns a refusal into undefined and continues", async () => {
		const engine = scriptEngine({ tools });
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
		const engine = scriptEngine({ tools: [device] });
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
		const engine = scriptEngine({ tools: [verify] });
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
		const engine = scriptEngine({ tools, requireReason: true });
		expect(() =>
			engine.run({
				script: { steps: [{ call: "issues.list", args: { repo: "api" } }] },
			}),
		).toThrow(/reason is required/);
	});

	it("limits apply (maxSteps)", () => {
		const engine = scriptEngine({ tools, limits: { maxSteps: 1 } });
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
		const engine = scriptEngine({ tools });
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
		const engine = scriptEngine({ tools });
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

	it("a session handed a scope shares its vars across runs", async () => {
		const engine = scriptEngine({ tools });
		const scope = engine.scope();
		const sess = engine.session({}, scope);

		const first = await sess.start({
			steps: [{ id: "s", call: "auth.login", args: { id: "u7" } }],
		});
		expect(first.status).toBe("done");

		// No login in THIS run - cs_user survives on the scope.
		const second = await sess.start({
			steps: [{ id: "me", call: "auth.whoami" }],
		});
		expect(second.status).toBe("done");
		if (second.status === "done") {
			expect(second.output).toEqual({ id: "u7", name: "Ada" });
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
		const engine = scriptEngine({ tools: [slow, listIssues] });
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
