"use client";

import {
	type AnyScriptTool,
	callscript,
	DEFAULT_LIMITS,
	type ExecuteResult,
	type JsonSchema,
	publishedVariables,
	renderJsonSchemaType,
	type Script,
	type ScriptLimits,
	ScriptValidationError,
	type ToolCallContext,
} from "callscript";
import { useEffect, useMemo, useRef, useState } from "react";
import { type HighlightLang, toHtml, useHighlighter } from "@/lib/highlighter";
import { CodeEditor } from "./editor";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** Minimal zod-shaped schema builder for the tools editor: enough of
 * `z` to author tool cards - each node carries the JSON Schema the
 * engine renders, nothing validates at runtime. */
interface ZNode {
	schema: JsonSchema;
	isOptional: boolean;
	optional(): ZNode;
	describe(text: string): ZNode;
}

const zNode = (schema: JsonSchema, isOptional = false): ZNode => ({
	schema,
	isOptional,
	optional() {
		return zNode(this.schema, true);
	},
	describe(text: string) {
		return zNode({ ...this.schema, description: text }, this.isOptional);
	},
});

const z = {
	string: () => zNode({ type: "string" }),
	number: () => zNode({ type: "number" }),
	boolean: () => zNode({ type: "boolean" }),
	any: () => zNode({}),
	unknown: () => zNode({}),
	literal: (value: unknown) => zNode({ const: value }),
	enum: (values: readonly unknown[]) => zNode({ enum: [...values] }),
	array: (item?: ZNode) => zNode({ type: "array", items: item?.schema ?? {} }),
	object: (shape: Record<string, ZNode> = {}) => {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (const [key, node] of Object.entries(shape)) {
			properties[key] = node.schema;
			if (!node.isOptional) required.push(key);
		}
		return zNode({ type: "object", properties, required });
	},
};

type ToolOptions = {
	description?: string;
	input?: ZNode;
	output?: ZNode;
	/** false keeps the tool OUT of the system prompt: still mounted and
	 * callable, the agent discovers it through its search tool. */
	pinned?: boolean;
	/** declared machine-readable error codes, shown on the tool card. */
	errors?: readonly string[];
};

/** A mounted playground tool: the engine spec plus the prompt flag. */
type PlaygroundTool = AnyScriptTool & { pinned: boolean };
type ToolHandler = (args: any, ctx: unknown) => unknown;

/** The demo tools, authored the way an app would: js the visitor edits,
 * evaluated in their own browser - same trust level as the devtools
 * console. `export` is stripped, `tool`/`z`/`wait` are in scope. */
const DEFAULT_TOOLS_SRC = `// plain js, executed for real in your browser:
//   tool(name, { description, input, output, pinned }, handler)
// z builds the schemas, wait(ms) simulates latency - edit anything
// and the engine remounts instantly. pinned: false keeps a tool out
// of the system prompt; the agent finds it with its search tool.

export const listIssues = tool(
  "github.listIssues",
  {
    description: "list the issues of a repo",
    input: z.object({ repo: z.string() }),
    output: z.array(z.object({
      number: z.number(), title: z.string(),
      body: z.string(), stale: z.boolean() })),
  },
  async ({ repo }) => {
    await wait(350);
    return [
      { number: 41, title: "flaky login test", body: "login e2e fails ~1 in 8 runs on CI, timing out on the redirect", stale: false },
      { number: 42, title: "dark mode flash", body: "white flash on first paint before the theme class lands", stale: true },
      { number: 44, title: "migrate to vitest", body: "jest is slow on the monorepo; vitest halves the suite time", stale: true },
      { number: 49, title: "docs typo", body: "quickstart says 'npm i callscrpt' - missing the i", stale: false },
      { number: 52, title: "ci cache misses", body: "pnpm store restore misses on every branch build since the runner update", stale: true },
      { number: 57, title: "drop node 16", body: "node 16 is EOL; drop it from the engines field and CI matrix", stale: true },
      { number: 61, title: "esm build warning", body: "tsdown warns on mixed exports in the ai-sdk entrypoint", stale: false },
      { number: 63, title: "rate limit retries", body: "429s from the search API should back off instead of failing the sync", stale: true },
      { number: 68, title: "windows path bug", body: "backslash paths break the loader on win32; needs path.posix", stale: false },
      { number: 70, title: "bump typescript", body: "TS 5.9 fixes the const-generic inference we work around in args.ts", stale: true },
      { number: 74, title: "stream backpressure", body: "large tool results overflow the response stream buffer", stale: false },
      { number: 77, title: "old rfc discussion", body: "superseded by the adapter design that shipped in 0.1", stale: true },
    ];
  },
);

export const closeIssue = tool(
  "github.closeIssue",
  {
    description: "close an issue by number",
    input: z.object({ number: z.number() }),
    output: z.object({ closed: z.number() }),
  },
  async ({ number }) => {
    await wait(250);
    return { closed: number };
  },
);

export const post = tool(
  "slack.post",
  {
    description: "post a message to a channel",
    input: z.object({ channel: z.string(), text: z.string() }),
    output: z.object({ ok: z.boolean(), text: z.string() }),
  },
  async ({ channel, text }) => {
    await wait(200);
    return { ok: true, text };
  },
);

// unpinned: not in the system prompt - the agent searches for it
export const assignIssue = tool(
  "github.assignIssue",
  {
    description: "assign an issue to a user",
    pinned: false,
    input: z.object({ number: z.number(), user: z.string() }),
    output: z.object({ number: z.number(), assignee: z.string() }),
  },
  async ({ number, user }) => {
    await wait(200);
    return { number, assignee: user };
  },
);`;

type CompiledTools =
	| { ok: true; tools: PlaygroundTool[] }
	| { ok: false; message: string };

/** Evaluate the tools source and collect every `tool(...)` call into
 * mountable specs. Browser-only, like the old per-tool expressions. */
