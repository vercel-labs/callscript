# Mastra Tool Adapters Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Add a first-class optional Mastra adapter so native Mastra tools can be mounted on callscript and callscript engine tools can be handed directly to a Mastra Agent.

Architecture: Add a Mastra-only adapter entry point that uses Mastra's public schema normalization, JSON Schema conversion, native Tool constructor, and ValidationError guard. Keep the core engine and existing adapters unchanged; package Mastra as an optional peer and expose the adapter through a separate build entry.

Tech Stack: TypeScript, tsdown, pnpm workspaces, Vitest, @mastra/core 1.x, Mastra Standard Schema, callscript ScriptTool and ToolsHost contracts.

## Global Constraints

- @mastra/core is an optional peer dependency; base, AI SDK, and MCP entry points must remain usable without it.
- Use @mastra/core/tools for createTool, Tool, and isValidationError.
- Use @mastra/core/schema for toStandardSchema and standardSchemaToJSONSchema; do not hand-convert schema dialects.
- Record keys are callscript registry names on import and Mastra model-facing names on export; Mastra id is not used to rename an imported record key.
- Namespaces and overrides are keyed by the original input record keys.
- Missing execute functions fail during import; invalid inputs fail before the underlying Mastra execute callback with invalid_tool_args.
- Mastra validation results returned from execution become thrown errors with mastra_validation_error; unrelated underlying errors propagate.
- The adapter does not synthesize Mastra agent/workflow context, approval prompts, background orchestration, or streaming hooks for direct calls.
- Use test-first red/green cycles and inspect each failure before writing the implementation that fixes it.
- Before completion, run focused tests, full package tests, typecheck, build, lint, formatting/diff checks, and import/bundle smoke checks.

---

## File map

- Create: packages/callscript/src/adapters/mastra.ts — public Mastra import/export adapter and structural host/type helpers.
- Create: packages/callscript/src/adapters/mastra.test.ts — deterministic native-Mastra integration tests.
- Create: packages/callscript/examples/mastra.ts — provider-free usage example covering both directions.
- Modify: packages/callscript/package.json — optional peer/dev dependency and package export metadata.
- Modify: packages/callscript/tsdown.config.ts — build the Mastra entry and keep Mastra external.
- Modify: pnpm-lock.yaml — lock the published Mastra package and development dependencies.
- Modify: README.md — root installation, adapter list, Mastra section, limitations, and example link.
- Modify: packages/callscript/README.md — package installation, adapter list, Mastra section, limitations, and example link.

## Task 1: Wire the optional package entry

Files:

- Modify: packages/callscript/package.json
- Modify: packages/callscript/tsdown.config.ts
- Modify: pnpm-lock.yaml

Interfaces:

- Produces a resolvable callscript/mastra package entry for the adapter created in Task 3.
- Keeps ai and @mastra/core external and optional; neither is bundled into unrelated entries.

- [ ] Step 1: Add package metadata and the build entry

Apply these additions while preserving the existing package formatting and fields:

~~~json
{
  "exports": {
    "./mastra": {
      "types": "./dist/mastra.d.ts",
      "default": "./dist/mastra.js"
    }
  },
  "peerDependencies": {
    "@mastra/core": ">=1",
    "ai": ">=5"
  },
  "peerDependenciesMeta": {
    "@mastra/core": {
      "optional": true
    }
  },
  "devDependencies": {
    "@mastra/core": "^1.63.2"
  }
}
~~~

Add the Mastra entry and external dependency to tsdown:

~~~ts
entry: {
  index: "./src/index.ts",
  "ai-sdk": "./src/adapters/ai-sdk.ts",
  mastra: "./src/adapters/mastra.ts",
  mcp: "./src/adapters/mcp.ts",
},
deps: { neverBundle: ["ai", "@mastra/core"] },
~~~

- [ ] Step 2: Resolve the development dependency and lockfile

Run:

~~~sh
pnpm install --lockfile-only
~~~

Expected: pnpm-lock.yaml records @mastra/core 1.x and its resolved transitive dependencies, and the command exits successfully without changing source files.

- [ ] Step 3: Verify the configuration

Run:

~~~sh
pnpm --filter callscript typecheck
git diff --check
~~~

