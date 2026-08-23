/**
 * The error branch of the dataflow (`$errors.<id>`): an `onError: "skip"`
 * step records its failure instead of failing the run, and later
 * expressions consume it - UCAN's `await/error`, spelled with a step id.
 */
import { describe, expect, it } from "vitest";
import {
	type CallRequest,
	ScriptValidationError,
	validateScript,
} from "./index";
import { executeScript } from "./execute";

const issuesOf = (fn: () => unknown): string => {
	try {
		fn();
		return "";
	} catch (err) {
		if (err instanceof ScriptValidationError) {
			return err.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
		}
		throw err;
	}
};

describe("$errors execution", () => {
	const recoveryScript = () =>
		validateScript({
			intent: "close, and report a failure",
			steps: [
				{ id: "close", call: "svc.close", reason: "r", onError: "skip" },
				{
					id: "report",
					if: "$errors.close",
					call: "svc.alert",
					args: { msg: "=`close failed: ${$errors.close.message}`" },
					reason: "tell someone",
				},
				{ id: "out", let: "$errors.close ? 'reported' : close" },
			],
		});

	it("a skipped failure is readable; the recovery step consumes it", async () => {
		const seen: CallRequest[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				seen.push(req);
				if (req.tool === "svc.close") {
					throw Object.assign(new Error("locked"), { code: "locked" });
				}
				return "sent";
			},
		};
		const result = await executeScript(recoveryScript(), { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe("reported");
		expect(seen.map((r) => r.tool)).toEqual(["svc.close", "svc.alert"]);
		expect((seen[1]!.args as { msg: string }).msg).toBe("close failed: locked");
	});

	it("on success $errors is undefined and the recovery step skips", async () => {
		const seen: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				seen.push(req.tool);
				return "closed";
			},
		};
		const result = await executeScript(recoveryScript(), { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toBe("closed");
		expect(seen).toEqual(["svc.close"]);
		expect(result.record.steps.report?.status).toBe("skipped");
	});

	it("an each step exposes the per-element error list", async () => {
		const script = validateScript({
			intent: "partial fan-out",
			steps: [
				{ id: "xs", let: "[1, 2, 3]" },
				{
					id: "batch",
					call: "svc.op",
					each: "xs.map(x => ({ v: x }))",
					reason: "r",
					onError: "skip",
				},
				{
					id: "failed",
					let: "$errors.batch ? $errors.batch.map((e, i) => e ? xs[i] : null).filter(x => x !== null) : []",
				},
			],
		});
		const handlers = {
			call: async (req: CallRequest) => {
				const v = (req.args as { v: number }).v;
				if (v === 2) throw new Error("boom");
				return v;
			},
		};
		const result = await executeScript(script, { handlers });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.output).toEqual([2]);
	});

	it("a reused skip-failed step still exposes its error on re-execute", async () => {
		const script = validateScript({
			intent: "resume past a suspension",
			steps: [
				{ id: "close", call: "svc.close", reason: "r", onError: "skip" },
				{
					id: "confirm",
					call: "svc.ask",
					reason: "r",
					suspend: true,
				},
				{
					id: "report",
					let: "$errors.close ? $errors.close.message : 'fine'",
					after: ["confirm"],
				},
			],
		});
		const calls: string[] = [];
		const handlers = {
			call: async (req: CallRequest) => {
				calls.push(req.tool);
				if (req.tool === "svc.close") throw new Error("locked");
				return "ok";
			},
		};
		const first = await executeScript(script, { handlers });
		expect(first.status).toBe("suspended");
		if (first.status !== "suspended") return;

		const second = await executeScript(script, {
			handlers,
			state: first.record,
			resolutions: { confirm: true },
		});
		expect(second.status).toBe("ok");
		if (second.status !== "ok") return;
		// "close" was reused (one dispatch), and its error still resolved.
		expect(second.output).toBe("locked");
		expect(calls.filter((t) => t === "svc.close")).toHaveLength(1);
	});

	it("$errors works in the output projection", async () => {
		const script = validateScript({
			intent: "summarize",
			steps: [{ id: "a", call: "svc.op", reason: "r", onError: "skip" }],
			output: "$errors.a ? 'failed' : 'succeeded'",
		});
		const failing = await executeScript(script, {
			handlers: {
				call: async () => {
					throw new Error("no");
				},
			},
		});
		expect(failing.status).toBe("ok");
		if (failing.status !== "ok") return;
		expect(failing.output).toBe("failed");
	});
});

describe("$errors validation", () => {
	it("requires the named step to declare onError: skip", () => {
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{ id: "a", call: "svc", reason: "r" },
						{ id: "b", let: "$errors.a" },
					],
				}),
			),
		).toMatch(/only set when step "a" declares "onError": "skip"/);
	});

	it("rejects unknown, later, and unawaited targets", () => {
		expect(
			issuesOf(() =>
				validateScript({ steps: [{ id: "a", let: "$errors.ghost" }] }),
			),
		).toMatch(/"\$errors\.ghost" names an unknown step/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{ id: "a", let: "$errors.b" },
						{ id: "b", call: "svc", reason: "r", onError: "skip" },
					],
				}),
			),
		).toMatch(/"b" comes later/);
		expect(
			issuesOf(() =>
				validateScript({
					steps: [
						{
							id: "bg",
							call: "svc",
							reason: "r",
							onError: "skip",
							await: false,
						},
						{ id: "b", let: "$errors.bg ? 1 : 2" },
					],
				}),
			),
		).toMatch(/not awaited/);
	});

	it("rejects dynamic reads - the dependency must be static", () => {
		for (const expr of ["Object.keys($errors)", "$errors[input.name]"]) {
			expect(
				issuesOf(() =>
					validateScript({
						steps: [
							{ id: "a", call: "svc", reason: "r", onError: "skip" },
							{ id: "b", let: expr },
						],
					}),
				),
			).toMatch(/literal id/);
		}
	});

	it("accepts computed access with a literal string id", () => {
		expect(() =>
			validateScript({
				steps: [
					{ id: "a", call: "svc", reason: "r", onError: "skip" },
					{ id: "b", let: "$errors['a']" },
				],
			}),
		).not.toThrow();
	});
});
