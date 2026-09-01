# First-class Mastra tool adapters for callscript

Date: 2026-09-01

Status: Proposed; awaiting user review before implementation

## Objective

Add a Mastra integration that mirrors the existing AI SDK integration:

~~~ts
import { fromMastraTools, toMastraTools } from "callscript/mastra";
~~~

The adapter must work with Mastra's native tool contract, including tools
created with createTool, while preserving callscript's neutral
ScriptTool/ToolsHost model and keeping Mastra optional for users who only use
callscript, the AI SDK adapter, or MCP.

## Existing callscript contract

The existing callscript/ai-sdk adapter establishes the intended shape:

- fromAISDKTools(record, options?) mounts an object of provider tools into a
  callscript engine.
- Record keys become callscript tool names, with an optional namespace.
- Provider schemas are normalized to JSON Schema for callscript's tool cards.
- Missing execution functions are rejected when tools are mounted.
- Inputs are validated before the provider function is called.
- toAISDKTools(engine, options?) exposes callscript's execute/search/describe
  tools under provider-facing names.
- The engine's names option is preserved in the outbound adapter.

The Mastra adapter will follow those semantics where the two ecosystems have
the same concept, and will use Mastra's own schema and tool runtime where
Mastra has behavior that callscript should not reimplement.

## Research findings

The public Mastra contract was reviewed against the current Mastra
documentation, source, and published packages on 2026-09-01:

- Mastra documents createTool as the native way to define a tool. A tool has
  an id, description, input/output schemas, and an execute function. The first
  execute argument is the validated input and the second argument is Mastra's
  execution context.
  See [Mastra createTool documentation](https://mastra.ai/reference/tools/create-tool).
- Mastra's Tool class normalizes schemas through the Standard Schema contract,
  validates input and output, and can return a structured ValidationError
  result. createTool returns that Tool object.
  See the [Mastra Tool implementation](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/tools/tool.ts).
- Mastra exports createTool, Tool, ToolAction, and isValidationError from
  @mastra/core/tools. It exports toStandardSchema and
  standardSchemaToJSONSchema from @mastra/core/schema.
- Mastra agents accept a record of Mastra tools. The record key is the
  model-facing tool name; the tool's id remains the tool's source identity.
- The current published package observed during research was
  @mastra/core 1.63.2. The package exposes the tools and schema subpaths and
  accepts Zod 3 or Zod 4 as a peer. The implementation will use a broad
  @mastra/core 1.x peer range so the adapter does not unnecessarily pin
  consumers to the research snapshot.

## Goals

1. Provide fromMastraTools and toMastraTools from a new callscript/mastra
   subpath.
2. Accept native Mastra Tool objects and structurally compatible Mastra
   ToolAction values.
3. Preserve Mastra's schema normalization and tool-level validation behavior
   instead of converting Mastra tools through the AI SDK.
4. Keep @mastra/core an optional peer dependency so existing installations
   remain valid unless the Mastra subpath is used.
5. Document installation, both directions of conversion, naming, validation,
   error behavior, and the boundary between direct tool invocation and
   Mastra-agent execution.
6. Cover the adapter with focused tests that do not require a model provider,
   network access, or Mastra agent execution.

## Non-goals

- Implementing a Mastra model/provider adapter.
- Recreating Mastra agent-only behavior inside callscript, such as approval
  prompts, background task orchestration, streaming hooks, or agent/workflow
  context.
- Inventing a second tool protocol or routing Mastra through
  callscript/ai-sdk.
- Making a client-only Mastra tool executable when it has no execute function.
- Adding a hard Mastra dependency to the base callscript entry point.

## Public API

The implementation will add packages/callscript/src/adapters/mastra.ts and
export it as callscript/mastra.

### Import direction: Mastra to callscript

~~~ts
type MastraToolLike = {
  id?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute?: (...args: any[]) => unknown | Promise<unknown>;
};

type MastraToolOverrides<T> = {
  [K in keyof T]?: {
    errors?: readonly string[];
    description?: string;
  };
};

type FromMastraToolsOptions<T, Namespace extends string | undefined> = {
  namespace?: Namespace;
  overrides?: MastraToolOverrides<T>;
};

function fromMastraTools<
  T extends Record<string, MastraToolLike>,
  Namespace extends string | undefined = undefined,
>(
  tools: T,
  options?: FromMastraToolsOptions<T, Namespace>,
): Array<ScriptTool<NamespacedKey<keyof T & string, Namespace>, unknown, unknown>>;
~~~

The concrete generic return type should retain the same useful key and
namespace inference as fromAISDKTools; the sketch above describes the
surface, not the exact conditional type implementation.

Semantics:

- Each input record key is the callscript tool name. If namespace is supplied,
  the mounted name is namespace + "." + key.
- The Mastra id is source metadata and does not replace the record key. This
  matches how a Mastra agent uses a tool record and avoids surprising name
  changes when the same tool is mounted under different keys.
- A tool without an executable execute function throws during mounting with
  an actionable error, matching the AI SDK adapter's client-tool behavior.
- description and errors can be overridden by the original record key, even
  when a namespace is used.
- Input and output schemas are converted to callscript JSON Schema cards with
  Mastra's toStandardSchema and standardSchemaToJSONSchema helpers. Missing
  schemas remain absent.
- Before invocation, the adapter validates the callscript arguments with the
  normalized Mastra input schema. A failure throws an error with
  code: "invalid_tool_args" and the underlying validation detail.
- The adapter then invokes the supplied Mastra execute function with the
  validated input and no fabricated Mastra execution context. For a native
  Tool returned by createTool, its own wrapper still performs Mastra's normal
  tool-level validation, output validation, transforms, and hooks.
- If the Mastra execution result satisfies isValidationError, the adapter
  throws an error with code: "mastra_validation_error" and preserves the
  Mastra message/validation detail. Other errors from the supplied tool
  propagate unchanged.

### Export direction: callscript to Mastra

~~~ts
function toMastraTools(
  engine: ToolsHost,
  options?: ToolsOptions,
): Record<string, Tool>;
~~~

The result contains three Mastra Tool instances corresponding to the
callscript engine's execute, search, and describe tools. For each source
AgentTool:

- id is the exposed tool name returned by engine.tools(options).
- description is copied from the source tool.
- inputSchema is copied as JSON Schema, which Mastra accepts as a standard
  schema input.
- execute delegates to the source callscript tool with the supplied
  arguments.
- The returned record keys match the AgentTool names, including any custom
  options.names overrides.

This means the result can be passed directly to a Mastra Agent's tools
configuration. Calling one of these wrappers directly invokes callscript's
tool surface; it does not create Mastra agent context or add agent-only
orchestration.

## Data flow

### Mastra to callscript

~~~text
Mastra tool record
  -> record key and optional namespace determine ScriptTool.name
  -> Mastra Standard Schema normalization
  -> JSON Schema cards for callscript
  -> callscript input validation
  -> Mastra execute(input, no fabricated context)
  -> normal result or mapped Mastra ValidationError
~~~

### callscript to Mastra

~~~text
callscript engine.tools(options)
  -> execute/search/describe AgentTools
  -> createTool({ id, description, inputSchema, execute })
  -> Mastra Tool record keyed by exposed name
  -> usable in a Mastra Agent tools record
~~~

## Packaging and dependency design

Update packages/callscript/package.json:

- Add ./mastra to exports, with the same import/types/default declaration
  shape as the existing adapter subpaths.
- Add mastra to the tsdown entry list.
- Add @mastra/core as an optional peer dependency with a compatible 1.x
  range.
- Add the same package as a development dependency so the adapter and tests
  compile against a real published Mastra implementation.
- Add @mastra/core to the never-bundle list. Consumers must resolve their own
  optional Mastra installation.

Update the lockfile through the package manager after the manifest changes.
The base, AI SDK, and MCP entry points must remain usable without installing
Mastra.

## Documentation changes

Keep the root README.md and packages/callscript/README.md synchronized.

1. Add callscript/mastra to the adapter/entry-point list.
2. Update installation guidance with the optional Mastra peer:

   ~~~sh
   npm install callscript @mastra/core
   ~~~

3. Add a “With Mastra” section after the AI SDK section containing:
   - a native createTool example mounted with fromMastraTools;
   - a toMastraTools example passed to a Mastra Agent;
   - the record-key versus Mastra-id naming rule;
   - namespace and override examples;
   - schema-validation and mastra_validation_error behavior;
   - the requirement that directly mounted tools have execute;
   - the direct-invocation boundary for approvals, background tasks, stream
     hooks, and agent/workflow context.
4. Add packages/callscript/examples/mastra.ts as a provider-free runnable
   reference using createTool, both adapter directions, and the existing
   callscript engine setup.
5. Add source-level JSDoc for both public functions and the key options.

No changelog entry is required for the initial implementation unless the
repository's release workflow requires one.

## Test plan

Add packages/callscript/src/adapters/mastra.test.ts with tests for:

1. Mounting an actual createTool under its record key and executing it
   through a callscript engine.
2. Preserving Mastra input/output schema cards and the source id/record-key
   distinction.
3. Namespace handling and overrides keyed by the original record key.
4. Invalid callscript input being rejected before the Mastra execute function
   is reached, with invalid_tool_args.
5. A native Mastra output-validation failure becoming
   mastra_validation_error.
6. A missing execute function being rejected during mounting.
7. toMastraTools returning native Mastra tools with the expected execute,
   search, and describe names and schemas.
8. Custom options.names values being reflected in the returned record.
9. Direct execution of an outbound wrapper delegating to the callscript
   engine without requiring a model or network.

Tests should use deterministic tool definitions and avoid depending on
Mastra's agent loop, provider credentials, or external services.

## Verification gates

Before implementation is reported complete, run and inspect:

- focused Mastra adapter tests;
- the package typecheck;
- the package build, including declaration generation and the new export;
- repository lint/format checks and git diff --check;
- the existing AI SDK and MCP tests to detect adapter/build regressions;
- a package-level import smoke check for callscript/mastra and a base
  callscript import without Mastra-specific runtime use.

The final review must verify that the README copies agree, the published
package metadata points at generated Mastra artifacts, and no Mastra code was
bundled into unrelated entry points.

## Risks and mitigations

### Mastra API evolution

Mastra's public tools and schema APIs are versioned independently of
callscript. Keep imports on documented subpaths, use the published
isValidationError/schema helpers, and constrain the peer range to the
supported major line.

### Schema dialect differences

Do not hand-convert Zod, Standard Schema, or JSON Schema values. Let Mastra
normalize them, then render the JSON Schema representation required by
callscript and pass JSON Schema back to createTool in the reverse direction.

### Context loss on direct calls

Callscript's ToolCallContext and Mastra's execution context have different
lifecycles. The first implementation will not pretend they are equivalent.
Documentation will explicitly describe the boundary, and future context
bridging can be added as a separate, reviewed API if a real use case
requires it.

### Optional dependency loading

The Mastra import must live only in the Mastra adapter entry point. Build
configuration and a smoke check will ensure users of other entry points do
not need @mastra/core at runtime.

## Acceptance criteria

The feature is ready when:

- fromMastraTools and toMastraTools are importable from callscript/mastra;
- native createTool instances round-trip through the intended direction;
- the returned tools are accepted by a Mastra Agent tools record;
- naming, namespaces, schemas, validation, and errors match this spec;
- the optional dependency and generated package exports are correct;
- the synchronized documentation and provider-free example explain the
  integration and its limitations;
- all listed verification gates pass.
