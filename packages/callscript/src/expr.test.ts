import { describe, expect, it } from "vitest";
import { evalExpr } from "./expr/eval";
import { collectRefs, ExprError, parseExpr } from "./expr/parse";

const env = {
	issues: [
		{
			number: 1,
			title: "bug: crash",
			updated_at: "2020-01-01T00:00:00Z",
			labels: ["bug"],
		},
		{
			number: 2,
			title: "feat: dark mode",
			updated_at: "2026-07-01T00:00:00Z",
			labels: [],
		},
		{
			number: 3,
			title: "bug: leak",
			updated_at: "2019-06-01T00:00:00Z",
			labels: ["bug", "p1"],
		},
	],
	user: { name: "beka", tier: "premium" },
};

describe("evalExpr", () => {
	it("evaluates arithmetic and comparison", () => {
		expect(evalExpr("1 + 2 * 3", {})).toBe(7);
		expect(evalExpr("2 ** 10", {})).toBe(1024);
		expect(evalExpr("5 > 3 && 2 <= 2", {})).toBe(true);
	});

	it("supports filter/map/slice chains", () => {
		const result = evalExpr(
			'issues.filter(i => i.labels.includes("bug")).map(i => i.number)',
			env,
		);
		expect(result).toEqual([1, 3]);
	});

	it("supports reduce, sort (non-mutating), template literals", () => {
		expect(evalExpr("issues.reduce((acc, i) => acc + i.number, 0)", env)).toBe(
			6,
		);
		const sorted = evalExpr(
			"issues.sort((a, b) => b.number - a.number).map(i => i.number)",
			env,
		);
		expect(sorted).toEqual([3, 2, 1]);
		expect((env.issues[0] as { number: number }).number).toBe(1); // original untouched
		expect(evalExpr("`hi ${user.name}, ${1 + 1}`", env)).toBe("hi beka, 2");
	});

	it("supports optional chaining and nullish coalescing", () => {
		expect(evalExpr("user.missing?.deep ?? 'fallback'", env)).toBe("fallback");
		expect(evalExpr("user?.name", env)).toBe("beka");
	});

	it("supports object/array literals with spread", () => {
		expect(evalExpr("{ a: 1, ...user }", env)).toEqual({
			a: 1,
			name: "beka",
			tier: "premium",
		});
		expect(evalExpr("[0, ...issues.map(i => i.number)]", env)).toEqual([
			0, 1, 2, 3,
		]);
	});

	it("supports destructured arrow params", () => {
		expect(
			evalExpr("Object.entries(user).map(([k, v]) => `${k}=${v}`)", env),
		).toEqual(["name=beka", "tier=premium"]);
	});

	it("exposes only safe globals", () => {
		expect(evalExpr("Math.max(1, 5, 3)", {})).toBe(5);
		expect(evalExpr('JSON.parse("[1,2]")', {})).toEqual([1, 2]);
		expect(evalExpr('Date.parse("2020-01-01") > 0', {})).toBe(true);
		expect(evalExpr('Number("42") + 1', {})).toBe(43);
		expect(() => evalExpr("fetch('https://x.com')", {})).toThrow(ExprError);
		expect(() => evalExpr("globalThis", {})).toThrow(ExprError);
		expect(() => evalExpr("process.env", {})).toThrow(ExprError);
	});

	it("blocks prototype escape hatches", () => {
		expect(() => parseExpr("user.constructor")).toThrow(ExprError);
		expect(() => parseExpr("user.__proto__")).toThrow(ExprError);
		expect(() => evalExpr('user["cons" + "tructor"]', env)).toThrow(ExprError);
		expect(() => evalExpr('issues["constructor"]', env)).toThrow(ExprError);
	});

	it("rejects statements, assignment, new, regex, await", () => {
		expect(() => parseExpr("a = 1")).toThrow(ExprError);
		expect(() => parseExpr("new Date()")).toThrow(ExprError);
		expect(() => parseExpr("/abc/.test(s)")).toThrow(ExprError);
		expect(() => parseExpr("(async () => 1)()")).toThrow(ExprError);
		expect(() => parseExpr("x => { return x }")).toThrow(ExprError);
		expect(() => parseExpr("1; 2")).toThrow(ExprError);
	});

	it("enforces the evaluation budget", () => {
		const big = Array.from({ length: 1000 }, (_, i) => i);
		expect(() =>
			evalExpr(
				"xs.map(a => xs.map(b => a + b))",
				{ xs: big },
				{ maxNodes: 10_000 },
			),
		).toThrow(/budget/);
	});

	it("does not allow calling functions read from data", () => {
		const evil = { fn: () => "boom" };
		expect(() => evalExpr("evil.fn()", { evil })).toThrow(ExprError);
	});

	it("passes (element, index, array) to callbacks - standard dedupe works", () => {
		expect(
			evalExpr("xs.filter((x, i, a) => a.indexOf(x) === i)", {
				xs: [1, 2, 1, 3, 2],
			}),
		).toEqual([1, 2, 3]);
	});

	it("supports Object.groupBy", () => {
		const orders = [
			{ c: "a", total: 10 },
			{ c: "b", total: 5 },
			{ c: "a", total: 7 },
		];
		expect(
			evalExpr(
				"Object.entries(Object.groupBy(orders, o => o.c)).map(([c, os]) => ({ c, sum: os.reduce((n, o) => n + o.total, 0) }))",
				{ orders },
			),
		).toEqual([
			{ c: "a", sum: 17 },
			{ c: "b", sum: 5 },
		]);
	});

	it("supports `in` over own keys of data", () => {
		expect(evalExpr('"tier" in user', env)).toBe(true);
		expect(evalExpr('"email" in user', env)).toBe(false);
		expect(evalExpr("0 in issues && 3 in issues === false", env)).toBe(true);
		// data only - no prototype chain leaks through
		expect(evalExpr('"map" in issues', env)).toBe(false);
		expect(evalExpr('"toString" in user', env)).toBe(false);
		// the check stays inside the guard
		expect(
			evalExpr('issues.filter(i => "labels" in i && i.labels.length > 1)', env),
		).toHaveLength(1);
	});

	it("`in` rejects non-objects and forbidden names", () => {
		expect(() => evalExpr('"a" in 42', {})).toThrow(/non-object/);
		expect(() => evalExpr('"a" in null', {})).toThrow(/non-object/);
		expect(() => evalExpr('"constructor" in user', env)).toThrow(/not allowed/);
		expect(() => evalExpr('"__proto__" in user', env)).toThrow(/not allowed/);
	});

	it("bans `new` with a hint at the alternatives", () => {
		expect(() => evalExpr("[...new Set(xs)]", { xs: [1] })).toThrow(
			/Object\.groupBy|indexOf/,
		);
	});

	it("encodes and decodes base64 (incl. url-safe)", () => {
		expect(evalExpr('Base64.encode("hi")', {})).toBe("aGk=");
		expect(evalExpr('Base64.decode("aGk=")', {})).toBe("hi");
		expect(evalExpr('Base64.encodeUrl("hi?>")', {})).toBe("aGk_Pg");
		expect(evalExpr('Base64.decodeUrl("aGk_Pg")', {})).toBe("hi?>");
	});

	it("stringifies objects as JSON in template literals", () => {
		expect(evalExpr("`u: ${user}`", env)).toBe(
			'u: {"name":"beka","tier":"premium"}',
		);
	});
});

describe("collectRefs", () => {
	it("finds free identifiers, ignoring bound params and globals", () => {
		const refs = collectRefs(
			parseExpr("issues.filter(i => i.number > threshold && Math.abs(x) > 0)"),
		);
		expect(refs).toEqual(new Set(["issues", "threshold", "x"]));
	});
});
