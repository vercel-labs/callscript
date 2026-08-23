# callscript

**Code Mode, without the sandbox.**

**The model writes JavaScript - and it never runs.** Instead of calling tools one at a time, the model authors ONE small script in TypeScript and it compiles into an inert JSON plan: validated whole before anything runs (every issue reported at once), executed with bounded call counts, steps scheduled by data dependency. The only things that can execute are the tools you mounted.

## Install

```sh
npm install callscript
```

Two small runtime dependencies (`acorn`, `zod`), no sandbox, no service: the engine is a library that runs wherever your JS runs. The adapters' peers (`ai`, `eve`) are optional and only needed by their own entrypoints.

## Quick start

Mount your AI SDK tools on an engine and hand the model the ready-made tool pair - `execute` runs the script it authors, `search` finds mounted tools by keyword:

```ts
import { generateText } from "ai";
import { callscript } from "callscript";
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

const engine = callscript({
	tools: fromAISDKTools(tools, { namespace: "github" }),
});

await generateText({
	model: "anthropic/claude-sonnet-5",
	prompt: "Close every stale open issue in the 'api' repo.",
	tools: toAISDKTools(engine), // execute + search
});
```

## Why

Classic tool calling has a shape problem: one call per model round-trip. Every intermediate result travels back through the context window just so the model can look at it and decide the next call: slow, token-expensive, and the plan lives nowhere you can inspect it.

**Code Mode** fixes this by having the model write real TypeScript that calls the tools, then executing that program. The insight is right: models are better at writing programs than at emitting tool-call chains, and intermediate data should flow between calls without a detour through the context. But the price is that you are now executing arbitrary LLM-authored code, so you need a sandbox: an isolate, a container, a worker. That is infrastructure to run, and a security boundary you must get exactly right.

**callscript is Code Mode without the sandbox.** The model still authors one program - in the JavaScript it already writes, with loops, branches, and dataflow - but nothing it writes ever executes as code: the script compiles into inert JSON with a pure expression subset. The only things that can execute are the tools you mounted. That one change buys the rest:

- **No sandbox needed**: there is no arbitrary code to contain. Expressions are a side-effect-free JS subset (no I/O, no globals, no imports), so the engine runs wherever your JS runs: serverless, edge, the same process as your app.
- **Statically checkable**: because the plan is data, the whole thing validates before anything runs: unknown tools, misshaped args, unbound references, every issue reported at once. Arbitrary code can only fail at runtime, one error at a time.
- **Bounded by construction**: fan-outs declare `max` and the engine enforces call limits; a runaway loop is a validation error, not an incident.
- **Serializable and resumable**: a JSON plan plus a serializable record means runs can suspend (approval gates, external events) and resume with settled steps reused. Pausing arbitrary code mid-execution is famously hard.
- **Parallel for free**: steps are scheduled by data dependency, so independent calls run concurrently without the model having to write `Promise.all` correctly.
- **Plain-value results**: sandboxed code hands results back as logged text you parse afterwards; script steps return plain values the next step - and the host - reads directly.
- **Auditable**: what will run and what ran are the same inert artifact: reviewable before execution, replayable after.

Expressions are a small language for pure transforms between calls, not general computation. If a step genuinely needs code, then you can have a code tool exposed to the agent.

## The JS surface

The authoring format is the JavaScript the model already writes - so the entire language instruction (`jsLanguageCard`, what `engine.describe()` puts in the prompt) is **one card of ~500 tokens**, and the validator's pointed messages teach the rest on retry:

```js
// close stale issues
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
if (stale.length === 0) return { closed: 0 };
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
return { count: closed.length };
```

This is **parsed, never executed**: each statement compiles into a step of the same inert plan - `const x = await tool(...)` is a call step, `const x = expr` a pure derivation, `if (cond) return v` a guard, `Promise.all(list.map(...))` a bounded fan-out (the visible `slice` is the bound), `try/catch` the error branch (`e` compiles to `$errors.<id>`), and the trailing `return` the output projection. What is stored, hashed, validated, approved, and resumed is always the JSON plan; the JS text is a frontend, not a runtime.

Semantics match the JS reading: **awaited calls run in statement order** (the compiler inserts `after` edges where no data already orders them), and `Promise.all` - the spelling the model already knows for concurrency - runs calls in parallel. A call's second argument carries per-step options: `github.closeIssue(args, { reason: "why", suspend: true, onError: "skip" })`. An un-awaited call to a mounted tool detaches (fire-and-forget) and a later script joins it with `const r = await job`.

Everything outside the recognized grammar is rejected before anything runs, with the message that names the callscript spelling - `while` points at the bounded fan-out, reassignment at single-assignment consts, `new Set` at the dedupe idiom - so one retry converges:

```text
while (queue.length) { await github.closeIssue({ number: next }); }
  ✗ line 1: unbounded loops cannot run - fan out over a bounded list
    instead: await Promise.all(items.slice(0, N).map(item => tool.name({ ... })))

closed = await github.closeIssue({ number: 7 });
  ✗ line 4: bindings are single-assignment - declare a new const instead of reassigning

const seen = new Set(ids);
  ✗ line 7: Unsupported syntax: new. Dedupe with
    xs.filter((x, i, a) => a.indexOf(x) === i); group with Object.groupBy(xs, x => x.key).
```

Every door accepts both surfaces: a **string** is the JS surface, an **object** is the JSON plan. Engines default to teaching the JS surface (`describe`, `toolDefinition`, `agentTools`); pass `format: "json"` to teach the JSON plan instead - execution accepts both regardless.

## The plan: three verbs, four modifiers

Under the surface, a script is one inert JSON plan: a list of steps wired by dataflow. Steps reference each other by id, and those references ARE the schedule - independent steps run concurrently, dependent ones wait for their inputs. Each step is one of three verbs:

- **`call`** - `const x = await tool.name({...})` - invokes a mounted tool; its `args` validate against the tool's schema before it fires.
- **`let`** - `const x = expr` - derives a value from earlier steps with a pure expression.
- **`return`** - `if (cond) return value` - a guard clause: when it fires the run ends right there with that value; otherwise the run continues.

And a step can carry modifiers:

- **`if`** skips the step unless a condition holds.
- **`each`** fans a call out over a list, one dispatch per element, bounded by a hard `max`.
- **`after`** orders a step behind earlier ones when no data flows between them - close the issues, then post the summary.
- **`suspend`** flags a call for confirmation: the run pauses there until a human approves it.

A few more things the language gives you:

- **Globals.** Expressions read earlier steps by id, `input` (data passed to this execution), variables published by earlier runs in the session, `$errors.<stepId>` for recorded failures, and safe built-ins like `Math`, `JSON`, and `Date`.
- **Promises.** Every call is async; `await` only decides whether the run blocks on it. A call *without* `await` detaches and keeps running in the background; a later script joins it with `const r = await job`.
- **Expressions.** A side-effect-free subset of JS: arrows, template literals, ternaries, optional chaining - no I/O, no imports, no reaching outside the script's scope.
- **Output.** `output` projects the run's final result from any settled step; by default it is the last step's value.

## Limits

Every engine carries hard limits: validation enforces them before a run starts, execution enforces them while it runs, and `engine.describe()` renders the live numbers into the prompt so the model authors against the same bounds the engine enforces.

| limit | default | bounds |
| --- | --- | --- |
| `maxSteps` | 20 | steps per script |
| `maxItemsPerStep` | 100 | the `max` any single `each` fan-out may declare |
| `maxTotalCalls` | 200 | worst-case total calls per script (Σ max) |
| `maxConcurrency` | 5 | independent steps / fan-out calls in flight |
| `maxExprNodes` | 100 000 | AST nodes evaluated per expression |
| `maxCallResultBytes` | 10 MiB | serialized size of a single call's result |
| `maxSuspendAttempts` | 5 | times one suspension key may re-raise before failing |

Override any subset: `callscript({ tools, limits: { maxTotalCalls: 50 } })`.

## Adapters

The engine is **adapter-based**. It never knows where a tool came from; everything mounts through one neutral shape, `ScriptTool`:

```ts
{ name, description?, inputSchema?, outputSchema?, errors?, idempotent?, execute(args, ctx) }
```

so you can use callscript purely with the AI SDK, with plain object literals, or any mix:

- **`callscript/ai-sdk`**: hand it the same `tools` record you'd give `generateText`/`streamText`
- **`callscript/eve`**: the engine's `execute`/`search` pair as ready-made [eve](https://github.com/vercel/eve) agent tools
- **plain literals**: a `{ name, execute }` object is already a tool; the `tool()` helper pins the literals for typed authoring

## With the AI SDK

AI SDK in, AI SDK out: you never hand-write a script. Define tools with the SDK's own `tool()`, mount them through the adapter, and `toAISDKTools(engine)` hands the model the engine as a ready-made tool pair: `execute` runs the script it authors, `search` finds mounted tools by keyword.