Expected: the existing source typechecks and diff check reports no whitespace errors. The build does not need to emit the Mastra entry until its source exists.

- [ ] Step 4: Commit the package wiring

~~~sh
git add packages/callscript/package.json packages/callscript/tsdown.config.ts pnpm-lock.yaml
git commit -m "build: wire optional Mastra adapter entry"
~~~

## Task 2: Create the first failing native-Mastra test

Files:

- Create: packages/callscript/src/adapters/mastra.test.ts

Interfaces:

- Consumes the existing callscript engine and ScriptTool runtime.
- Produces the first executable contract for fromMastraTools, which Task 3 will satisfy.

- [ ] Step 1: Write one focused failing test

Create this test with a native Mastra tool and no adapter implementation file:

~~~ts
import { createTool } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callscript } from "../engine";
import { fromMastraTools } from "./mastra";

describe("fromMastraTools", () => {
  it("mounts a native createTool under its record key and executes it", async () => {
    const weather = createTool({
      id: "weather-source",
      description: "look up a city's weather",
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ temperature: z.number() }),
      execute: async ({ city }) => ({ temperature: city.length }),
    });

    const mounted = fromMastraTools({ weather });
    const engine = callscript({ tools: mounted });
    const result = await engine.run({
      script: {
        steps: [{ id: "forecast", call: "weather", args: { city: "Brisbane" } }],
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toEqual({ temperature: 8 });
    }
  });
});
~~~

- [ ] Step 2: Run the test and confirm the correct red state

Run:

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
~~~

Expected: FAIL because ./mastra does not exist. If it fails due to a fixture typo or missing dependency resolution, correct setup and rerun until the failure is specifically the missing adapter.

- [ ] Step 3: Commit the red test

~~~sh
git add packages/callscript/src/adapters/mastra.test.ts
git commit -m "test: specify native Mastra import behavior"
~~~

## Task 3: Implement Mastra-to-callscript mounting

Files:

- Create: packages/callscript/src/adapters/mastra.ts
- Modify: packages/callscript/src/adapters/mastra.test.ts

Interfaces:

- Consumes Mastra Tool/ToolAction-shaped records, Mastra Standard Schema helpers, and ToolCallContext.
- Produces typed fromMastraTools output as callscript ScriptTool values with names, cards, validation, and mapped Mastra validation errors.

- [ ] Step 1: Add public structural types and schema helpers

Implement the adapter around these types and imports:

~~~ts
import {
  standardSchemaToJSONSchema,
  toStandardSchema,
} from "@mastra/core/schema";
import { isValidationError } from "@mastra/core/tools";
import type { AgentTool, ToolsOptions } from "../engine";
import type { JsonSchema, ScriptTool, ToolCallContext } from "../tool";

export type MastraToolLike = {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute?: (...args: any[]) => unknown | Promise<unknown>;
};

export type MastraToolOverrides<T> = {
  [K in keyof T]?: {
    errors?: readonly string[];
    description?: string;
  };
};

export type FromMastraToolsOptions<T, NS extends string | undefined> = {
  namespace?: NS;
  overrides?: MastraToolOverrides<T>;
};

type InputOf<T> = T extends {
  execute: (input: infer I, ...args: any[]) => any;
}
  ? I
  : unknown;

type OutputOf<T> = T extends {
  execute: (...args: any[]) => infer R;
}
  ? Awaited<R>
  : unknown;
~~~

Reuse the AI SDK adapter's conditional namespaced-key and mapped-array pattern so literal record keys and namespace strings remain inferred in the return type. Normalize only present schemas:

~~~ts
const mastraSchema = (
  schema: unknown,
  io: "input" | "output",
): { standard: ReturnType<typeof toStandardSchema>; json: JsonSchema } => {
  const standard = toStandardSchema(schema as any);
  return {
    standard,
    json: standardSchemaToJSONSchema(standard, { io }) as JsonSchema,
  };
};
~~~

- [ ] Step 2: Implement validation and Mastra result mapping

Add helpers with these observable error contracts:

~~~ts
const invalidArgs = (name: string, detail: string): Error =>
  Object.assign(new Error(name + ": invalid args - " + detail), {
    code: "invalid_tool_args",
  });

