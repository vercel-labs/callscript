import { describe, expect, it } from "vitest";
import { planToJs } from "./plan-to-js";

/** Wrap planToJs output in a function so top-level `await` is legal, then
 * confirm it parses. Parsing (not running) is the contract under test:
 * planToJs renders a stored plan back to JS source for display and
 * authoring, so its output must always be syntactically valid. */
const isValidJs = (src: string): boolean => {
	try {
		new Function(`async function __probe__() {\n${src}\n}`);
		return true;
	} catch {
		return false;
	}
};

const echo = (args: unknown) => ({
	steps: [{ id: "a", call: "svc.echo", args, reason: "r" }],
});

describe("planToJs args rendering", () => {
	it("keeps identifier keys bare", () => {
		const out = planToJs(echo({ ok: 1, _x: 2, $y: 3 }) as never);
		expect(out).toContain("{ ok: 1, _x: 2, $y: 3 }");
		expect(isValidJs(out)).toBe(true);
	});

	it("keeps reserved words and unicode identifiers bare (legal property names)", () => {
		const out = planToJs(echo({ class: 1, ünï: 2 }) as never);
		expect(out).toContain("class: 1");
		expect(out).toContain("ünï: 2");
		expect(isValidJs(out)).toBe(true);
	});

	it("quotes non-identifier keys so the output stays valid JS", () => {
		// Regression: args are z.record(z.string(), ...), so keys with spaces,
		// dots, or hyphens are legal in a validated script. They previously
		// rendered raw (`{ foo bar: 1 }`), which is a SyntaxError.
		const out = planToJs(
			echo({ "foo bar": 1, "a.b": 2, "a-b": 3, "123": 4 }) as never,
		);
		expect(out).toContain('"foo bar": 1');
		expect(out).toContain('"a.b": 2');
		expect(out).toContain('"a-b": 3');
		expect(isValidJs(out)).toBe(true);
	});

	it("handles non-identifier keys nested inside objects and arrays", () => {
		const out = planToJs(
			echo({ outer: { "inner key": 1 }, list: [{ "k y": 2 }] }) as never,
		);
		expect(isValidJs(out)).toBe(true);
		expect(out).toContain('"inner key": 1');
		expect(out).toContain('"k y": 2');
	});

	it("round-trips the rendered args through eval to the original value", () => {
		const out = planToJs(
			echo({ ok: 1, "foo bar": 2, nested: { "a.b": 3 } }) as never,
		);
		// Pull the object literal back out and compare it to the input.
		const match = /svc\.echo\(\{(.*)\}, \{ reason/.exec(out);
		expect(match).not.toBeNull();
		const evaled = new Function(`return ({ ${match![1]} });`)();
		expect(evaled).toEqual({ ok: 1, "foo bar": 2, nested: { "a.b": 3 } });
	});
});
