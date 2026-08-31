import { Code } from "@/components/code";
import { SiteHeader } from "@/components/site-header";
import { Tabs } from "@/components/tabs";
import { Toc } from "@/components/toc";

const GITHUB = "https://github.com/vercel-labs/callscript";

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
					closes one issue by number - and you prompt the agent:{" "}
					<span className="text-ink">&quot;close stale issues&quot;</span>.
				</p>
				<p>
					With plain tool calling, every <K>listIssues</K> call lands all 100
					issues in the agent&apos;s context. To pick the stale ones it has to
					read them; to close them it has to generate tokens for each{" "}
					<K>closeIssue</K> call - and so on, one round-trip at a time.
				</p>
				<p>
					That is slow, costs tokens, no way to see the full set of calls ahead
					of time, judgments like &quot;stale&quot; are made mid-run and so on..
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
// close stale issues
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
`}
				/>
				<p>
					callscript never executes it - each statement compiles into one step
					of an inert JSON plan:
				</p>
				<Code
					code={`
{
	"intent": "close stale issues",
	"steps": [
		{ "id": "issues", "call": "github.listIssues", "args": { "repo": "api" } },
		{ "id": "stale", "let": "issues.filter(i => i.stale)" },
		{
			"id": "closed",
			"call": "github.closeIssue",
			"each": "stale.map(i => ({ repo: 'api', number: i.number }))",
			"max": 10
		}
	]
}
`}
				/>
				<p>
					Steps reference each other by id, and those references are the
					schedule: independent steps run concurrently, dependent ones wait.
					Awaited calls keep statement order, and <K>Promise.all</K> runs calls
					in parallel.
				</p>
			</>
		),
	},
	{
		id: "usage",
		title: "usage",
		content: (
			<>
				<Code
					lang="sh"
					code={`
npm install callscript
`}
				/>
				<p>
					Mount your tools on callscript and hand the model the ready-made tools
					- <K>execute</K>, <K>search</K>, and <K>describe</K>:
				</p>
				<Tabs
					tabs={[
						{
							label: "ai sdk",
							panel: (
								<Code
									code={`
import { generateText } from "ai";
import { callscript } from "callscript";
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

const cs = callscript({
	tools: fromAISDKTools(tools, { namespace: "github" }),
});

await generateText({
	model: "anthropic/claude-sonnet-5",
	prompt: "Close every stale open issue in the 'api' repo.",
	tools: toAISDKTools(cs), // execute + search + describe
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
		id: "tool-definitions",
		title: "tool definitions",
		content: (
			<>
				<p>
					In callscript, a tool is anything an executor can evaluate. Executors
					come from adapters - the AI SDK, MCP, and others - and the default
					executor evaluates a plain object: <K>&#123; name, execute &#125;</K>{" "}
					plus an optional schema and description:
				</p>
				<Tabs
					tabs={[
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

const cs = callscript({ tools: [closeIssue] });
`}
								/>
							),
						},
						{
							label: "ai sdk",
							panel: (
								<Code
									code={`
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

const cs = callscript({
	tools: fromAISDKTools(github, { namespace: "github" }),
});

// hand the model callscript's tools: execute + search + describe
await generateText({ model, prompt, tools: toAISDKTools(cs) });
`}
								/>
							),
						},
						{
							label: "mcp",
							panel: (
								<Code
									code={`
import { fromMCP } from "callscript/mcp";

// any MCP client with listTools/callTool fits
const cs = callscript({
	tools: await fromMCP(client, { namespace: "github" }),
});
`}
								/>
							),
						},
					]}
				/>
				<h3 className="pt-2 text-[15px] font-medium text-ink">
					function signatures
				</h3>
				<p>
					callscript turns each tool definition into a function signature: one
					card with the signature line, the description, and any declared error
					codes.
				</p>
				<Code
					code={`
github.closeIssue({ repo: string, number: number }) -> { closed: number }
  close an issue by number
  errors: not_found
`}
				/>
				<h3 className="pt-2 text-[15px] font-medium text-ink">search</h3>
				<p>
					Tools are meant to be discovered: <K>search</K> finds mounted tools by
					keyword and returns names with one-line summaries, and <K>describe</K>{" "}
					returns the full signature cards for the names a script will use. You
					pick the exposure. Append every card into the prompt when the toolset
					is small; or list only names and short descriptions and let the agent{" "}
					<K>describe</K> the ones it needs - no searching to discover - or
					expose nothing inline and let it <K>search</K> first, so the prompt
					stays the same size however many tools you mount. <K>execute</K> is
					the third tool of the pair - the one that acts, running the script the
					model authored.
				</p>
				<Code
					code={`
const { execute, search, describe } = cs.tools();
`}
				/>
			</>
		),
	},
	{
		id: "serializability",
		title: "serializability",
		content: (
			<>
				<p>
					An execution of a callscript is data all the way down: the plan, every
					settled step, and the point where it stopped all serialize into one
					plain record. You can flag a risky call for approval, park a run on an
					external event, or leave a long job running and join it from a later
					script:
				</p>
				<Code
					code={`
// the agent flags the risky call - the run pauses right there
const closed = await github.closeIssue({ number: 42 }, { suspend: true });
`}
				/>
				<p>which compiles to the plan step:</p>
				<Code
					code={`
{ "id": "closed", "call": "github.closeIssue", "args": { "number": 42 }, "suspend": true }
`}
				/>
				<p>
					The paused run comes back as a plain <K>state</K> record that can be
					stored in memory or as a KV entry; when the answer arrives, execution
					continues from the serialized record - settled steps reused, not
					re-run.
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
					<K>cs.script(&#123;...&#125;)</K> and <K>cs.tool(...)</K> are typed
					against the mounted tools: <K>call</K> autocompletes to mounted tool
					names and <K>args</K> to that tool&apos;s input, so a typo&apos;d name
					is a type error before it is a validation error. Every expression
					position takes the string form or a real JS arrow, transpiled - never
					executed - into the string at the door:
				</p>
				<Code
					code={`
cs.script({
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
	{
		id: "reference",
		title: "reference",
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
							A tool-calling language for LLMs. The model writes a subset of
							JavaScript - CallScript parses it into a JSON plan instead of
							executing it. Plans can be approved deterministically, stored, and
							resumed later, and steps reference earlier results by id.
						</p>
						<div className="mt-6">
							<Code
								code={`
// close stale issues and notify slack
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
const closed = await Promise.all(
  stale.map(i => github.closeIssue({ number: i.number })));
await slack.post({ text: \`closed \${closed.length} stale issues\` });
`}
							/>
						</div>
						<p className="mt-4 text-sm text-faint">compiles to</p>
						<div className="mt-2">
							<Code
								code={`
{
	"intent": "close stale issues and notify slack",
	"steps": [
		{ "id": "issues", "call": "github.listIssues", "args": { "repo": "api" } },
		{ "id": "stale", "let": "issues.filter(i => i.stale)" },
		{ "id": "closed", "call": "github.closeIssue", "each": "stale.map(i => ({ number: i.number }))" },
		{ "call": "slack.post", "args": { "text": "=\`closed \${closed.length} stale issues\`" } }
	]
}
`}
							/>
						</div>
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