const mastraValidation = (name: string, detail: string): Error =>
  Object.assign(new Error(name + ": Mastra validation failed - " + detail), {
    code: "mastra_validation_error",
  });
~~~

For an input schema, call its Standard Schema validate function before the Mastra execute function. Await an asynchronous result, use the returned value as the execute input on success, and use its error message on failure. Invoke the supplied Mastra execute function with the validated input and no fabricated second context argument. If the result satisfies isValidationError, derive useful detail from its message and validationErrors, then throw mastraValidation; otherwise return the result.

- [ ] Step 3: Implement fromMastraTools with namespace and override semantics

The function must iterate Object.entries(tools), derive the mounted name from the namespace and original key, reject a non-function execute with an actionable mount-time error, use overrides[key] rather than overrides[name], and attach description/errors/schema cards plus an async ScriptTool.execute. Use tool.execute as the captured callback so native Mastra Tool instances retain their own wrapper behavior. Add JSDoc for the two-way adapter, optional dependency, schema normalization, and direct-call context boundary.

The public function has this shape:

~~~ts
export const fromMastraTools = <
  T extends Record<string, MastraToolLike>,
  const NS extends string | undefined = undefined,
>(
  tools: T,
  options: FromMastraToolsOptions<T, NS> = {},
): MastraScriptTools<T, NS> => {
  // Map each record entry to one ScriptTool.
  // Validate with the normalized input schema before execute.
  // Map a returned Mastra ValidationError to mastra_validation_error.
};
~~~

- [ ] Step 4: Run the first test and confirm green

Run:

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
~~~

Expected: the native createTool test passes. If TypeScript rejects a Mastra generic because its execute context is required, keep the public input structural and invoke the captured callback through the intentionally context-free adapter boundary; do not weaken the runtime assertion.

- [ ] Step 5: Add and run inbound edge-case tests

Add separate tests for schema cards and id/key distinction, namespace and original-key overrides, pre-execution invalid input, output validation mapping, and execute-less mount rejection. Use these assertions:

~~~ts
expect(mounted?.name).toBe("weather");
expect(mounted?.inputSchema).toMatchObject({ type: "object" });
expect(mounted?.outputSchema).toMatchObject({ type: "object" });
expect(source.id).toBe("source-weather");
expect(namespaced).toMatchObject({
  name: "net.ping",
  description: "override",
  errors: ["offline"],
});
expect(result.error.code).toBe("invalid_tool_args");
expect(calls).toBe(0);
expect(result.output).toMatchObject({ code: "mastra_validation_error" });
expect(() => fromMastraTools({ clientOnly: { id: "client-only" } }))
  .toThrow(/has no execute/);
~~~

Run:

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
~~~

Expected: all inbound tests pass. If the exact Mastra validation message is version-dependent, assert its stable machine code and a broad message fragment rather than a private error shape.

- [ ] Step 6: Commit the inbound adapter

~~~sh
git add packages/callscript/src/adapters/mastra.ts packages/callscript/src/adapters/mastra.test.ts
git commit -m "feat: add Mastra tools to callscript adapter"
~~~

## Task 4: Implement callscript-to-Mastra wrapping

Files:

- Modify: packages/callscript/src/adapters/mastra.ts
- Modify: packages/callscript/src/adapters/mastra.test.ts

Interfaces:

- Consumes the structural ToolsHost shape used by toAISDKTools and ToolsOptions.
- Produces toMastraTools(engine, options?) returning Record<string, Tool>, with every value constructed by Mastra createTool.

- [ ] Step 1: Add failing outbound tests

Add tests that assert native Tool instances, the three exposed names, schema preservation, direct execution, and custom names:

~~~ts
import { Tool } from "@mastra/core/tools";
import { tool } from "../tool";
import { toMastraTools } from "./mastra";

it("returns native Mastra execute, search, and describe tools", async () => {
  const ping = tool({
    name: "ping",
    description: "return pong",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => "pong",
  });
  const engine = callscript({ tools: [ping] });
  const mounted = toMastraTools(engine);

  expect(Object.keys(mounted).sort()).toEqual(["describe", "execute", "search"]);
  expect(mounted.execute).toBeInstanceOf(Tool);
  expect(mounted.execute.id).toBe("execute");
  expect(mounted.execute.description).toContain("callscript");
  expect(mounted.execute.inputSchema).toMatchObject({
    "~standard": expect.anything(),
  });

  const result = await mounted.execute.execute?.({
    script: { steps: [{ call: "ping", args: {} }] },
  });
  expect(result).toMatchObject({ status: "ok", output: "pong" });
});

