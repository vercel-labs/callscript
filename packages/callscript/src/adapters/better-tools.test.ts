import { describe, expect, it } from "vitest";
import { earlyReturn, scriptEngine } from "../engine";
import { type BetterToolsInstance, betterTools } from "./better-tools";

/* ------------------------------- fixtures -------------------------------- */

/** A hand-rolled better-tools-shaped instance: `definitions` + `call` is
 * the whole structural contract the adapter programs against. */
const makeInstance = () => {
	const calls: Array<{ name: string; input: unknown; context?: unknown }> = [];
	const handlers: Record<string, (input: any) => unknown> = {
		"weather.get": ({ city }) => ({ city, tempC: 21 }),
		"weather.setHome": ({ city }) => {
			if (city === "") {
				// FnError-shaped: a declared refusal with a tag.
				throw Object.assign(new Error("weather.setHome: empty_city"), {
					name: "FnError",
					tag: "empty_city",
					data: {},
				});
			}
			return { home: city };
		},
		"auth.gate": () => {
			// An UnexpectedError-shaped defect wrapper hiding OUR signal.
			throw Object.assign(new Error("auth.gate: unexpected"), {
				name: "UnexpectedError",
				cause: earlyReturn({ kind: "link", url: "https://auth" }),
			});
		},
		"strict.echo": (input) => {
			if (typeof input?.text !== "string") {
				// ValidationError-shaped: a contract violation at the door.
				throw Object.assign(
					new Error("strict.echo.input.text: expected string"),
					{
						name: "ValidationError",
						path: "strict.echo.input.text",
					},
				);
			}
			return input.text;
		},
	};
	const instance: BetterToolsInstance = {
		definitions: [
			{
				name: "weather.get",
				description: "current weather for a city",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
			{
				name: "weather.setHome",
				description: "set the home city",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
			{
				name: "auth.gate",
				description: "device auth",
				input_schema: { type: "object" },
			},
			{
				name: "strict.echo",
				description: "echo text",
				input_schema: { type: "object" },
			},
		],
		call(name, input, context) {
			calls.push({ name, input, context });
			const handler = handlers[name];
			if (!handler) throw new Error(`no handler for ${name}`);
			return handler(input);
		},
	};
	return { instance, calls };
};

/* --------------------------------- tests --------------------------------- */

describe("betterTools", () => {
	it("mounts the instance's definitions and dispatches through call", async () => {
		const { instance, calls } = makeInstance();
		const engine = scriptEngine({ tools: betterTools(instance) });
		expect(engine.tools).toContain("weather.get");

		const result = await engine.run({
			script: {
				steps: [{ id: "w", call: "weather.get", args: { city: "Addis" } }],
			},
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.output).toEqual({ city: "Addis", tempC: 21 });
		}
		expect(calls[0]?.name).toBe("weather.get");
	});

	it("threads the adapter's context into every dispatch", async () => {
		const { instance, calls } = makeInstance();
		const engine = scriptEngine({
			tools: betterTools(instance, { context: { userId: "u1" } }),
		});
		await engine.run({
			script: {
				steps: [{ id: "w", call: "weather.get", args: { city: "Addis" } }],
			},
		});
		expect(calls[0]?.context).toEqual({ userId: "u1" });
	});

	it("a FnError-shaped refusal's tag becomes the step error code", async () => {
		const { instance } = makeInstance();
		const engine = scriptEngine({ tools: betterTools(instance) });
		const result = await engine.run({
			script: { steps: [{ call: "weather.setHome", args: { city: "" } }] },
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("empty_city");
		}
	});

	it("a ValidationError-shaped throw fails with invalid_tool_args", async () => {
		const { instance } = makeInstance();
		const engine = scriptEngine({ tools: betterTools(instance) });
		const result = await engine.run({
			script: { steps: [{ call: "strict.echo", args: { text: 42 } }] },
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.code).toBe("invalid_tool_args");
		}
	});

	it("unwraps a defect-wrapped engine signal - earlyReturn still returns", async () => {
		const { instance } = makeInstance();
		const engine = scriptEngine({ tools: betterTools(instance) });
		const result = await engine.run({
			script: { steps: [{ id: "gate", call: "auth.gate" }] },
		});
		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.returnedAt).toBe("gate");
			expect(result.output).toEqual({ kind: "link", url: "https://auth" });
		}
	});

	it("renders tool cards from the definitions", () => {
		const { instance } = makeInstance();
		const engine = scriptEngine({ tools: betterTools(instance) });
		const text = engine.describe();
		expect(text).toContain("weather.get({ city: string })");
		expect(text).toContain("current weather for a city");
	});
});
