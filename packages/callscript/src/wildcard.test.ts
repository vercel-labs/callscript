import { describe, expect, it } from "vitest";
import {
	createWildcardMatcher,
	isInternalName,
	isWildcardName,
} from "./wildcard";

describe("isWildcardName", () => {
	it("accepts trailing '.*' patterns with non-empty dot segments", () => {
		expect(isWildcardName("github.*")).toBe(true);
		expect(isWildcardName("github.issues.*")).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isWildcardName("github")).toBe(false);
		expect(isWildcardName("github.listIssues")).toBe(false);
		expect(isWildcardName("*")).toBe(false);
		expect(isWildcardName(".*")).toBe(false);
		expect(isWildcardName("github*")).toBe(false);
		expect(isWildcardName("git*hub.*")).toBe(false);
		expect(isWildcardName("github..*")).toBe(false);
		expect(isWildcardName("github.*.issues")).toBe(false);
	});
});

describe("createWildcardMatcher", () => {
	it("matches calls under a pattern's prefix and extracts the op", () => {
		const match = createWildcardMatcher(["shout", "github.*"]);
		expect(match("github.listIssues")).toEqual({
			pattern: "github.*",
			op: "listIssues",
		});
		expect(match("github.issues.list")).toEqual({
			pattern: "github.*",
			op: "issues.list",
		});
	});

	it("ignores non-pattern names and misses outside the prefix", () => {
		const match = createWildcardMatcher(["shout", "github.*"]);
		expect(match("shout")).toBeUndefined();
		expect(match("slack.send")).toBeUndefined();
		expect(match("githubx.list")).toBeUndefined();
		expect(match("github")).toBeUndefined();
		expect(match("github.")).toBeUndefined();
	});

	it("longest prefix wins", () => {
		const match = createWildcardMatcher(["github.*", "github.issues.*"]);
		expect(match("github.issues.close")).toEqual({
			pattern: "github.issues.*",
			op: "close",
		});
		expect(match("github.repos")).toEqual({ pattern: "github.*", op: "repos" });
	});

	it("refuses calls containing '*' - patterns are not callable", () => {
		const match = createWildcardMatcher(["github.*"]);
		expect(match("github.*")).toBeUndefined();
		expect(match("github.li*t")).toBeUndefined();
	});

	it("does not exclude internal names - that's the callers' policy", () => {
		// Dispatch WANTS "$fragment" to reach the wildcard tool; validation
		// layers its own isInternalName guard on top.
		const match = createWildcardMatcher(["github.*"]);
		expect(match("github.$fragment")).toEqual({
			pattern: "github.*",
			op: "$fragment",
		});
		expect(isInternalName("github.$fragment")).toBe(true);
	});
});
