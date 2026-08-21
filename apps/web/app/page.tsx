import { Code } from "@/components/code";
import { SiteHeader } from "@/components/site-header";
import { Tabs } from "@/components/tabs";

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
		<code className="rounded-none border border-line bg-raise px-1.5 py-0.5 font-mono text-[13px] text-ink">
			{children}
		</code>
	);
}

const sections = [
	{
		n: "00",
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
import { scriptEngine } from "callscript";
import { toAISDKTools, fromAISDKTools } from "callscript/ai-sdk";

const engine = scriptEngine({
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
					Or from the <span className="text-ink">cli</span>, add the callscript
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
		n: "01",
		title: "why",
		content: (
			<>
				<p>
					With normal tool calling, the model makes one call per round-trip.
					Every intermediate result has to travel back through the context
					window just so the model can decide the next call. That is slow, it
					costs tokens, and there is no plan anywhere you can look at - just a
					growing transcript.
				</p>
				<p>
					With callscript, the model writes the{" "}
					<span className="text-ink">whole plan up front</span>, as plain
					JavaScript it never gets to run. The engine checks it, runs the
					steps - in parallel where they don&apos;t depend on each other - and
					passes results between them directly, without going back through the
					prompt.
				</p>
			</>
		),
	},
	{
		n: "01b",
		title: "why not code mode",
		content: (
			<>
				<p>
					<span className="text-ink">Code Mode</span> attacks the same problem
					by letting the model write real TypeScript against the tools, and the
					insight is right: models are better at writing programs than at
					emitting tool-call chains. callscript keeps the surface - the model
					still writes what reads as a small JS program - but{" "}
					<span className="text-ink">
						compiles it to inert data instead of executing it
					</span>
					, avoiding the trade-offs of running arbitrary model-written code:
				</p>
				<ul className="space-y-2.5 pl-5 list-disc marker:text-faint">
					<li>
						<span className="font-medium text-ink">Runtime.</span> You need
						somewhere to run it: a container, a V8 isolate, or a JS VM bundled
						into your app. callscript runs no code, so the engine is just a
						library in your process.
					</li>
					<li>
						<span className="font-medium text-ink">Security.</span> The sandbox
						has to be locked down: no network access, credentials kept out of
						the code&apos;s reach. In callscript the only things that can run
						are the tools you mounted.
					</li>
					<li>
						<span className="font-medium text-ink">Validation.</span> Code can
						only fail while it&apos;s running, one error at a time. A script is
						checked before it runs, and every problem is reported at once.
					</li>
					<li>
						<span className="font-medium text-ink">Limits.</span> Nothing stops
						a loop from calling a tool a thousand times unless you build limits
						yourself. In a script, every fan-out declares a <K>max</K> and the
						engine enforces it.
					</li>
					<li>
						<span className="font-medium text-ink">Results.</span> Sandboxed
						code hands results back as logged text you parse afterwards. Script
						steps return plain values you can read directly.
					</li>
					<li>
						<span className="font-medium text-ink">Resumability.</span> Pausing
						running code takes a durable-execution framework and code written
						carefully to its rules. A script run is just data: it can stop at an
						approval and resume where it left off, settled steps reused.
					</li>
				</ul>
			</>
		),
	},
	{
		n: "02",
		title: "the script",
		content: (
			<>
				<p>
					A callscript is written as the JavaScript an agent already knows - so
					it needs almost no instruction - and{" "}
					<span className="text-ink">
						compiled by the engine into an inert JSON plan, never executed as
						code
					</span>
					. Each statement desugars into one step: a <K>const</K> with{" "}
					<K>await</K> is a tool call, a plain <K>const</K> a pure derivation,{" "}
					<K>if (cond) return v</K> a guard, <K>Promise.all</K> over a{" "}
					<K>.map</K> a bounded fan-out, <K>try/catch</K> the error branch. The
					plan can also be authored directly as JSON, or in TypeScript with full
					typing:
				</p>
				<Tabs
					tabs={[
						{
							label: "js",
							icon: jsIcon,
							panel: (
								<Code
									code={`
// close stale issues
const issues = await github.listIssues({ repo: "api" });
const stale = issues.filter(i => i.stale);
if (stale.length === 0) return { closed: 0 };
const closed = await Promise.all(
  stale.slice(0, 10).map(i => github.closeIssue({ repo: "api", number: i.number })));
return { count: closed.length };
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
							),
						},
						{
							label: "ts",
							icon: tsIcon,
							panel: (
								<Code
									code={`
import { engine } from "./engine"; // your scriptEngine instance

// fully typed: \`call\` autocompletes to mounted tool names, \`args\`
// to that tool's input; arrows are transpiled (never executed)
// into the string form, so the script stays inert data
const script = engine.script({
	steps: [
		{ id: "issues", call: "github.listIssues", args: { repo: "api" } },
		{ id: "stale", let: ({ issues }) => issues.filter((i) => i.stale) },
		{
			call: "github.closeIssue",
			each: ({ stale }) => stale.map((i) => ({ repo: "api", number: i.number })),
			max: 10,
		},
	],
});
`}
								/>
							),
						},
					]}
				/>
				<p>
					Under the surface, a script is one inert JSON plan: a list of steps
					wired by dataflow. Steps reference each other by id, and those
					references are the schedule - independent steps run concurrently,
					dependent ones wait for their inputs. In the JS form, awaited calls
					additionally run in statement order (the compiler adds ordering edges
					where no data flows), and <K>Promise.all</K> is the spelling for
					&quot;these run in parallel&quot;. Each step is one of three verbs:
				</p>
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
		n: "04",
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
		n: "05",
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
		n: "06",
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
];

export default function Home() {
	return (
		<div className="readme-bg min-h-dvh">
			<SiteHeader github={GITHUB} active="readme" />
			<main className="mx-auto max-w-3xl px-6 pt-6 pb-16 sm:px-10">
				{/* hero */}
				<section className="pt-8">
					<h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
						callscript
					</h1>
					<p className="mt-4 text-lg font-medium tracking-tight text-ink sm:text-xl">
						Code Mode, without the sandbox.
					</p>
					<p className="mt-4 max-w-[60ch] text-base leading-7 text-dim">
						The model writes plain JavaScript - the language it already knows,
						not a custom DSL - and{" "}
						<span className="text-ink">it never runs</span>. The engine compiles
						it into an inert JSON plan, validates the whole thing before
						anything executes, and the only things that can run are the tools
						you mounted. Loops, branches, dataflow, bounded calls - none of the
						machinery.
					</p>
				</section>
				{sections.map((s) => (
					<section key={s.n} className="pt-12">
						{s.title ? (
							<h2 className="mb-4 border-b border-line pb-2 text-xl font-semibold tracking-tight text-ink capitalize">
								{s.title}
							</h2>
						) : null}
						<div className="space-y-4 text-base leading-7 text-dim">
							{s.content}
						</div>
					</section>
				))}
			</main>
		</div>
	);
}