```ts
import { generateText, tool } from "ai";
import { z } from "zod";
import { callscript } from "callscript";
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

// the same `tool()` objects you'd hand generateText directly
const listIssues = tool({
	description: "list the issues of a repo",
	inputSchema: z.object({ repo: z.string() }),
	execute: async ({ repo }) => [/* ... */],
});
const closeIssue = tool({
	description: "close an issue by number",
	inputSchema: z.object({ repo: z.string(), number: z.number() }),
	execute: async ({ number }) => ({ closed: number }),
});

const engine = callscript({
	// the whole record mounts at once, however many tools it holds;
	// `namespace` prefixes the keys: github.listIssues, github.closeIssue
	tools: fromAISDKTools({ listIssues, closeIssue }, { namespace: "github" }),
});

await generateText({
	model: "anthropic/claude-sonnet-5",
	system: "You act by writing ONE callscript.",
	prompt: "Close every stale open issue in the 'api' repo.",
	tools: toAISDKTools(engine), // `execute` runs a script, `search` finds tools
});
```

`toAISDKTools(engine)` wraps `engine.agentTools()`, the host-neutral pair. `execute` validates the script at the door (a rejected script returns `status: "invalid"` with every issue, for the model to retry), runs it against a shared session scope, and returns the outcome without the session state (that rides the scope, never the prompt). `search` matches mounted tools by keyword and returns their signature cards. With 20 or fewer tools the cards inline into `execute`'s description; past that (or with `inlineTools: false`) the model discovers tools through `search` instead, so the prompt stays small however many tools you mount. Pass `scope` to join an existing session, `names` to rename the pair. Prefer manual wiring? `engine.toolDefinition()` still returns the one-tool `description`/`inputSchema` to hand a tool interface yourself.

For the task above the model authors one script - which the engine compiles into the inert plan, no code ever running:

```js
// close stale issues
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
```

which is stored and executed as:

```json
{
	"intent": "close stale issues",
	"steps": [
		{ "id": "issues", "call": "github.listIssues", "args": { "repo": "api" } },
		{ "id": "stale", "let": "issues.filter(i => i.stale)" },
		{
			"id": "closed",
			"call": "github.closeIssue",
			"each": "(stale.slice(0, 10)).map((i) => ({ repo: \"api\", number: i.number }))",
			"max": 10
		}
	]
}
```

The record keys are the registry: a script's `call` names a tool by key, and `validate` rejects anything else before a run starts. A `namespace` prefixes the keys, so whole records mount side by side by spreading: `tools: [...fromAISDKTools(github, { namespace: "github" }), ...fromAISDKTools(slack, { namespace: "slack" })]`. Args validate against each tool's schema (zod, any standard schema, or `jsonSchema()`) **before** `execute` fires; a failure fails the step with code `invalid_tool_args`. The schemas also render the tool cards `engine.describe()` / `engine.toolDefinition()` put in the model's prompt.

## With eve

`toEveTools(engine)` returns the same `execute`/`search` pair as branded eve tool definitions. eve tools are files - one default export per `agent/tools/<name>.ts` - so re-export each from its own file:

```ts
// lib/callscript.ts
import { toEveTools } from "callscript/eve";
import { engine } from "./engine";

export const { execute, search } = toEveTools(engine);
```

```ts
// agent/tools/execute.ts
export { execute as default } from "../../lib/callscript";

// agent/tools/search.ts
export { search as default } from "../../lib/callscript";
```

The agent authors scripts through `execute` and discovers mounted tools through `search`, instead of carrying every tool card in its prompt. Options are `engine.agentTools`'s (`scope`, `inlineTools`, `names`); in eve the filename decides the model-facing name, so keep `names` in step with the files. A `defineDynamic` tools file can also serve the pair from one slot by returning the record as-is.


## With plain tools

```ts
import { callscript, tool } from "callscript";

const closeIssue = tool({
	name: "github.closeIssue",
	description: "close an issue by number",
	inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" } }, required: ["repo", "number"] },
	errors: ["not_found"],
	execute: (args: { repo: string; number: number }) => ({ closed: args.number }),
});

const engine = callscript({ tools: [closeIssue] });
```