it("preserves custom engine tool names in the Mastra record", () => {
  const engine = callscript({
    tools: [
      tool({
        name: "ping",
        description: "return pong",
        inputSchema: { type: "object" },
        execute: async () => "pong",
      }),
    ],
  });
  const mounted = toMastraTools(engine, {
    names: { execute: "run", search: "find", describe: "inspect" },
  });
  expect(Object.keys(mounted).sort()).toEqual(["find", "inspect", "run"]);
  expect(mounted.run?.id).toBe("run");
});
~~~

- [ ] Step 2: Run outbound tests and confirm the correct red state

Run:

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
~~~

Expected: the new tests fail because toMastraTools is not exported yet, not because of a fixture or Mastra runtime error.

- [ ] Step 3: Add toMastraTools using native createTool

Implement the same structural host boundary as the AI SDK adapter:

~~~ts
type ToolsHost = {
  tools(options?: ToolsOptions): {
    execute: AgentTool;
    search: AgentTool;
    describe: AgentTool;
  };
};

export const toMastraTools = (
  engine: ToolsHost,
  options?: ToolsOptions,
): Record<string, Tool> => {
  const trio = engine.tools(options);
  const wrap = (source: AgentTool) =>
    createTool({
      id: source.name,
      description: source.description,
      inputSchema: source.inputSchema,
      execute: async (args) => source.execute(args),
    });
  return {
    [trio.execute.name]: wrap(trio.execute),
    [trio.search.name]: wrap(trio.search),
    [trio.describe.name]: wrap(trio.describe),
  };
};
~~~

If Mastra's inferred JSON Schema type is narrower than AgentTool.inputSchema, keep the source schema passed as the documented JSON Schema value and use a local structural cast at this boundary; do not convert it through Zod or the AI SDK.

- [ ] Step 4: Run the full Mastra adapter test file

Run:

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
~~~

Expected: all inbound and outbound tests pass, including direct execution of the outbound Mastra execute tool without a model provider.

- [ ] Step 5: Commit the outbound adapter

~~~sh
git add packages/callscript/src/adapters/mastra.ts packages/callscript/src/adapters/mastra.test.ts
git commit -m "feat: expose callscript tools to Mastra"
~~~

## Task 5: Add the provider-free example and user documentation

Files:

- Create: packages/callscript/examples/mastra.ts
- Modify: README.md
- Modify: packages/callscript/README.md
- Modify: packages/callscript/src/adapters/mastra.ts

Interfaces:

- Consumes the completed two-way adapter and existing example conventions.
- Produces discoverable installation and usage documentation with explicit direct-call limitations.

- [ ] Step 1: Add the runnable Mastra example

Create a provider-free example with this flow:

~~~ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { callscript } from "../src/index.ts";
import { fromMastraTools, toMastraTools } from "../src/adapters/mastra.ts";

const weather = createTool({
  id: "weather-source",
  description: "look up a city's weather",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({ temperature: z.number() }),
  execute: async ({ city }) => ({ temperature: city.length }),
});

const engine = callscript({
  tools: fromMastraTools({ weather }),
});

const result = await engine.run({
  script: { steps: [{ call: "weather", args: { city: "Brisbane" } }] },
});
console.log(result);

const mastraTools = toMastraTools(engine);
console.log(Object.keys(mastraTools));
~~~

Document that a real Mastra application can pass mastraTools to new Agent({ tools: mastraTools, ... }); the example itself must not require provider credentials or execute an agent loop.

- [ ] Step 2: Add source JSDoc

Document both exports and option types with examples explaining record-key and Mastra-id behavior, namespace and original-key override lookup, schema normalization and pre-execution validation, invalid_tool_args and mastra_validation_error, no fabricated Mastra execution context, native createTool construction, and options.names.

- [ ] Step 3: Update both README copies

In both README files:

1. Add callscript/mastra to the adapter list.
2. Add the optional install command:

