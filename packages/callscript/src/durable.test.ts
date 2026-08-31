import { describe, expect, it } from "vitest";
import { createDurableRunner, memoryStorage } from "./durable";
import { suspend } from "./execute";

const tools = ["svc.echo", "svc.gate"];

const makeRunner = (storage = memoryStorage()) => {
	let gateCalls = 0;
	const runner = createDurableRunner({
		storage,
		tools,
		handlers: {
			call: async (request, ctx) => {
				if (request.tool === "svc.echo") return request.args;
				gateCalls++;
				const answer = ctx.resolutions.gate;
				if (answer === undefined) {
					throw suspend({
						key: "gate",
						interaction: { id: "gate", kind: "confirm", title: "Approve?" },
					});
				}
				return { approved: answer };
			},
		},
	});
	return { runner, calls: () => gateCalls };
};

describe("durable runner", () => {
	it("completes a plain run", async () => {
		const { runner } = makeRunner();
		const result = await runner.start({
			script: {
				steps: [{ id: "a", call: "svc.echo", args: { x: 1 }, reason: "r" }],
			},
			owner: "agent-1",
		});
		expect(result.status).toBe("completed");
		if (result.status === "completed") expect(result.output).toEqual({ x: 1 });
	});

	it("suspends, persists, and resumes with a resolution", async () => {
		const storage = memoryStorage();
		const { runner } = makeRunner(storage);
		const script = {
			id: "gated",
			steps: [
				{ id: "a", call: "svc.echo", args: { x: 1 }, reason: "r" },
				{ id: "g", call: "svc.gate", reason: "gate" },
			],
		};
		const first = await runner.start({ script, owner: "agent-1" });
		expect(first.status).toBe("suspended");
		if (first.status !== "suspended") return;
		expect(first.suspensions[0]?.key).toBe("gate");

		const stored = await storage.get("gated");
		expect(stored?.status).toBe("suspended");

		const second = await runner.resume("gated", {
			owner: "agent-1",
			resolutions: { gate: true },
		});
		expect(second.status).toBe("completed");
		if (second.status === "completed") {
			expect(second.output).toEqual({ approved: true });
		}
	});

	it("re-submitting the same script id with resolutions continues the run", async () => {
		const { runner } = makeRunner();
		const script = {
			id: "resubmit",
			steps: [{ id: "g", call: "svc.gate", reason: "gate" }],
		};
		const first = await runner.start({ script, owner: "agent-1" });
		expect(first.status).toBe("suspended");
		const second = await runner.start({
			script,
			owner: "agent-1",
			resolutions: { gate: "yes" },
		});
		expect(second.status).toBe("completed");
	});

	it("rejects another owner and a different script under the same id", async () => {
		const { runner } = makeRunner();
		const script = {
			id: "owned",
			steps: [{ id: "g", call: "svc.gate", reason: "gate" }],
		};
		await runner.start({ script, owner: "agent-1" });
		const stolen = await runner.start({ script, owner: "agent-2" });
		expect(stolen.status).toBe("failed");
		if (stolen.status === "failed") {
			expect(stolen.error.code).toBe("run_forbidden");
		}
		const clashed = await runner.start({
			script: {
				id: "owned",
				steps: [{ id: "x", call: "svc.echo", args: {}, reason: "r" }],
			},
			owner: "agent-1",
		});
		expect(clashed.status).toBe("failed");
		if (clashed.status === "failed") {
			expect(clashed.error.code).toBe("run_id_in_use");
		}
	});

	it("settled steps are not re-run on resume", async () => {
		const storage = memoryStorage();
		let echoes = 0;
		const runner = createDurableRunner({
			storage,
			tools,
			handlers: {
				call: async (request, ctx) => {
					if (request.tool === "svc.echo") {
						echoes++;
						return request.args;
					}
					const answer = ctx.resolutions.gate;
					if (answer === undefined) throw suspend({ key: "gate" });
					return { approved: answer };
				},
			},
		});
		const script = {
			id: "reuse",
			steps: [
				{ id: "a", call: "svc.echo", args: { x: 1 }, reason: "r" },
				{ id: "g", call: "svc.gate", reason: "gate" },
			],
		};
		await runner.start({ script, owner: "agent-1" });
		expect(echoes).toBe(1);
		const second = await runner.resume("reuse", {
			resolutions: { gate: true },
		});
		expect(second.status).toBe("completed");
		expect(echoes).toBe(1); // step "a" reused, never re-dispatched
	});
});