Throw protocol from `execute`: throw to fail the step (a string `code` on the error surfaces as the step error's code), `throw earlyReturn(value)` to end the run here, `throw suspend({ key, ... })` to park it on an external event.

## Runs, suspensions, per-execute input

`engine.run` validates at the door, executes with the engine's limits, and returns the ordinary `ExecuteResult`, with early returns, suspensions, and the serializable session `state` included. Per-execute data flows through expressions:

```ts
// first run suspends; re-execute with the answer piped in as `input`
const first = await engine.run({ script }); // status: "suspended"
const second = await engine.run({ script, state: first.state, input: { code: "42" } });
```

The suspended run comes back as a serializable `state` record: store it anywhere - it survives a restart - and settled steps are reused instead of re-run on resume.

## The session is a plain scope object

`engine.scope()` mints the session as a VALUE, no hidden machinery. Runs handed the same scope share the accumulated record (settled steps are reused, published outputs become session variables) and the host-seeded `vars` expressions can read:

```ts
const scope = engine.scope({ user }); // seeds vars

await engine.run({ script: one }, scope);
await engine.run({ script: two }, scope); // `two` reads `one`'s step outputs
```

Tools see the scope too: `execute(args, ctx)` receives `ctx.scope`, so a tool can read `ctx.scope.vars`, write per-session state, or read prior step outputs via `publishedVariables(ctx.scope.state)`. Explicit `state:` still wins for hosts that manage records themselves.

`engine.session()` opens the full runner on the same registry: detached runs (`"await": false`), `await.<id>` joins, the settlement digest, and an accumulated record every new run executes against:

```ts
const sess = engine.session({}, scope); // scope optional - shares vars with it
await sess.start({ id: "bg", await: false, steps: [/* ... */] }); // may answer pending
await sess.start({ steps: [{ id: "r", call: "await.bg" }] });     // joins it
```

## The error branch of the dataflow

A step that declares `"onError": "skip"` records its failure instead of failing the run, and later expressions consume it as `$errors.<stepId>`: UCAN's `await/error`, spelled with a step id. `$errors.close` is the `{ message, code }` of step `close` when it failed (a per-element list on an `each` fan-out), `undefined` when it succeeded, and the read creates the same dependency edge a value reference would. In the JS surface it is just `try/catch`:

```js
try {
  const closed = await github.closeIssue({ number: 42 });
} catch (e) {
  await slack.post({ text: `close failed: ${e.message}` });
}
```

which compiles to:

```json
{ "id": "closed", "call": "github.closeIssue", "args": {}, "onError": "skip" },
{ "if": "$errors.closed", "call": "slack.post",
  "args": { "text": "=`close failed: ${$errors.closed.message}`" } }
```

## Idempotent tools memoize

A tool declaring `idempotent: true` promises same-args-same-result and repeat-safety. The engine then serves repeated calls by **input addressing**: same tool + same resolved args → one dispatch per scope, shared even between concurrent steps (the memo holds the in-flight promise; failures never cache). The table rides the scope, so runs sharing a scope share it, and the tool card advertises the contract to the authoring model. The AI SDK shape can't express it, so pass it as an override: `fromAISDKTools(tools, { overrides: { "svc.lookup": { idempotent: true } } })`.

## Scripts compile into tools

`engine.tool(name, script, { description? })` turns a script into a `ScriptTool`, mountable on another engine, so a script becomes a **tool of another engine**, and the signals compose: an inner approval gate ends the hosting run early, an inner suspension parks it, and the answer flows back down through args (`args: { approved: "=input.approved" }`). Free names no step produces are collected as `external`, the script's session requires, checked against the live session on every call.

```ts
const closeStale = engine.tool("github.closeStale", script);

const scope = engine.scope();
await closeStale.execute({}, { scope });                 // gate → throws EarlyReturnSignal({ confirm: [...] })
await closeStale.execute({ approved: true }, { scope }); // resumes - settled steps reused
```

## Typed authoring

`engine.script({...})` and `engine.tool(...)` take a `TypedScript` of the engine: `call` is the union of mounted tool names, `args` is that tool's argument type (the first parameter of its `execute`) with any leaf (or subtree) replaceable by an expression, so a typo'd tool name or a misshaped arg is a type error before it is a validation error. Adapter output carries the types through, so this works over `fromAISDKTools(...)` too.

Every expression position takes the string form **or a real JS arrow**, transpiled (never executed) into the string at the door:

```ts
engine.script({
	steps: [
		{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
		{ id: "stale", let: ({ issues }) => issues.filter((i) => i.stale) },
		{
			call: "github.closeIssue",
			each: ({ stale }) => stale.map((issue) => ({ repo: "api", number: issue.number })),
			max: 10,
		},
	],
});
```

The arrow's parameter is the **scope contract**: a plain destructuring naming everything the body reads (`input` and `$calls` included; aliases allowed; the key is the env name). The body must be a single expression in the same grammar as the strings, and a free name, including a captured outer variable (the thing a native closure could otherwise smuggle in), is rejected at the door. What's stored, hashed, rendered, and re-executed is always the string form, so the script stays inert data.

The language core (the pure-JS expression subset, static validation, limits, records, reconciliation, the runner) is engine-independent - `parseJsScript` and `validateScript` are usable standalone, and the engine is the door onto the rest.

## Examples

Runnable tours, no build step:

```
bun examples/t.ts       # describe/toolDefinition/context - the three prompt layers
bun test/ai-sdk.ts      # end to end with the AI SDK: model authors, engine validates + runs
```

## License

MIT