function compileToolsSource(src: string): CompiledTools {
	const registered: PlaygroundTool[] = [];
	const toolFn = (
		name: unknown,
		options?: ToolOptions | ToolHandler,
		handler?: ToolHandler,
	): PlaygroundTool => {
		if (typeof name !== "string" || !NAME_RE.test(name)) {
			throw new Error(
				`tool(...): invalid name ${JSON.stringify(name)} - use dot-separated segments like "ns.action"`,
			);
		}
		const fn =
			typeof handler === "function"
				? handler
				: typeof options === "function"
					? options
					: undefined;
		if (typeof fn !== "function") {
			throw new Error(
				`tool(${name}): missing handler - tool(name, { input, output }, async (args) => ...)`,
			);
		}
		const opts = typeof options === "object" && options !== null ? options : {};
		const spec: PlaygroundTool = {
			name,
			description: opts.description,
			inputSchema: opts.input?.schema,
			outputSchema: opts.output?.schema,
			pinned: opts.pinned !== false,
			errors: opts.errors,
			execute: (args, ctx) => fn(args, ctx),
		};
		registered.push(spec);
		return spec;
	};
	try {
		const body = src.replace(/^\s*export\s+/gm, "");
		const evaluate = new Function(
			"tool",
			"z",
			"wait",
			`"use strict";\n${body}`,
		);
		evaluate(toolFn, z, wait);
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
	if (registered.length === 0) {
		return {
			ok: false,
			message: "no tools defined - call tool(name, { input, output }, handler)",
		};
	}
	const seen = new Set<string>();
	for (const t of registered) {
		if (seen.has(t.name)) {
			return { ok: false, message: `duplicate tool name: ${t.name}` };
		}
		seen.add(t.name);
	}
	return { ok: true, tools: registered };
}

const DEFAULT_JS = `// close stale issues
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
if (stale.length === 0) return { closed: 0 };
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ number: i.number })));
await slack.post({ channel: "#eng", text: \`closed \${closed.length} stale issues\` });
return { count: closed.length };`;

/* ------------------------------ tool packs ------------------------------- */

const PAYMENTS_TOOLS_SRC = `// error branches as dataflow: payments.refund
// declares RISK_HOLD and throws it for flagged orders - a script's
// catch step runs only if the refund actually fails.

export const listReturns = tool(
  "shop.listReturns",
  {
    description: "list recently returned orders",
    input: z.object({ days: z.number() }),
    output: z.array(z.object({
      id: z.string(), amount: z.number(), flagged: z.boolean() })),
  },
  async ({ days }) => {
    await wait(300);
    return [
      { id: "ord_318", amount: 129, flagged: true },
      { id: "ord_322", amount: 40, flagged: false },
    ];
  },
);

export const refund = tool(
  "payments.refund",
  {
    description: "refund a returned order in full",
    errors: ["RISK_HOLD"],
    input: z.object({ orderId: z.string() }),
    output: z.object({ orderId: z.string(), refunded: z.boolean() }),
  },
  async ({ orderId }) => {
    await wait(350);
    if (orderId === "ord_318")
      throw new Error("RISK_HOLD: order is flagged for manual review");
    return { orderId, refunded: true };
  },
);

export const escalate = tool(
  "support.escalate",
  {
    description: "open a support ticket for a human to review",
    input: z.object({ orderId: z.string(), reason: z.string() }),
    output: z.object({ ticket: z.string() }),
  },
  async ({ orderId }) => {
    await wait(200);
    return { ticket: "tik_" + orderId };
  },
);`;

const PAYMENTS_JS = `// refund a return - the catch branch is dataflow, it runs only on failure
const returns = await shop.listReturns({ days: 7 });
try {
  const refund = await payments.refund({ orderId: returns[0].id });
} catch (e) {
  await support.escalate({ orderId: returns[0].id, reason: e.message });
}
return { checked: returns.length };`;

const SESSION_TOOLS_SRC = `// session variables: a run PUBLISHES its step
// results into the session - the next script (or the agent's next
// prompt) reads them as plain read-only variables, no refetch. The
// expensive query below should only ever run once.

export const query = tool(
  "metrics.query",
  {
    description: "expensive warehouse scan for a daily metric series",
    input: z.object({ metric: z.string(), days: z.number() }),
    output: z.array(z.object({ day: z.string(), count: z.number() })),
  },
  async ({ metric, days }) => {
    await wait(900); // the slow part - you only want to pay this once
    return [
      { day: "mon", count: 132 },
      { day: "tue", count: 141 },
      { day: "wed", count: 155 },
      { day: "thu", count: 168 },
      { day: "fri", count: 289 },
      { day: "sat", count: 97 },
      { day: "sun", count: 84 },
    ].slice(0, days);
  },
);

export const publish = tool(
  "report.publish",
  {
    description: "publish a report page, returns its url",
    input: z.object({ title: z.string(), lines: z.array(z.string()) }),
    output: z.object({ url: z.string() }),
  },
  async ({ title }) => {
    await wait(250);
    return { url: "https://reports.acme.dev/" + title.toLowerCase().replaceAll(" ", "-") };
  },
);

export const post = tool(
  "slack.post",
  {
    description: "post a message to a channel",
    input: z.object({ channel: z.string(), text: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  async () => {
    await wait(200);
    return { ok: true };
  },
);`;

const SESSION_JS = `// pull last week's signups
const signups = await metrics.query({ metric: "signups", days: 7 });
const total = signups.reduce((n, d) => n + d.count, 0);
const peak = signups.reduce((a, b) => (b.count > a.count ? b : a));
return { total, peak };`;

/** Switchable tool catalogs: each pack pairs a tool set with a script
 * that showcases one engine feature, so a demo is one click away. */
type ToolPack = {
	key: string;
	label: string;
	/** one line on what this pack showcases, shown next to the switcher */
	blurb: string;
	tools: string;
	script: string;
	/** prefills the generate box: a task the agent could turn into
	 * (roughly) the pack's showcase script */
	prompt: string;
};

const PACKS: ToolPack[] = [
	{
		key: "issues",
		label: "issues.ts",
		blurb: "bounded fan-out, guard clauses, agent search over unpinned tools",
		tools: DEFAULT_TOOLS_SRC,
		script: DEFAULT_JS,
		prompt:
			"close every stale issue in the api repo and post a summary to #eng",
	},
	{
		key: "payments",
		label: "payments.ts",
		blurb: "declared error codes - the catch branch runs only on failure",
		tools: PAYMENTS_TOOLS_SRC,
		script: PAYMENTS_JS,
		prompt:
			"refund the newest return, and if the refund fails escalate it to support",
	},
	{
		key: "session",
		label: "session.ts",
		blurb:
			"session variables: one run's results are the next script's inputs - no refetch",
		tools: SESSION_TOOLS_SRC,
		script: SESSION_JS,
		prompt: "pull last week's signups and work out the total and the peak day",
	},
];

type InputTab = "script" | "tools" | "system";

/** The three ways to fulfil a task, side by side: callscript's one
 * validated plan, the classic one-call-per-round-trip agent loop, and
 * Code Mode's eval-the-script-for-real. */
type Approach = "callscript" | "traditional" | "codemode";

/* ---------------------- per-approach system prompts ---------------------- */

/** Code Mode's API surface, Cloudflare-style: the tool registry rendered
 * as a typed async API the model writes plain code against. */
const codeModeApi = (tools: readonly PlaygroundTool[]): string => {
	type ApiNode = {
		tool?: PlaygroundTool;
		children: Map<string, ApiNode>;
	};
	const root = new Map<string, ApiNode>();
	for (const t of tools) {
		const segs = t.name.split(".");
		let level = root;
		for (let i = 0; i < segs.length; i++) {
			let node = level.get(segs[i]);
			if (!node) {
				node = { children: new Map() };
				level.set(segs[i], node);
			}
			if (i === segs.length - 1) node.tool = t;
			level = node.children;
		}
	}
	const method = (name: string, t: PlaygroundTool, indent: string): string => {
		const doc = t.description ? `${indent}/** ${t.description} */\n` : "";
		const input = renderJsonSchemaType(t.inputSchema);
		const output = renderJsonSchemaType(t.outputSchema);
		return `${doc}${indent}${name}(input: ${input}): Promise<${output}>;`;
	};
	const renderLevel = (level: Map<string, ApiNode>, indent: string): string =>
		[...level.entries()]
			.map(([name, node]) =>
				node.tool
					? method(name, node.tool, indent)
					: `${indent}${name}: {\n${renderLevel(node.children, `${indent}  `)}\n${indent}};`,
			)
			.join("\n");
	return [...root.entries()]
		.map(([name, node]) =>
			node.tool
				? method(name, node.tool, "").replace(
						new RegExp(`^${name}\\(`, "m"),
						`declare function ${name}(`,
					)
				: `declare const ${name}: {\n${renderLevel(node.children, "  ")}\n};`,
		)
		.join("\n\n");
};

/** The Code Mode system prompt - what /api/generate sends verbatim in
 * codemode, and what the system prompt view shows. */
const codeModePrompt = (tools: readonly PlaygroundTool[]): string =>
	[
		"## code mode",
		"",
		"You complete the user's task by writing plain JavaScript. The code",
		"is executed in a sandboxed runtime with the following API in scope;",
		"each method call is marshalled to the real tool.",
		"",
		"```ts",
		codeModeApi(tools),
		"```",
		"",
		"Rules for your reply:",
		"- Reply with ONLY the JavaScript source - no markdown fences, no",
		"  prose before or after.",
		"- The code runs as the body of an async function: use `await`",
		"  freely, `Promise.all` for parallel calls, loops and conditionals",
		"  as needed, and finish with a `return` carrying the result.",
	].join("\n");

/** Mirrors the system text /api/traditional sends - keep in sync. */
const TRADITIONAL_SYSTEM = [
	"You are an agent completing the user's task with the available",
	"tools, calling them one at a time as needed. When the task is",
	"done, reply with one short sentence summarizing what happened.",
].join("\n");

/** What the model sees in traditional mode: the system text plus every
 * tool schema - re-sent on EVERY round trip. */
const traditionalPrompt = (tools: readonly PlaygroundTool[]): string =>
	[
		"## system",
		"",
		TRADITIONAL_SYSTEM,
		"",
		"## tools",
		"",
		"every mounted tool rides along on every round trip, schemas and",
		"all - the model re-reads this context each time it decides on a",
		"single call:",
		"",
		JSON.stringify(
			tools.map((t) => ({
				name: t.name.replace(/\./g, "__"),
				description: t.description,
				input_schema: t.inputSchema ?? { type: "object" },
			})),
			null,
			2,
		),
	].join("\n");

/** The input pane's views, offered by the view dropdown: the script
 * editor, the tools editor, and the read-only system prompt the agent
 * authors against. */
const VIEWS: { key: InputTab; label: string }[] = [
	{ key: "script", label: "script" },
	{ key: "tools", label: "tools" },
	{ key: "system", label: "system prompt" },
];
type OutputTab = "converted" | "run";

/** The engine-wide limits surfaced by the config footer: every edit
 * feeds `callscript({ limits })`, so the validator, the system prompt
 * and the next run all enforce it immediately. */
const LIMIT_FIELDS: { key: keyof ScriptLimits; label: string }[] = [
	{ key: "maxSteps", label: "max steps" },
	{ key: "maxItemsPerStep", label: "max items / each" },
	{ key: "maxTotalCalls", label: "max total calls" },
	{ key: "maxConcurrency", label: "max concurrency" },
	{ key: "maxSuspendAttempts", label: "max suspends" },
	{ key: "maxExprNodes", label: "max expr nodes" },
	{ key: "maxCallResultBytes", label: "max result bytes" },
];

const defaultLimitDrafts = () =>
	Object.fromEntries(
		LIMIT_FIELDS.map((f) => [f.key, String(DEFAULT_LIMITS[f.key])]),
	) as Record<keyof ScriptLimits, string>;

type Compiled = { ok: true; script: Script } | { ok: false; issues: string[] };

/** One dispatched tool call in the code-mode log or a chat round. */
type LoggedCall = {
	name: string;
	args: unknown;
	result?: unknown;
	error?: string;
	ms: number;
};

/** One model round trip in traditional mode: optional assistant text
 * plus the tool calls it requested (executed in the browser). The
 * first round of a send carries the user prompt that started it. */
type ChatRound = { user?: string; text: string | null; calls: LoggedCall[] };

/** One generation round of the agent conversation, shown under run:
 * the script the agent replied with and the validator's verdict
 * (null = accepted; code mode has no validator so always null). */
type GenRound = { script: string; issues: string[] | null };

/** The whole exchange behind a generated script - rendered above the
 * execution trace so run shows the full back-and-forth. */
type GenSession = { prompt: string; rounds: GenRound[] };

type Outcome =
	| {
			kind: "result";
			res: ExecuteResult;
			/** the id this run's published results ride under in the session */
			runId?: string;
			calls: number;
			durationMs: number;
	  }
	| { kind: "error"; message: string }
	| {
			kind: "code";
			log: LoggedCall[];
			output?: unknown;
			error?: string;
			durationMs: number;
	  }
	| {
			kind: "chat";
			rounds: ChatRound[];
			final: string | null;
			error?: string;
			durationMs: number;
			tokens: number;
	  };

const OK = "text-blue-600 dark:text-blue-400";
const BAD = "text-red-600 dark:text-red-400";

/** The model is told to reply with bare source, but strip markdown
 * fences defensively - during streaming a trailing fence may still be
 * partial, so the final pass runs once more on the full text. */
const stripFences = (text: string) =>
	text.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
const WARN = "text-amber-600 dark:text-amber-400";

const STATUS_STYLE: Record<string, { mark: string; cls: string }> = {
	done: { mark: "✓", cls: OK },
	error: { mark: "✗", cls: BAD },
	skipped: { mark: "·", cls: "text-faint" },
	suspended: { mark: "◌", cls: WARN },
};

function preview(value: unknown, max = 76): string {
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (s === undefined) return "undefined";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Full serialization for the conversation turns: the model gets the
 * real data, never a truncated preview it might silently complete.
 * (preview stays for the UI, where truncation is a display concern.) */
function serialize(value: unknown): string {
	try {
		const s = JSON.stringify(value);
		return s === undefined ? "undefined" : s;
	} catch {
		return String(value);
	}
}

/** An engine run's outcome as conversation text - what a follow-up in
 * any mode gets to read as "what happened when that script ran". */
const describeRunOutcome = (
	o: Extract<Outcome, { kind: "result" } | { kind: "error" }>,
): string =>
	o.kind === "error"
		? `error: ${o.message}`
		: o.res.status === "ok"
			? serialize(o.res.output)
			: o.res.status === "error"
				? `failed at ${o.res.at}: ${o.res.error.message}`
				: `suspended: ${o.res.suspensions.map((s) => s.key).join(", ")}`;

function pretty(value: unknown): string {
	try {
		const s = JSON.stringify(value, null, 2);
		return s === undefined ? "undefined" : s;
	} catch {
		return String(value);
	}
}

/** Client-side highlighted read-only pane; plain text until shiki loads. */
function Highlighted({ code, lang }: { code: string; lang: HighlightLang }) {
	const highlighter = useHighlighter();
	const html = useMemo(
		() => (highlighter ? toHtml(highlighter, code, lang) : null),
		[highlighter, code, lang],
	);
	if (html === null) {
		return <pre className="whitespace-pre-wrap break-words">{code}</pre>;
	}
	return (
		<div
			className="cs-hl whitespace-pre-wrap break-words"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function Segmented<T extends string>({
	value,
	options,
	onChange,
	labels,
}: {
	value: T;
	options: readonly T[];
	onChange: (next: T) => void;
	/** display overrides for option values whose label differs */
	labels?: Partial<Record<T, string>>;
}) {
	return (
		<div className="flex items-center gap-0.5 rounded-lg border border-line bg-raise p-0.5">
			{options.map((option) => (
				<button
					key={option}
					type="button"
					onClick={() => onChange(option)}
					className={`rounded-md px-3 py-1 text-[13px] transition-colors ${
						option === value
							? "bg-bg text-ink shadow-sm"
							: "text-dim hover:text-ink"
					}`}
				>
					{labels?.[option] ?? option}
				</button>
			))}
		</div>
	);
}

export function Playground() {
	const [approach] = useState<Approach>("callscript");
	const [inputTab, setInputTab] = useState<InputTab>("script");
	const [source, setSource] = useState(DEFAULT_JS);
	const [toolsSource, setToolsSource] = useState(DEFAULT_TOOLS_SRC);
	const [pack, setPack] = useState("issues");
	const [running, setRunning] = useState(false);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [outputTab, setOutputTab] = useState<OutputTab>("converted");
	const [copied, setCopied] = useState(false);
	const [agentPrompt, setAgentPrompt] = useState(PACKS[0]!.prompt);
	const [generating, setGenerating] = useState(false);
	const [fixing, setFixing] = useState(false);
	const [genError, setGenError] = useState<string | null>(null);
	// run the generated script as soon as it validates - toggleable so a
	// demo can pause on the generated source before executing it
	const [autoRun, setAutoRun] = useState(true);
	// input tokens the CURRENT script's generation burned, summed across
	// repair rounds; null when the script on screen was not generated
	const genTokensRef = useRef(0);
	const [lastGenTokens, setLastGenTokens] = useState<number | null>(null);
	const [genSession, setGenSession] = useState<GenSession | null>(null);
	const [configOpen, setConfigOpen] = useState(false);
	// drafts stay strings so a field can be cleared mid-edit; invalid or
	// empty fields fall back to the engine defaults
	const [limitDrafts, setLimitDrafts] = useState(defaultLimitDrafts);

	// the engine is rebuilt from the tools source - editing a tool
	// immediately changes what scripts can call and what a run returns.
	// while the source has an error, the last good tools stay mounted
	const compiledTools = useMemo(
		() => compileToolsSource(toolsSource),
		[toolsSource],
	);
	const goodTools = useRef<PlaygroundTool[]>([]);
	if (compiledTools.ok) goodTools.current = compiledTools.tools;
	const mounted = goodTools.current;
	// invalid or cleared config fields fall back to the engine defaults
	const limits = useMemo(() => {
		const out: Partial<ScriptLimits> = {};
		for (const { key } of LIMIT_FIELDS) {
			const n = Number(limitDrafts[key]);
			if (Number.isFinite(n) && n > 0) out[key] = Math.floor(n);
		}
		return out;
	}, [limitDrafts]);
	// real dispatches this run - the footer count shows what actually
	// hit a tool handler
	const dispatchCount = useRef(0);
	const countedTools = useMemo(
		() =>
			mounted.map((t) => ({
				...t,
				execute: (args: never, ctx: ToolCallContext) => {
					dispatchCount.current += 1;
					return t.execute(args, ctx);
				},
			})),
		[mounted],
	);
	const engine = useMemo(
		() => callscript({ tools: countedTools, limits }),
		[countedTools, limits],
	);
	// SESSION MEMORY as run-id metadata, not replay: each run gets a
	// FRESH scope (so every call dispatches against the live world) and
	// RETURNS a run id. Its published step results ride under that id as
	// one read-only variable, so a later script references old data
	// explicitly (`run1.closed`) - never silently replayed. Editing tools
	// or loading a pack starts fresh.
	const [sessionRuns, setSessionRuns] = useState<
		{ id: string; vars: Record<string, unknown> }[]
	>([]);
	// ONE CONVERSATION ACROSS ALL APPROACHES: every send - a traditional
	// task, a callscript generate, a code mode generate - appends a turn
	// (the prompt, what the agent replied, what running it produced), and
	// every mode's next request replays the whole list. Switching the
	// approach KEEPS the conversation; editing tools, changing limits,
	// loading a pack or pressing clear starts fresh.
	const [convo, setConvo] = useState<
		{
			mode: Approach;
			prompt: string;
			reply: string;
			result?: string;
			tokens?: number;
		}[]
	>([]);
	// traditional additionally keeps its rendered transcript + footer
	// totals across sends, so the run pane reads as one continuous chat
	const chatRoundsRef = useRef<ChatRound[]>([]);
	const chatTokensRef = useRef(0);
	const chatMsRef = useRef(0);
	const clearChat = () => {
		chatRoundsRef.current = [];
		chatTokensRef.current = 0;
		chatMsRef.current = 0;
		setConvo([]);
	};
	/** A manual run ▸ joins the conversation too: there was no prompt,
	 * but the script that ran and what it produced are exactly the
	 * context a follow-up question needs. */
	const recordManualRun = (mode: Approach, script: string, result: string) =>
		setConvo((prev) => [
			...prev,
			{
				mode,
				prompt: "(ran the script in the editor)",
				reply: script,
				result,
			},
		]);
	useEffect(() => {
		setSessionRuns([]);
		clearChat();
	}, [engine]);
	const sessionVars = useMemo(
		() => sessionRuns.map((r) => r.id),
		[sessionRuns],
	);
	const sessionVarValues = useMemo(
		() => Object.fromEntries(sessionRuns.map((r) => [r.id, r.vars])),
		[sessionRuns],
	);
	const sessionCardText = useMemo(() => {
		if (sessionRuns.length === 0) return null;
		const lines = [
			"## prior runs",
			"Every executed run returns a run id carrying its step results.",
			"Reference them from any expression as <runId>.<step> - the values",
			"are already computed, no tool call needed:",
		];
		for (const r of sessionRuns) {
			for (const [name, value] of Object.entries(r.vars)) {
				lines.push(`  ${r.id}.${name} = ${preview(value, 76)}`);
			}
		}
		return lines.join("\n");
	}, [sessionRuns]);
	// what the agent authors against: the language card + one tool card
	// per PINNED tool - unpinned tools stay mounted and callable but are
	// left out of the prompt; the agent reaches them through its
	// AI-SDK-level search tool (see /api/generate)
	const promptEngine = useMemo(
		() => callscript({ tools: mounted.filter((t) => t.pinned), limits }),
		[mounted, limits],
	);
	const systemPrompt = useMemo(() => promptEngine.describe(), [promptEngine]);
	// the system prompt view shows what THIS approach actually sends:
	// callscript's language+tool cards, traditional's schemas-on-every-
	// trip, or code mode's typed API surface
	const systemPromptView = useMemo(() => {
		if (approach === "traditional") return traditionalPrompt(mounted);
		if (approach === "codemode") return codeModePrompt(mounted);
		return sessionCardText === null
			? systemPrompt
			: `${systemPrompt}\n\n${sessionCardText}`;
	}, [approach, mounted, systemPrompt, sessionCardText]);
	// live compile against the REAL registry: `engine.validate` compiles
	// the js surface (never executing it), so a wrong tool name or a
	// `while` loop goes red as you type
	const compiled: Compiled = useMemo(() => {
		if (source.trim().length === 0) return { ok: false, issues: ["empty"] };
		try {
			// session variables are referable without a producing step
			return {
				ok: true,
				script: engine.validate(source, { variables: sessionVars }),
			};
		} catch (e) {
			if (e instanceof ScriptValidationError) {
				return {
					ok: false,
					issues: e.issues.map((i) => `${i.path}: ${i.message}`),
				};
			}
			return {
				ok: false,
				issues: [e instanceof Error ? e.message : String(e)],
			};
		}
	}, [source, engine, sessionVars]);

	const changedLimits = LIMIT_FIELDS.filter(
		({ key }) => (limits[key] ?? DEFAULT_LIMITS[key]) !== DEFAULT_LIMITS[key],
	).length;

	// PER-MODE EDITOR BUFFERS: each approach keeps its own script, so a
	// code mode generation never clobbers the callscript you were editing.
	// Entering a mode restores its last content - or the pack default when
	// nothing was ever changed in that mode.
	const modeSources = useRef<Partial<Record<Approach, string>>>({});

	/** Load a tool pack: its tool set AND the script that showcases the
	 * pack's feature land together, so the demo is run-ready. */
	const loadPack = (key: string) => {
		const next = PACKS.find((p) => p.key === key);
		if (!next) return;
		setPack(key);
		setToolsSource(next.tools);
		setSource(next.script);
		modeSources.current = {}; // new pack, every mode starts at its script
		setAgentPrompt(next.prompt);
		setOutcome(null);
		setGenSession(null);
		setLastGenTokens(null);
		setOutputTab("converted");
	};

	const copySource = async () => {
		try {
			await navigator.clipboard.writeText(source);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable
		}
	};

	/** One round trip to /api/generate, streaming into the editor;
	 * `previous` carries a rejected attempt plus its validator issues so
	 * the model can repair it. Returns the final streamed text. */
	const streamScript = async (
		promptText: string,
		previous: { script: string; issues: string[] } | null,
	): Promise<string> => {
		const res = await fetch("/api/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: approach === "codemode" ? "codemode" : "callscript",
				prompt: promptText,
				// codemode sends the CF-style typed-API prompt verbatim;
				// callscript sends the pinned-only describe() context
				context:
					approach === "codemode" ? codeModePrompt(mounted) : systemPrompt,
				// the FULL registry, unpinned included: the route's search
				// tool matches over these without putting them in the prompt
				tools: mounted.map(
					({ name, description, inputSchema, outputSchema }) => ({
						name,
						description,
						inputSchema,
						outputSchema,
					}),
				),
				previous,
				// the live session card: values earlier runs already
				// computed, so the model derives instead of re-calling
				session: approach === "codemode" ? null : sessionCardText,
				// the conversation so far rides along on every generation -
				// turns from ANY approach, so a follow-up prompt continues
				// where the last send (traditional included) left off
				history:
					convo.length > 0
						? convo.map((t) => ({
								prompt: t.prompt,
								script: t.reply,
								...(t.result !== undefined ? { result: t.result } : {}),
							}))
						: undefined,
			}),
		});
		if (!res.ok || res.body === null) {
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			// an HTML body is the dev server's 404/error page (e.g. a route
			// mid-recompile), useless to display - name the failure instead
			throw new Error(
				detail.trimStart().startsWith("<")
					? `generate endpoint returned ${res.status} - retry, or restart the dev server`
					: detail || `request failed (${res.status})`,
			);
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		// the stream ends with one machine line ("\n␞{...}") carrying the
		// usage - never shown, parsed off and summed into genTokensRef
		const visibleOf = (t: string) => {
			const idx = t.indexOf("\n␞");
			return idx === -1 ? t : t.slice(0, idx);
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			setSource(stripFences(visibleOf(text)));
		}
		const idx = text.indexOf("\n␞");
		if (idx !== -1) {
			try {
				const usage = JSON.parse(text.slice(idx + 2)) as {
					inputTokens?: number;
				};
				genTokensRef.current += usage.inputTokens ?? 0;
			} catch {
				// malformed usage line - the numbers just stay lower
			}
		}
		const finalText = stripFences(visibleOf(text)).trim();
		setSource(finalText);
		return finalText;
	};

	/** The validator's verdict on a script source, in the same pointed
	 * format the output pane shows - null when it compiles. */
	const validationIssues = (text: string): string[] | null => {
		try {
			engine.validate(text, { variables: sessionVars });
			return null;
		} catch (e) {
			if (e instanceof ScriptValidationError) {
				return e.issues.map((i) => `${i.path}: ${i.message}`);
			}
			return [e instanceof Error ? e.message : String(e)];
		}
	};

	/** Ask the model for a script - and if the validator rejects it, feed
	 * the issues back automatically so the model repairs its own script,
	 * up to a couple of rounds. The engine's fourth channel in action:
	 * pointed validation messages ARE the agent feedback. */
	const generate = async () => {
		const promptText = agentPrompt.trim();
		if (promptText.length === 0 || generating) return;
		setGenerating(true);
		setFixing(false);
		setGenError(null);
		setInputTab("script");
		setOutcome(null);
		// the whole exchange lands in the run tab: prompt, the agent's
		// script per round, the validator's verdicts, then the execution
		const rounds: GenRound[] = [];
		setGenSession({ prompt: promptText, rounds: [] });
		setOutputTab("run");
		genTokensRef.current = 0;
		setLastGenTokens(null);
		const pushSession = () =>
			setGenSession({ prompt: promptText, rounds: [...rounds] });
		try {
			let script = await streamScript(promptText, null);
			if (approach === "codemode") {
				// code mode has no validator - whatever came back is the code
				rounds.push({ script, issues: null });
				pushSession();
				setLastGenTokens(
					genTokensRef.current > 0 ? genTokensRef.current : null,
				);
				let result: string | undefined;
				if (autoRun) {
					const res = await runCode(script);
					if (res !== null) {
						result =
							res.error !== undefined
								? `error: ${res.error}`
								: serialize(res.output);
					}
				}
				// the turn joins the conversation the next prompt continues -
				// with the input tokens it burned, so the growth is visible
				const turnTokens = genTokensRef.current;
				setConvo((prev) => [
					...prev,
					{
						mode: "codemode",
						prompt: promptText,
						reply: script,
						...(result !== undefined ? { result } : {}),
						...(turnTokens > 0 ? { tokens: turnTokens } : {}),
					},
				]);
				setAgentPrompt("");
			} else {
				let issues = validationIssues(script);
				rounds.push({ script, issues });
				pushSession();
				for (let round = 0; round < 2 && issues !== null; round++) {
					setFixing(true);
					script = await streamScript(promptText, { script, issues });
					issues = validationIssues(script);
					rounds.push({ script, issues });
					pushSession();
				}
				setLastGenTokens(
					genTokensRef.current > 0 ? genTokensRef.current : null,
				);
				let result: string | undefined;
				if (issues !== null) {
					setGenError("still invalid after repair - see the issues");
				} else if (autoRun) {
					// generated and accepted -> run it right away (session
					// variables stay referable, same as the live validation)
					const res = await run(
						engine.validate(script, { variables: sessionVars }),
					);
					if (res !== null) result = describeRunOutcome(res);
				}
				// callscript turns join the same conversation, so a follow-up
				// in ANY mode knows what was asked and what it produced
				const turnTokens = genTokensRef.current;
				setConvo((prev) => [
					...prev,
					{
						mode: "callscript",
						prompt: promptText,
						reply: script,
						...(result !== undefined ? { result } : {}),
						...(turnTokens > 0 ? { tokens: turnTokens } : {}),
					},
				]);
				if (issues === null) setAgentPrompt("");
			}
		} catch (e) {
			setGenError(e instanceof Error ? e.message : String(e));
		} finally {
			setGenerating(false);
			setFixing(false);
		}
	};

	/** Runs a script through the engine. With an override (the auto-run
	 * after generate) the conversation stays on screen; a manual press
	 * starts a fresh view. */
	const run = async (
		scriptOverride?: Script,
	): Promise<Extract<
		Outcome,
		{ kind: "result" } | { kind: "error" }
	> | null> => {
		const script = scriptOverride ?? (compiled.ok ? compiled.script : null);
		if (script === null || running) return null;
		// a manual run ▸ has no prompt behind it - remember the editor
		// source so the run can still join the conversation
		const manualSrc = scriptOverride === undefined ? source : null;
		if (scriptOverride === undefined) {
			setGenSession(null);
			setLastGenTokens(null);
		}
		setRunning(true);
		setOutcome(null);
		setOutputTab("run");
		const started = Date.now();
		dispatchCount.current = 0;
		try {
			// a FRESH scope per run (every call dispatches) with prior
			// runs injected read-only under their run ids - old data is
			// referenced explicitly (`run1.closed`), never silently replayed
			const res = await engine.run(
				{ script, variables: sessionVarValues },
				engine.scope(),
			);
			// the run returns a run id: its published step results ride
			// under it for every later script in the session
			const published = publishedVariables(res.state);
			let runId: string | undefined;
			if (Object.keys(published).length > 0) {
				runId = `run${sessionRuns.length + 1}`;
				const id = runId;
				setSessionRuns((prev) =>
					prev.some((r) => r.id === id)
						? prev
						: [...prev, { id, vars: published }],
				);
			}
			const outcome: Extract<Outcome, { kind: "result" }> = {
				kind: "result",
				res,
				runId,
				calls: dispatchCount.current,
				durationMs: Date.now() - started,
			};
			setOutcome(outcome);
			if (manualSrc !== null)
				recordManualRun("callscript", manualSrc, describeRunOutcome(outcome));
			return outcome;
		} catch (e) {
			const outcome: Extract<Outcome, { kind: "error" }> = {
				kind: "error",
				message: e instanceof Error ? e.message : String(e),
			};
			setOutcome(outcome);
			if (manualSrc !== null)
				recordManualRun("callscript", manualSrc, describeRunOutcome(outcome));
			return outcome;
		} finally {
			setRunning(false);
		}
	};

	/** Code Mode, for real: eval the script as plain javascript against
	 * proxies over the same tool handlers, logging every dispatch. No
	 * plan, no validation, no bounds - that is the point of the demo. */
	const runCode = async (
		srcOverride?: string,
	): Promise<Extract<Outcome, { kind: "code" }> | null> => {
		const code = srcOverride ?? source;
		if (code.trim().length === 0 || running) return null;
		if (srcOverride === undefined) {
			setGenSession(null);
			setLastGenTokens(null);
		}
		setRunning(true);
		setOutcome(null);
		setOutputTab("run");
		const log: LoggedCall[] = [];
		const started = Date.now();
		try {
			const roots: Record<string, any> = {};
			for (const t of mounted) {
				const segs = t.name.split(".");
				let node = roots;
				for (let i = 0; i < segs.length - 1; i++) {
					node = node[segs[i]] ??= {};
				}
				node[segs[segs.length - 1]] = async (args: unknown) => {
					const t0 = Date.now();
					const entry: LoggedCall = { name: t.name, args, ms: 0 };
					log.push(entry);
					try {
						const value = await t.execute(args, {} as ToolCallContext);
						entry.result = value;
						return value;
					} catch (e) {
						entry.error = e instanceof Error ? e.message : String(e);
						throw e;
					} finally {
						entry.ms = Date.now() - t0;
					}
				};
			}
			const names = Object.keys(roots);
			const fn = new Function(
				...names,
				`"use strict"; return (async () => { ${code} })();`,
			);
			const output: unknown = await fn(...names.map((n) => roots[n]));
			const outcome: Extract<Outcome, { kind: "code" }> = {
				kind: "code",
				log,
				output,
				durationMs: Date.now() - started,
			};
			setOutcome(outcome);
			if (srcOverride === undefined)
				recordManualRun("codemode", code, serialize(output));
			return outcome;
		} catch (e) {
			const outcome: Extract<Outcome, { kind: "code" }> = {
				kind: "code",
				log,
				error: e instanceof Error ? e.message : String(e),
				durationMs: Date.now() - started,
			};
			setOutcome(outcome);
			if (srcOverride === undefined)
				recordManualRun("codemode", code, `error: ${outcome.error}`);
			return outcome;
		} finally {
			setRunning(false);
		}
	};

	/** Traditional tool calling, for real: a client-driven agent loop.
	 * Each round is a full model trip (/api/traditional declares the
	 * tools without execute), the browser runs the requested handlers and
	 * posts results into the next round - transcript rendered live. */
	const runTraditional = async () => {
		const promptText = agentPrompt.trim();
		if (promptText.length === 0 || generating) return;
		setGenerating(true);
		setGenError(null);
		setGenSession(null);
		setOutputTab("run");
		// CONTINUE the running conversation: prior rounds stay on screen
		// and the prior messages ride along, so the model answers the new
		// task with the whole exchange in context
		const rounds: ChatRound[] = [...chatRoundsRef.current];
		const started = Date.now();
		const meta = mounted.map(
			({ name, description, inputSchema, outputSchema }) => ({
				name,
				description,
				inputSchema,
				outputSchema,
			}),
		);
		const push = (final: string | null, error?: string) =>
			setOutcome({
				kind: "chat",
				rounds: [...rounds],
				final,
				error,
				durationMs: chatMsRef.current + (Date.now() - started),
				tokens: chatTokensRef.current,
			});
		// replay the WHOLE conversation - turns from any approach - as plain
		// text, so this send continues where the last one left off, even if
		// that was a callscript or code mode generation
		let messages: unknown[] = [
			...convo.flatMap((t) => [
				{ role: "user", content: t.prompt },
				{
					role: "assistant",
					content:
						t.result !== undefined
							? `${t.reply}\n\n[executed - result: ${t.result}]`
							: t.reply,
				},
			]),
			{ role: "user", content: promptText },
		];
		const priorRounds = rounds.length;
		const tokensBefore = chatTokensRef.current;
		push(null);
		try {
			for (let i = 0; i < 8; i++) {
				const res = await fetch("/api/traditional", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ messages, tools: meta }),
				});
				if (!res.ok) {
					const detail = (await res.text().catch(() => "")).slice(0, 200);
					throw new Error(
						detail.trimStart().startsWith("<")
							? `endpoint returned ${res.status} - retry, or restart the dev server`
							: detail || `request failed (${res.status})`,
					);
				}
				const data: {
					text: string;
					toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
					tokens?: number;
					messages: unknown[];
				} = await res.json();
				chatTokensRef.current += data.tokens ?? 0;
				messages = [...messages, ...data.messages];
				const round: ChatRound = {
					// the send's first round carries the prompt that started it,
					// so the accumulated transcript reads as a conversation
					...(i === 0 ? { user: promptText } : {}),
					text: data.text || null,
					calls: [],
				};
				rounds.push(round);
				if (data.toolCalls.length === 0) {
					push(data.text ?? "");
					setAgentPrompt("");
					return;
				}
				push(null);
				const results: unknown[] = [];
				for (const call of data.toolCalls) {
					const name = call.toolName.replaceAll("__", ".");
					const t0 = Date.now();
					const entry: LoggedCall = { name, args: call.input, ms: 0 };
					round.calls.push(entry);
					const target = mounted.find((t) => t.name === name);
					try {
						if (!target) throw new Error(`tool not mounted: ${name}`);
						const value = await target.execute(
							call.input,
							{} as ToolCallContext,
						);
						entry.result = value;
						results.push({
							type: "tool-result",
							toolCallId: call.toolCallId,
							toolName: call.toolName,
							output: { type: "json", value: value ?? null },
						});
					} catch (e) {
						entry.error = e instanceof Error ? e.message : String(e);
						results.push({
							type: "tool-result",
							toolCallId: call.toolCallId,
							toolName: call.toolName,
							output: { type: "error-text", value: entry.error },
						});
					}
					entry.ms = Date.now() - t0;
					push(null);
				}
				messages = [...messages, { role: "tool", content: results }];
			}
			push(null, "stopped after 8 round trips");
		} catch (e) {
			push(null, e instanceof Error ? e.message : String(e));
		} finally {
			// keep the conversation for the next send - success, failure or
			// round-trip cap, the exchange so far is the follow-up's context
			chatRoundsRef.current = rounds;
			chatMsRef.current += Date.now() - started;
			// flatten this send into ONE shared-conversation turn: the tool
			// activity (with results) plus the assistant's text, so every
			// mode's next request can replay it
			const lines: string[] = [];
			for (const r of rounds.slice(priorRounds)) {
				for (const c of r.calls) {
					lines.push(
						`${c.name}(${serialize(c.args)}) → ${
							c.error !== undefined ? `error: ${c.error}` : serialize(c.result)
						}`,
					);
				}
				if (r.text !== null) lines.push(r.text);
			}
			if (lines.length > 0) {
				const turnTokens = chatTokensRef.current - tokensBefore;
				setConvo((prev) => [
					...prev,
					{
						mode: "traditional",
						prompt: promptText,
						reply: lines.join("\n"),
						...(turnTokens > 0 ? { tokens: turnTokens } : {}),
					},
				]);
			}
			setGenerating(false);
		}
	};

	const issueCount = compiled.ok ? 0 : compiled.issues.length;

	return (
		<div className="@container flex h-full flex-col overflow-hidden rounded-2xl border border-line/50 bg-bg">
			{/* panes: stacked when narrow, editor | output side by side when
			 * the container is wide enough - the ts-playground layout */}
			<div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
				{/* input pane */}
				<div className="flex h-[40%] min-h-[170px] flex-col @4xl:h-auto @4xl:min-h-0 @4xl:w-1/2">
					<div className="flex items-center justify-between gap-3 border-b border-line/50 px-3 py-2">
						<Segmented
							value={inputTab}
							options={VIEWS.map((v) => v.key)}
							labels={Object.fromEntries(VIEWS.map((v) => [v.key, v.label]))}
							onChange={(key) => setInputTab(key)}
						/>
					</div>
					<div className="flex min-h-0 flex-1 flex-col">
						{inputTab === "tools" ? (
							<>
								{!compiledTools.ok ? (
									<div
										className={`border-b border-line/50 px-3 py-1.5 font-mono text-[11px] ${BAD}`}
									>
										✗ {compiledTools.message}{" "}
										<span className="text-faint">
											- the last good tools stay mounted
										</span>
									</div>
								) : null}
								<div className="min-h-0 flex-1 overflow-auto">
									<CodeEditor
										value={toolsSource}
										onChange={setToolsSource}
										lang="javascript"
										label="tool definitions (js)"
									/>
								</div>
							</>
						) : inputTab === "system" ? (
							<div className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-6 whitespace-pre-wrap break-words text-dim">
								{systemPromptView}
							</div>
						) : approach === "traditional" ? (
							<div className="flex min-h-0 flex-1 items-center justify-center p-6">
								<p className="max-w-[44ch] text-center text-[13px] leading-6 text-faint">
									traditional tool calling: there is no script. The model calls
									tools one at a time, each call a full round trip through the
									model. Give it a task below.
								</p>
							</div>
						) : (
							<div className="min-h-0 flex-1 overflow-auto">
								<CodeEditor
									value={source}
									onChange={setSource}
									onMetaEnter={() =>
										approach === "codemode" ? runCode() : run()
									}
									lang="javascript"
									label="CallScript source (javascript)"
								/>
							</div>
						)}
					</div>
					{/* pack tabs, styled like an editor's open-file strip: each
					 * catalog is a "file" pairing tools with a showcase script */}
					<div className="flex items-stretch overflow-x-auto border-t border-line/50 font-mono text-[12px]">
						{PACKS.map((p) => (
							<button
								key={p.key}
								type="button"
								onClick={() => loadPack(p.key)}
								className={`shrink-0 border-r border-line/50 px-4 py-2 transition-colors ${
									p.key === pack
										? "bg-raise text-ink"
										: "text-faint hover:bg-raise/50 hover:text-dim"
								}`}
							>
								{p.label}
							</button>
						))}
					</div>
					{/* agent prompt: describe a script, the model writes it against
					 * the mounted tools and streams into the editor */}
					<div className="flex items-center gap-2 border-t border-line/50 px-3 py-2">
						<input
							value={agentPrompt}
							onChange={(e) => setAgentPrompt(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter")
									approach === "traditional" ? runTraditional() : generate();
							}}
							placeholder={
								convo.length > 0
									? "follow up - the conversation carries across modes"
									: approach === "traditional"
										? "give the agent a task, e.g. close every stale issue and post to #eng"
										: "ask the agent for a script, e.g. close every stale issue and post to #eng"
							}
							aria-label={
								approach === "traditional"
									? "task for the agent"
									: "describe the script to generate"
							}
							className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
						/>
						{genError !== null ? (
							<span
								className={`max-w-[35%] truncate text-[12px] ${BAD}`}
								title={genError}
							>
								✗ {genError}
							</span>
						) : null}
						{convo.length > 0 ? (
							<button
								type="button"
								onClick={() => {
									clearChat();
									setOutcome(null);
									setGenSession(null);
									setLastGenTokens(null);
								}}
								disabled={generating}
								title="start a fresh conversation"
								className="shrink-0 text-[12px] text-faint transition-colors hover:text-dim disabled:pointer-events-none disabled:opacity-40"
							>
								clear
							</button>
						) : null}
						{approach !== "traditional" ? (
							<button
								type="button"
								onClick={() => setAutoRun((v) => !v)}
								aria-pressed={autoRun}
								title="run the generated script automatically"
								className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] transition-colors ${
									autoRun ? OK : "text-faint hover:text-dim"
								}`}
							>
								<span
									aria-hidden
									className="inline-block size-1.5 rounded-full bg-current"
								/>
								auto
							</button>
						) : null}
						<button
							type="button"
							onClick={approach === "traditional" ? runTraditional : generate}
							disabled={generating || agentPrompt.trim().length === 0}
							className="rounded-lg border border-line px-3 py-1 text-[13px] text-dim transition-colors hover:bg-raise hover:text-ink disabled:pointer-events-none disabled:opacity-40"
						>
							{approach === "traditional"
								? generating
									? "working…"
									: "send"
								: generating
									? fixing
										? "fixing…"
										: "generating…"
									: "generate"}
						</button>
					</div>
				</div>

				{/* output pane */}
				<div className="flex min-h-0 flex-1 flex-col border-t border-line/50 @4xl:w-1/2 @4xl:flex-none @4xl:border-t-0 @4xl:border-l">
					<div className="flex items-center justify-between border-b border-line/50 px-3 py-2">
						<Segmented
							value={outputTab}
							options={["converted", "run"] as const}
							labels={{ converted: "output" }}
							onChange={setOutputTab}
						/>
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={copySource}
								className="text-[13px] text-faint transition-colors hover:text-ink"
							>
								{copied ? "copied ✓" : "copy"}
							</button>
							{approach === "callscript" ? (
								<button
									type="button"
									onClick={() => setOutputTab("converted")}
									title={compiled.ok ? "valid script" : "see the issues"}
									className={`inline-flex items-center gap-1.5 text-[13px] ${compiled.ok ? OK : BAD}`}
								>
									<span
										aria-hidden
										className="inline-block size-1.5 rounded-full bg-current"
									/>
									{compiled.ok
										? "compiles"
										: `${issueCount} issue${issueCount === 1 ? "" : "s"}`}
								</button>
							) : approach === "codemode" ? (
								<span
									className={`inline-flex items-center gap-1.5 text-[13px] ${WARN}`}
									title="the script runs as real js - nothing is validated"
								>
									<span
										aria-hidden
										className="inline-block size-1.5 rounded-full bg-current"
									/>
									unvalidated
								</span>
							) : null}
							{approach !== "traditional" ? (
								<button
									type="button"
									onClick={() => (approach === "codemode" ? runCode() : run())}
									disabled={
										running ||
										(approach === "callscript"
											? !compiled.ok
											: source.trim().length === 0)
									}
									title="cmd/ctrl + enter"
									className="inline-flex items-center gap-2 rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:opacity-40"
								>
									{running ? "running…" : "run ▸"}
									<span className="hidden text-[11px] opacity-60 @xl:inline">
										⌘↩
									</span>
								</button>
							) : null}
						</div>
					</div>
					<div className="min-h-[140px] flex-1 overflow-auto p-4 font-mono text-[12px] leading-6 text-dim">
						{outputTab === "converted" ? (
							approach === "traditional" ? (
								<div className="flex h-full min-h-24 items-center justify-center">
									<span className="max-w-[44ch] text-center leading-6 text-faint">
										nothing is compiled in traditional mode - every tool call is
										its own model round trip. send a task and read the
										transcript under run.
									</span>
								</div>
							) : approach === "codemode" ? (
								<div className="flex h-full min-h-24 items-center justify-center">
									<span className="max-w-[44ch] text-center leading-6 text-faint">
										code mode has no plan: the script itself is what runs,
										eval'd against the tool handlers - unbounded and
										unvalidated. press run and compare.
									</span>
								</div>
							) : !compiled.ok ? (
								<div className="space-y-1">
									<div className="text-ink">rejected before execution:</div>
									{compiled.issues.map((issue) => (
										<div key={issue} className="flex gap-2">
											<span className={BAD}>✗</span>
											<span className="min-w-0 break-words">{issue}</span>
										</div>
									))}
								</div>
							) : (
								<Highlighted
									code={JSON.stringify(compiled.script, null, 2)}
									lang="json"
								/>
							)
						) : (
							<>
								{/* the exchange behind a generated script: prompt, the
								 * agent's replies, validator verdicts - the run trace
								 * follows below once it executes */}
								{genSession !== null && approach !== "traditional" ? (
									<div className="mb-3 space-y-2 border-b border-line/50 pb-3">
										<div className="flex gap-2">
											<span className="shrink-0 text-faint">you →</span>
											<span className="min-w-0 break-words text-dim">
												{genSession.prompt}
											</span>
										</div>
										{genSession.rounds.map((r, i) => (
											<div
												key={`gen-${r.script.length}-${i}`}
												className="space-y-1"
											>
												<div className="text-faint">
													agent → {i > 0 ? "repaired script" : "script"}
												</div>
												<div className="rounded-lg border border-line/50 p-2">
													<Highlighted code={r.script} lang="javascript" />
												</div>
												{r.issues === null ? (
													approach === "callscript" ? (
														<div className={OK}>
															✓ validator accepted the script
														</div>
													) : null
												) : (
													<div className={BAD}>
														✗ validator rejected it - {r.issues.length} issue
														{r.issues.length === 1 ? "" : "s"} fed back
													</div>
												)}
											</div>
										))}
										{generating ? (
											<div className="text-faint">
												{fixing
													? "agent is repairing the script…"
													: "agent is writing the script…"}
											</div>
										) : null}
									</div>
								) : null}
								{outcome === null ? (
									<div className="flex min-h-24 items-center justify-center">
										<span className="text-faint">
											{generating
												? "waiting for the agent…"
												: running
													? "running…"
													: "press run ▸ or ⌘↩ to execute"}
										</span>
									</div>
								) : outcome.kind === "error" ? (
									<div className="space-y-1">
										<div className="text-ink">rejected before execution:</div>
										<div className="flex gap-2">
											<span className={BAD}>✗</span>
											<span className="min-w-0 break-words">
												{outcome.message}
											</span>
										</div>
									</div>
								) : outcome.kind === "code" ? (
									<div className="space-y-1">
										{outcome.log.map((c, i) => (
											<div
												key={`${c.name}-${i}`}
												className="pg-step flex gap-2"
												style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}
											>
												<span className={c.error ? BAD : OK}>
													{c.error ? "✗" : "→"}
												</span>
												<div className="min-w-0 break-words">
													<span className="text-ink">{c.name}</span>{" "}
													<span className="text-faint">
														{preview(c.args, 48)} · {c.ms}ms
													</span>{" "}
													{c.error ? (
														<span className={BAD}>{c.error}</span>
													) : (
														preview(c.result)
													)}
												</div>
											</div>
										))}
										{outcome.error !== undefined ? (
											<div className="flex gap-2 pt-2">
												<span className={BAD}>✗</span>
												<span className="min-w-0 break-words">
													{outcome.error}
												</span>
											</div>
										) : (
											<div className="pt-2">
												<span className="text-ink">output</span>{" "}
												{preview(outcome.output, 200)}
											</div>
										)}
										<div className="mt-3 border-t border-line/50 pt-3 text-faint">
											{genSession !== null
												? `${genSession.rounds.length} model round trip${genSession.rounds.length === 1 ? "" : "s"} · `
												: ""}
											{outcome.log.length} tool call
											{outcome.log.length === 1 ? "" : "s"} ·{" "}
											{outcome.durationMs}ms
											{lastGenTokens !== null
												? ` · ${lastGenTokens.toLocaleString()} input tokens this turn`
												: ""}
											{convo.length > 1
												? ` · ${convo
														.reduce((n, t) => n + (t.tokens ?? 0), 0)
														.toLocaleString()} across ${convo.length} turns`
												: ""}{" "}
											· executed as real js
										</div>
									</div>
								) : outcome.kind === "chat" ? (
									<div className="space-y-2">
										{outcome.rounds.map((round, i) => (
											<div key={`round-${i}`} className="space-y-1">
												{round.user !== undefined ? (
													<div className={`flex gap-2 ${i > 0 ? "pt-2" : ""}`}>
														<span className="shrink-0 text-faint">you →</span>
														<span className="min-w-0 break-words text-dim">
															{round.user}
														</span>
													</div>
												) : null}
												<div className="text-faint">
													round trip {i + 1}
													{round.text !== null && round.calls.length === 0
														? " · final answer"
														: ""}
												</div>
												{round.text !== null ? (
													<div className="break-words text-dim">
														{round.text}
													</div>
												) : null}
												{round.calls.map((c, j) => (
													<div
														key={`${c.name}-${j}`}
														className="pg-step flex gap-2"
													>
														<span className={c.error ? BAD : OK}>
															{c.error ? "✗" : "→"}
														</span>
														<div className="min-w-0 break-words">
															<span className="text-ink">{c.name}</span>{" "}
															<span className="text-faint">
																{preview(c.args, 48)} · {c.ms}ms
															</span>{" "}
															{c.error ? (
																<span className={BAD}>{c.error}</span>
															) : (
																preview(c.result)
															)}
														</div>
													</div>
												))}
											</div>
										))}
										{generating ? (
											<div className="text-faint">thinking…</div>
										) : null}
										{outcome.error !== undefined ? (
											<div className="flex gap-2">
												<span className={BAD}>✗</span>
												<span className="min-w-0 break-words">
													{outcome.error}
												</span>
											</div>
										) : null}
										<div className="mt-3 border-t border-line/50 pt-3 text-faint">
											{outcome.rounds.length} model round trip
											{outcome.rounds.length === 1 ? "" : "s"} ·{" "}
											{outcome.rounds.reduce((n, r) => n + r.calls.length, 0)}{" "}
											tool call
											{outcome.rounds.reduce(
												(n, r) => n + r.calls.length,
												0,
											) === 1
												? ""
												: "s"}{" "}
											· {outcome.durationMs}ms ·{" "}
											{outcome.tokens.toLocaleString()} input tokens · executed
											as chat tool calling
										</div>
									</div>
								) : (
									<div className="space-y-1">
										{outcome.res.state.script.steps.map((step, i) => {
											const st = outcome.res.state.steps[step.id];
											if (!st) return null;
											const style = STATUS_STYLE[st.status] ?? {
												mark: "▸",
												cls: "text-dim",
											};
											return (
												<div
													key={step.id}
													className="pg-step flex gap-2"
													style={{
														animationDelay: `${Math.min(i, 12) * 60}ms`,
													}}
												>
													<span className={style.cls}>{style.mark}</span>
													<div className="min-w-0 break-words">
														<span className="text-ink">{step.id}</span>{" "}
														<span className="text-faint">
															{st.status}
															{typeof st.calls === "number"
																? ` · ${st.calls} call${st.calls === 1 ? "" : "s"}`
																: ""}
															{typeof st.durationMs === "number"
																? ` · ${st.durationMs}ms`
																: ""}
														</span>{" "}
														{st.status === "error" ? (
															<span className={BAD}>
																{st.error?.message ?? ""}
															</span>
														) : st.status === "skipped" ? null : (
															preview(st.output)
														)}
													</div>
												</div>
											);
										})}
										<div
											className="pg-step mt-3 border-t border-line/50 pt-3"
											style={{
												animationDelay: `${
													Math.min(outcome.res.state.script.steps.length, 13) *
													60
												}ms`,
											}}
										>
											{outcome.res.status === "ok" ? (
												<>
													<div className="mb-1.5 flex items-center gap-1.5 text-[11px] tracking-wide uppercase">
														<span className={OK}>✓</span>
														<span className="text-faint">output</span>
														{outcome.runId !== undefined ? (
															<span className="text-faint normal-case">
																· published as{" "}
																<span className="text-dim">
																	{outcome.runId}
																</span>
															</span>
														) : null}
													</div>
													<Highlighted
														code={pretty(outcome.res.output)}
														lang="json"
													/>
												</>
											) : outcome.res.status === "error" ? (
												<div className={BAD}>
													✗ failed at {outcome.res.at}:{" "}
													{outcome.res.error.message}
												</div>
											) : (
												<div className={WARN}>
													◌ suspended:{" "}
													{outcome.res.suspensions.map((s) => s.key).join(", ")}
												</div>
											)}
											<div className="mt-3 border-t border-line/50 pt-3 text-faint">
												{genSession !== null
													? `${genSession.rounds.length} model round trip${genSession.rounds.length === 1 ? "" : "s"} · `
													: ""}
												{outcome.calls} tool call
												{outcome.calls === 1 ? "" : "s"} · {outcome.durationMs}
												ms
												{lastGenTokens !== null
													? ` · ${lastGenTokens} input tokens`
													: ""}{" "}
												· executed as a validated plan
											</div>
										</div>
									</div>
								)}
							</>
						)}
					</div>
					{/* engine config: the global limits the validator, the system
					 * prompt and every run enforce - edits remount the engine */}
					<div className="border-t border-line/50">
						<button
							type="button"
							onClick={() => setConfigOpen((v) => !v)}
							aria-expanded={configOpen}
							className="flex w-full items-center justify-between px-3 py-2 text-[12.5px] text-faint transition-colors hover:text-ink"
						>
							<span>config</span>
							<span className="flex items-center gap-2">
								{changedLimits > 0 ? (
									<span className="text-dim">{changedLimits} changed</span>
								) : (
									<span>defaults</span>
								)}
								<svg
									aria-hidden
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
									className={`size-4.5 shrink-0 transition-transform ${configOpen ? "" : "rotate-180"}`}
								>
									<path d="M4 6l4 4 4-4" />
								</svg>
							</span>
						</button>
						{configOpen ? (
							<div className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-3 pb-3 @xl:grid-cols-4">
								{LIMIT_FIELDS.map((f) => (
									<label key={f.key} className="flex flex-col gap-1">
										<span className="text-[11px] text-faint">{f.label}</span>
										<input
											type="number"
											min={1}
											value={limitDrafts[f.key]}
											onChange={(e) =>
												setLimitDrafts((prev) => ({
													...prev,
													[f.key]: e.target.value,
												}))
											}
											className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12.5px] text-ink outline-none transition-colors focus:border-faint"
										/>
									</label>
								))}
								{changedLimits > 0 ? (
									<div className="col-span-full flex justify-end">
										<button
											type="button"
											onClick={() => setLimitDrafts(defaultLimitDrafts())}
											className="rounded-md border border-line px-2.5 py-1 text-[12px] text-dim transition-colors hover:bg-raise hover:text-ink"
										>
											reset defaults
										</button>
									</div>
								) : null}
							</div>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
