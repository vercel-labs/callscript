import { Code } from "@/components/code";
import { SiteHeader } from "@/components/site-header";
import { Tabs } from "@/components/tabs";
import { Toc } from "@/components/toc";

const GITHUB = "https://github.com/better-auth/callscript";

const jsonIcon = (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="13"
		height="13"
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2a2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1m8 0h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"
		/>
	</svg>
);

const jsIcon = (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="13"
		height="13"
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path
			fill="currentColor"
			d="M0 0h24v24H0V0zm22.034 18.276c-.175-1.095-.888-2.015-3.003-2.873-.736-.345-1.554-.585-1.797-1.14-.091-.33-.105-.51-.046-.705.15-.646.915-.84 1.515-.66.39.12.75.42.976.9 1.034-.676 1.034-.676 1.755-1.125-.27-.42-.404-.601-.586-.78-.63-.705-1.469-1.065-2.834-1.034l-.705.089c-.676.165-1.32.525-1.71 1.005-1.14 1.291-.811 3.541.569 4.471 1.365 1.02 3.361 1.244 3.616 2.205.24 1.17-.87 1.545-1.966 1.41-.811-.18-1.26-.586-1.755-1.336l-1.83 1.051c.21.48.45.689.81 1.109 1.74 1.756 6.09 1.666 6.871-1.004.029-.09.24-.705.074-1.65l.046.067zm-8.983-7.245h-2.248c0 1.938-.009 3.864-.009 5.805 0 1.232.063 2.363-.138 2.711-.33.689-1.18.601-1.566.48-.396-.196-.597-.466-.83-.855-.063-.105-.11-.196-.127-.196l-1.825 1.125c.305.63.75 1.172 1.324 1.517.855.51 2.004.675 3.207.405.783-.226 1.458-.691 1.811-1.411.51-.93.402-2.07.397-3.346.012-2.054 0-4.109 0-6.179l.004-.056z"
		/>
	</svg>
);

const tsIcon = (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width="13"
		height="13"
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path
			fill="currentColor"
			d="M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75q.918 0 1.627.111a6.4 6.4 0 0 1 1.306.34v2.458a4 4 0 0 0-.643-.361a5 5 0 0 0-.717-.26a5.5 5.5 0 0 0-1.426-.2q-.45 0-.819.086a2.1 2.1 0 0 0-.623.242q-.254.156-.393.374a.9.9 0 0 0-.14.49q0 .294.156.529q.156.234.443.444c.287.21.423.276.696.41q.41.203.926.416q.705.296 1.266.628q.561.333.963.753q.402.418.614.957q.213.538.214 1.253q0 .96-.363 1.617a2.9 2.9 0 0 1-.984 1.068a4.3 4.3 0 0 1-1.446.59q-.824.18-1.74.181a10 10 0 0 1-1.788-.15a5.4 5.4 0 0 1-1.449-.453v-2.626a5 5 0 0 0 1.565.881q.86.3 1.702.3q.494 0 .864-.09q.37-.089.617-.247q.245-.16.37-.378a.98.98 0 0 0 .126-.48a1.01 1.01 0 0 0-.199-.605a2 2 0 0 0-.5-.489a5 5 0 0 0-.786-.457q-.465-.225-1.052-.463a5.9 5.9 0 0 1-2.325-1.76q-.375-.55-.375-1.436q0-.899.361-1.542a3.2 3.2 0 0 1 .967-1.226a4.3 4.3 0 0 1 1.409-.717a5.9 5.9 0 0 1 1.713-.237M8.906 9.6h3.844v1.968H10.29v7.63H8.05v-7.63H5.626V9.6z"
		/>
	</svg>
);

function K({ children }: { children: React.ReactNode }) {
	return (
		<code className="rounded border border-line bg-raise px-1.5 py-0.5 font-mono text-[13px] text-ink">
			{children}
		</code>
	);
}