~~~sh
npm install callscript @mastra/core
~~~

3. Add a With Mastra section after the AI SDK section containing a native createTool mounted with fromMastraTools, a toMastraTools result passed to a Mastra Agent, the record-key versus Mastra-id rule, namespace and override examples, validation/error behavior, execute requirement, and direct-invocation limits for approvals/background/stream/context features.

Use this core example:

~~~ts
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { callscript } from "callscript";
import { fromMastraTools, toMastraTools } from "callscript/mastra";

const weather = createTool({
  id: "weather-source",
  description: "look up a city's weather",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city }),
});

const engine = callscript({
  tools: fromMastraTools({ weather }),
});

const agent = new Agent({
  id: "callscript-agent",
  name: "callscript-agent",
  instructions: "Use the callscript tools.",
  tools: toMastraTools(engine),
});
~~~

Preserve the root README's existing MCP/playground/repo-layout material and the package README's existing package-specific material. Add the same Mastra prose and code block to both.

- [ ] Step 4: Run documentation and example checks

Run:

~~~sh
pnpm exec biome check README.md packages/callscript/README.md packages/callscript/examples/mastra.ts packages/callscript/src/adapters/mastra.ts
pnpm --filter callscript typecheck
~~~

Expected: Biome reports no issues and TypeScript accepts the example and adapter declarations.

- [ ] Step 5: Commit documentation and example

~~~sh
git add README.md packages/callscript/README.md packages/callscript/examples/mastra.ts packages/callscript/src/adapters/mastra.ts
git commit -m "docs: document Mastra tool adapters"
~~~

## Task 6: Run end-to-end verification and review the package artifact

Files:

- Inspect: packages/callscript/dist/mastra.js
- Inspect: packages/callscript/dist/mastra.d.ts
- Inspect: packages/callscript/package.json
- Inspect: README.md
- Inspect: packages/callscript/README.md

Interfaces:

- Consumes all implementation, tests, metadata, and documentation from Tasks 1–5.
- Produces evidence that the published entry point, declarations, runtime dependency boundary, and regressions are correct.

- [ ] Step 1: Run focused and full tests

~~~sh
pnpm --filter callscript test -- src/adapters/mastra.test.ts
pnpm --filter callscript test
pnpm test
~~~

Expected: focused Mastra tests, all callscript tests, and the workspace test task pass.

- [ ] Step 2: Run typecheck, build, lint, and diff checks

~~~sh
pnpm --filter callscript typecheck
pnpm --filter callscript build
pnpm lint
git diff --check
~~~

Expected: all commands exit zero; tsdown emits Mastra JavaScript and declarations.

- [ ] Step 3: Verify runtime imports and externalization

~~~sh
node --input-type=module -e 'const m = await import("./packages/callscript/dist/mastra.js"); if (typeof m.fromMastraTools !== "function" || typeof m.toMastraTools !== "function") process.exit(1); await import("./packages/callscript/dist/index.js");'
! rg -n "@mastra/core" packages/callscript/dist/index.js packages/callscript/dist/ai-sdk.js packages/callscript/dist/mcp.js
~~~

Expected: import smoke exits zero and the second command finds no Mastra import in unrelated artifacts. The Mastra artifact may retain an external @mastra/core import.

- [ ] Step 4: Review generated declarations and documentation consistency

Check that mastra.d.ts exports both functions and option/type declarations without private source paths. Compare the added With Mastra sections in both README files and confirm examples agree with tested names and error codes.

- [ ] Step 5: Inspect final changes and status

~~~sh
git diff a4a5899..HEAD --stat
git status --short
git log -6 --oneline
~~~

Expected: only planned package, source, test, example, lockfile, README, and plan/spec files are changed; generated dist output is ignored or included only if the repository tracks it; no unrelated worktree changes are present.

- [ ] Step 6: Commit any verification correction

If verification requires a source or documentation correction, rerun the relevant red/green and verification commands, then commit:

~~~sh
git add packages/callscript README.md pnpm-lock.yaml
git commit -m "fix: verify Mastra adapter integration"
~~~

Do not report completion until every acceptance criterion in docs/superpowers/specs/2026-09-01-mastra-adapter-design.md has fresh passing evidence.