const sections = [
	{
		id: "why",
		title: "why",
		content: (
			<>
				<p>
					Say you have two GitHub tools mounted - <K>listIssues</K>, which
					returns the first 100 issues of a repo, and <K>closeIssue</K>, which
					closes one issue by number - plus <K>slack.post</K>, and you prompt
					the agent:
				</p>
				<div className="py-1 text-left font-mono text-[14px] text-ink">
					<span className="text-[17px] text-faint">›</span> close stale issues
					and notify #eng
				</div>
				<p>
					With plain tool calling, every <K>listIssues</K> call lands all 100
					issues in the agent&apos;s context. To pick the stale ones it has to
					read them; to close them it has to generate tokens for each{" "}
					<K>closeIssue</K> call - and so on, one round-trip at a time.
				</p>
				<p>
					That is slow, costs tokens, and there is no plan to review: no way to
					see the full set of calls ahead of time, judgments like
					&quot;stale&quot; are made mid-run, one reply at a time, and a small
					mistake - a missing argument, a wrong tool name - only surfaces as a
					runtime error on the server.
				</p>
				<p>
					<a
						href="https://developers.cloudflare.com/agents/tools/codemode/"
						className="text-ink underline underline-offset-4"
					>
						Code Mode
					</a>{" "}
					- or, in Anthropic&apos;s writing,{" "}
					<a
						href="https://www.anthropic.com/engineering/code-execution-with-mcp"
						className="text-ink underline underline-offset-4"
					>
						code execution with MCP
					</a>{" "}
					- solves this by giving the model type definitions for the tools and
					letting it write a TypeScript program against them: models are better
					at writing programs than at emitting tool-call chains, and results
					flow between calls without going back through the model. But code mode
					introduces its own complexity - from Anthropic&apos;s:
				</p>
				<blockquote className="border-l-2 border-line pl-4 text-[14px] leading-6 text-dim">
					Note that code execution introduces its own complexity. Running
					agent-generated code requires a secure execution environment with
					appropriate sandboxing, resource limits, and monitoring. These
					infrastructure requirements add operational overhead and security
					considerations that direct tool calls avoid. The benefits of code
					execution—reduced token costs, lower latency, and improved tool
					composition—should be weighed against these implementation costs.
				</blockquote>
				<p>
					But calling tools and APIs shouldn&apos;t need a Turing-complete
					language. By the{" "}
					<a
						href="https://en.wikipedia.org/wiki/Rule_of_least_power"
						className="text-ink underline underline-offset-4"
					>
						rule of least power
					</a>
					, the unused power is what forces the sandbox and keeps the code from
					being validated, bounded, or paused.
				</p>
			</>
		),
	},
	{
		id: "the-script",
		title: "the script",
		content: (
			<>
				<p>
					CallScript keeps{" "}
					<span className="text-ink">
						the parts of JavaScript the job needs
					</span>{" "}
					- calls, dataflow, branches, bounded fan-outs - and compiles them to
					inert data before anything executes. The benefits stay and the
					infrastructure goes: a plan and its state are plain data, so a run
					stores anywhere, resumes later, and takes new input when it does.
				</p>
				<p>
					The agent answers the same prompt by writing one small JavaScript
					program:
				</p>
				<Code
					code={`
// close stale issues and notify #eng
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
await slack.post({ channel: "#eng", text: "stale issues closed" });
`}
				/>
				<p>
					The engine never executes it - each statement compiles into one step
					of an inert JSON plan:
				</p>
				<Code
					code={`
{
	"intent": "close stale issues and notify #eng",
	"steps": [
		{ "id": "issues", "call": "github.listIssues", "args": { "repo": "api" } },
		{ "id": "stale", "let": "issues.filter(i => i.stale)" },
		{
			"id": "closed",
			"call": "github.closeIssue",
			"each": "stale.map(i => ({ repo: 'api', number: i.number }))",
			"max": 10
		},
		{
			"call": "slack.post",
			"args": { "channel": "#eng", "text": "stale issues closed" },
			"after": ["closed"]
		}
	]
}
`}
				/>
				<p>
					Steps reference each other by id, and those references are the
					schedule: independent steps run concurrently, dependent ones wait.
					Awaited calls keep statement order, and <K>Promise.all</K> runs calls
					in parallel. That one change buys:
				</p>
				<ul className="space-y-2.5 pl-5 list-disc marker:text-faint">
					<li>
						<span className="font-medium text-ink">Fewer tokens.</span>{" "}
						Intermediate results live in the run, not the context window - the
						agent never re-reads 100 issues to close two.
					</li>
					<li>
						<span className="font-medium text-ink">Serializable runs.</span> The
						plan and its record are plain data, so pause &amp; resume,
						approvals, and reading an earlier step&apos;s result need no extra
						infrastructure.
					</li>
					<li>
						<span className="font-medium text-ink">
							Deterministic and reviewable.
						</span>{" "}
						&quot;Stale&quot; is a filter in the plan, not a judgment repeated
						per issue - the same plan does the same thing, and you can approve
						it whole before anything runs.
					</li>
					<li>
						<span className="font-medium text-ink">Errors as dataflow.</span>{" "}
						<K>try/catch</K> compiles to an error branch, and an{" "}
						<K>idempotent</K> tool memoizes - retries never double-fire it.
					</li>
					<li>
						<span className="font-medium text-ink">
							Checked before it runs.
						</span>{" "}
						The plan validates whole - unknown tools, misshaped args, unbound
						references, all at once - so a model slip costs a validation
						message, not another round-trip.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "quick-start",
		title: "quick start",
		content: (
			<>
				<p>
					With the <span className="text-ink">ai sdk</span>, install the
					package, mount your tools on the engine, and hand the model the
					ready-made tool pair:
				</p>
				<Code
					lang="sh"
					code={`
npm install callscript
`}
				/>
				<Code
					code={`
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
`}
				/>
				<p>
					Or from the <span className="text-ink">cli</span>, add the CallScript
					skill to an existing agent (claude code, cursor, ...):
				</p>
				<Code
					lang="sh"
					code={`
npx callscript skill
`}
				/>
			</>
		),
	},
	{
		id: "language",
		title: "the language",
		content: (
			<>
				<p>Each step of a plan is one of three verbs:</p>
				<ul className="space-y-2.5 pl-5 list-disc marker:text-faint">
					<li>
						<K>call</K> - <K>const x = await tool.name(&#123;...&#125;)</K> -
						invokes a mounted tool; its <K>args</K> validate against the
						tool&apos;s schema before it fires. A second argument carries
						per-call options: <K>&#123; reason, suspend, onError &#125;</K>.
					</li>
					<li>
						<K>let</K> - <K>const x = expr</K> - derives a value from earlier
						steps with a pure expression.
					</li>
					<li>
						<K>return</K> - <K>if (cond) return value</K> - is a guard clause:
						when it fires the run ends right there with that value; otherwise
						the run continues.
					</li>
				</ul>
				<p>And a step can carry modifiers:</p>
				<ul className="space-y-2.5 pl-5 list-disc marker:text-faint">
					<li>
						<K>if</K> skips the step unless a condition holds.
					</li>
					<li>
						<K>each</K> fans a call out over a list, one dispatch per element,
						bounded by a hard <K>max</K>.
					</li>
					<li>
						<K>after</K> orders a step behind earlier ones when no data flows
						between them - close the issues, then post the summary.
					</li>
					<li>
						<K>suspend</K> flags a call for confirmation: the run pauses there
						until a human approves it.
					</li>
				</ul>
				<p>A few more things the language gives you:</p>
				<ul className="space-y-2.5 pl-5 list-disc marker:text-faint">
					<li>
						<span className="font-medium text-ink">Globals.</span> Expressions
						read earlier steps by id, <K>input</K> (data passed to this
						execution), variables published by earlier runs in the session,{" "}
						<K>$errors.stepId</K> for recorded failures, and safe built-ins like{" "}
						<K>Math</K>, <K>JSON</K>, and <K>Date</K>.
					</li>
					<li>
						<span className="font-medium text-ink">Promises.</span> Every call
						is async; <K>await</K> only decides whether the run blocks on it. A
						call <em>without</em> <K>await</K> (
						<K>const job = svc.export(&#123;...&#125;)</K>) detaches and keeps
						running in the background, and a later script joins it with{" "}
						<K>const r = await job</K>.
					</li>
					<li>
						<span className="font-medium text-ink">Expressions.</span> A
						side-effect-free subset of JS: arrows, template literals, ternaries,
						optional chaining - no I/O, no imports, no reaching outside the
						script&apos;s scope.
					</li>
					<li>
						<span className="font-medium text-ink">Output.</span> <K>output</K>{" "}
						projects the run&apos;s final result from any settled step; by
						default it is the last step&apos;s value.
					</li>
					<li>
						<span className="font-medium text-ink">Validation.</span> The whole
						plan is checked before anything runs - unknown tools, misshaped
						args, unbound references, all reported at once - and hard limits cap
						steps, total calls, and concurrency.
					</li>
				</ul>
			</>
		),
	},
	{
		id: "execute-search",
		title: "execute & search",
		content: (
			<>
				<p>
					The model never carries every tool card in its prompt.{" "}
					<K>engine.agentTools()</K> returns a host-neutral pair: <K>execute</K>{" "}
					takes the script the model authored, validates it at the door, and
					runs it against a shared session scope; <K>search</K> matches mounted
					tools by keyword and returns their signature cards.
				</p>
				<Code
					code={`
const { execute, search } = engine.agentTools({ scope });

// or wire a tool interface yourself:
const def = engine.toolDefinition(); // { description, inputSchema }
`}
				/>
				<p>
					With 20 or fewer tools the cards inline into <K>execute</K>&apos;s
					description. Past that - or with <K>inlineTools: false</K> - the model
					discovers tools through <K>search</K> instead, so the prompt stays the
					same size however many tools you mount. A rejected script returns{" "}
					<K>status: &quot;invalid&quot;</K> with every issue at once for the
					model to retry, and the session state rides the scope, never the
					prompt.
				</p>
			</>
		),
	},
	{
		id: "validation",
		title: "validation",
		content: (
			<>
				<p>
					The whole plan is checked before anything runs: unknown tools, args
					that don&apos;t match the tool&apos;s schema, references to steps that
					don&apos;t exist - every issue reported at once, not one runtime error
					per attempt.
				</p>
				<p>
					Anything outside the recognized grammar is rejected with a message
					that names the callscript spelling, so one retry usually converges:
				</p>
				<Code
					lang="text"
					code={`
while (queue.length) { await github.closeIssue({ number: next }); }
  ✗ line 1: unbounded loops cannot run - fan out over a bounded list
    instead: await Promise.all(items.slice(0, N).map(item => tool.name({ ... })))

closed = await github.closeIssue({ number: 7 });
  ✗ line 4: bindings are single-assignment - declare a new const instead of reassigning

const seen = new Set(ids);
  ✗ line 7: Unsupported syntax: new. Dedupe with
    xs.filter((x, i, a) => a.indexOf(x) === i)
`}
				/>
			</>
		),
	},
	{
		id: "limits",
		title: "limits",
		content: (
			<>
				<p>
					Every engine carries hard limits: validation enforces them before a
					run starts, execution enforces them while it runs, and{" "}
					<K>engine.describe()</K> renders the live numbers into the prompt, so
					the model authors against the same bounds the engine enforces.
				</p>
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-line text-left text-faint">
								<th className="py-2 pr-4 font-medium">limit</th>
								<th className="py-2 pr-4 font-medium">default</th>
								<th className="py-2 font-medium">bounds</th>
							</tr>
						</thead>
						<tbody>
							{(
								[
									["maxSteps", "20", "steps per script"],
									[
										"maxItemsPerStep",
										"100",
										"the max one each fan-out may declare",
									],
									["maxTotalCalls", "200", "worst-case total calls per script"],
									["maxConcurrency", "5", "independent calls in flight"],
									[
										"maxExprNodes",
										"100 000",
										"AST nodes evaluated per expression",
									],
									[
										"maxCallResultBytes",
										"10 MiB",
										"serialized size of one call's result",
									],
									[
										"maxSuspendAttempts",
										"5",
										"re-raises of one suspension key",
									],
								] as const
							).map(([name, def, what]) => (
								<tr key={name} className="border-b border-line">
									<td className="py-2 pr-4">
										<K>{name}</K>
									</td>
									<td className="py-2 pr-4">{def}</td>
									<td className="py-2">{what}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p>
					Override any subset:{" "}
					<K>
						callscript(&#123; tools, limits: &#123; maxTotalCalls: 50 &#125;
						&#125;)
					</K>
					.
				</p>
			</>
		),
	},
	{
		id: "suspend-resume",
		title: "suspend & resume",
		content: (
			<>
				<p>
					A tool can throw <K>suspend(...)</K> to park the run on an external
					event, or <K>earlyReturn(...)</K> to end it. The suspended run comes
					back as a serializable <K>state</K> record: store it anywhere,
					re-execute later with the answer piped in as <K>input</K>, and settled
					steps are reused instead of re-run.
				</p>
				<Tabs
					tabs={[
						{
							label: "js",
							icon: jsIcon,
							panel: (
								<Code
									code={`
// auth.challenge suspends the run on an external event
const gate = await auth.challenge({});
// on re-execute, the answer arrives as \`input\`
const session = await auth.verify({ code: input.code });
`}
								/>
							),
						},
						{
							label: "ts",
							icon: tsIcon,
							panel: (
								<Code
									code={`
const first = await engine.run({ script }); // status: "suspended"

const second = await engine.run({
	script,
	state: first.state, // plain data - survives a restart
	input: { code: "42" }, // flows into expressions as \`input\`
});
`}
								/>
							),
						},
					]}
				/>
			</>
		),
	},
	{
		id: "error-branch",
		title: "the error branch",
		content: (
			<>
				<p>
					Errors are dataflow, with the same dependency edges as values. In JS
					it is just <K>try/catch</K>: the call records its failure instead of
					failing the run, and the catch body reads it - in the plan that is{" "}
					<K>onError: &quot;skip&quot;</K> plus <K>$errors.&lt;stepId&gt;</K>.
				</p>
				<Tabs
					tabs={[
						{
							label: "js",
							icon: jsIcon,
							panel: (
								<Code
									code={`
try {
  const closed = await github.closeIssue({ number: 42 });
} catch (e) {
  await slack.post({ text: \`close failed: \${e.message}\` });
}
`}
								/>
							),
						},
						{
							label: "json",
							icon: jsonIcon,
							panel: (
								<Code
									code={`
{ id: "closed", call: "github.closeIssue", args: { /* ... */ }, onError: "skip" },
{ if: "$errors.closed", call: "slack.post",
  args: { text: "=\`close failed: \${$errors.closed.message}\`" } }
`}
								/>
							),
						},
					]}
				/>
			</>
		),
	},
	{
		id: "sessions",
		title: "sessions & scope",
		content: (
			<>
				<p>
					<K>engine.scope()</K> mints the session as a plain value - no hidden
					machinery. Runs handed the same scope share the accumulated record:
					settled steps are reused, published outputs become session variables
					later scripts read by name, and <K>vars</K> carries host-seeded data.
				</p>
				<Code
					code={`
const scope = engine.scope({ user }); // seeds vars

await engine.run({ script: one }, scope);
await engine.run({ script: two }, scope); // reads one's step outputs
`}
				/>
				<p>
					This is how an agent recalls what it already did: a result computed
					three runs ago is addressable by name instead of re-fetched through a
					tool call. Tools see the scope too - <K>execute(args, ctx)</K>{" "}
					receives <K>ctx.scope</K> - and <K>engine.session()</K> opens the full
					runner on the same registry: detached background runs,{" "}
					<K>await.&lt;id&gt;</K> joins, and a settlement digest.
				</p>
			</>
		),
	},
	{
		id: "memoization",
		title: "idempotent tools memoize",
		content: (
			<>
				<p>
					A tool declaring <K>idempotent: true</K> promises
					same-args-same-result. The engine then serves repeated calls by input
					addressing: same tool plus same resolved args is one dispatch per
					scope, shared even between concurrent steps - the memo holds the
					in-flight promise, and failures never cache. The AI SDK shape
					can&apos;t express it, so pass it as an override:
				</p>
				<Code
					code={`
fromAISDKTools(tools, {
	overrides: { "svc.lookup": { idempotent: true } },
});
`}
				/>
			</>
		),
	},
	{
		id: "scripts-as-tools",
		title: "scripts compile into tools",
		content: (
			<>
				<p>
					<K>engine.tool(name, script)</K> turns a script into a mountable tool
					of another engine, and the signals compose: an inner approval gate
					ends the hosting run early, an inner suspension parks it, and the
					answer flows back down through args.
				</p>
				<Code
					code={`
const closeStale = engine.tool("github.closeStale", script);

const scope = engine.scope();
await closeStale.execute({}, { scope });                 // gate -> early return
await closeStale.execute({ approved: true }, { scope }); // settled steps reused
`}
				/>
			</>
		),
	},
	{
		id: "adapters",
		title: "adapters",
		content: (
			<>
				<p>
					The engine never knows where a tool came from; everything mounts
					through one neutral shape - <K>&#123; name, execute &#125;</K> plus
					optional schemas - so sources mix freely, namespaced side by side:
				</p>
				<Tabs
					tabs={[
						{
							label: "ai sdk",
							panel: (
								<Code
									code={`
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

const engine = callscript({
	tools: [
		...fromAISDKTools(github, { namespace: "github" }),
		...fromAISDKTools(slack, { namespace: "slack" }),
	],
});

// hand the model the engine as the execute/search pair
await generateText({ model, prompt, tools: toAISDKTools(engine) });
`}
								/>
							),
						},
						{
							label: "eve",
							panel: (
								<Code
									code={`
// lib/callscript.ts
import { toEveTools } from "callscript/eve";
export const { execute, search } = toEveTools(engine);

// agent/tools/execute.ts - eve tools are one file per tool
export { execute as default } from "../../lib/callscript";
`}
								/>
							),
						},
						{
							label: "plain",
							panel: (
								<Code
									code={`
import { callscript, tool } from "callscript";

const closeIssue = tool({
	name: "github.closeIssue",
	description: "close an issue by number",
	inputSchema: { /* zod, any standard schema, or json schema */ },
	execute: ({ number }) => ({ closed: number }),
});

const engine = callscript({ tools: [closeIssue] });
`}
								/>
							),
						},
					]}
				/>
				<p>
					Throw protocol from <K>execute</K>: throw to fail the step (a string{" "}
					<K>code</K> on the error becomes the step error&apos;s code),{" "}
					<K>throw earlyReturn(value)</K> to end the run here,{" "}
					<K>throw suspend(&#123; key &#125;)</K> to park it on an external
					event.
				</p>
			</>
		),
	},
	{
		id: "typed-authoring",
		title: "typed authoring",
		content: (
			<>
				<p>
					<K>engine.script(&#123;...&#125;)</K> and <K>engine.tool(...)</K> are
					typed against the engine: <K>call</K> autocompletes to mounted tool
					names and <K>args</K> to that tool&apos;s input, so a typo&apos;d name
					is a type error before it is a validation error. Every expression
					position takes the string form or a real JS arrow, transpiled - never
					executed - into the string at the door:
				</p>
				<Code
					code={`
engine.script({
	steps: [
		{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
		{ id: "stale", let: ({ issues }) => issues.filter((i) => i.stale) },
	],
});
`}
				/>
				<p>
					The arrow&apos;s parameter names everything the body reads; a free
					name - including a captured outer variable, the thing a native closure
					could smuggle in - is rejected at the door. What&apos;s stored,
					hashed, and re-executed is always the string form, so the script stays
					inert data.
				</p>
			</>
		),
	},
];

export default function Home() {
	return (
		<div className="readme-bg min-h-dvh">
			<SiteHeader github={GITHUB} active="readme" />
			<div className="mx-auto flex max-w-6xl justify-center gap-12 px-6 pt-6 pb-16 sm:px-10">
				<aside className="order-last sticky top-20 hidden h-fit w-44 shrink-0 pt-10 lg:block">
					<Toc items={sections.map(({ id, title }) => ({ id, title }))} />
				</aside>
				<main className="min-w-0 max-w-3xl flex-1">
					{/* hero */}
					<section className="pt-8">
						<h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
							CallScript
						</h1>
						<p className="mt-4 text-lg font-medium tracking-tight text-ink sm:text-xl">
							Code Mode, without the sandbox.
						</p>
						<p className="mt-4 max-w-[60ch] text-base leading-7 text-dim">
							The model writes a subset of JavaScript; callscript turns it into
							a{" "}
							<a
								href="#the-script"
								className="text-ink underline underline-offset-4"
							>
								JSON plan
							</a>{" "}
							that can be analyzed, safely executed, serialized, paused, and
							resumed - the benefits of code execution, without the complexity.
						</p>
					</section>
					{sections.map((s) => (
						<section key={s.id} id={s.id} className="scroll-mt-20 pt-12">
							<h2 className="mb-4 border-b border-line pb-2 text-xl font-semibold tracking-tight text-ink capitalize">
								{s.title}
							</h2>
							<div className="space-y-4 text-base leading-7 text-dim">
								{s.content}
							</div>
						</section>
					))}
				</main>
			</div>
		</div>
	);
}
