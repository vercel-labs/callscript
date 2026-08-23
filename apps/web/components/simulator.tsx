"use client";

import { useEffect, useRef, useState } from "react";

/** One prompt, three approaches, told in sequence for a reader who has
 * never seen tool calling. Each card animates after the previous one
 * finishes. Representative numbers; the playground measures live runs. */

type Kind = "call" | "result" | "pause" | "ok";

interface Tick {
	at: number; // ms into this lane's playback
	kind: Kind;
	text: string;
	tokens?: number;
}

const STYLE: Record<Kind, string> = {
	call: "text-ink",
	result: "text-faint",
	pause: "text-dim",
	ok: "text-ink",
};

interface Lane {
	label: string;
	caption: string;
	/** wall-clock seconds the run would really take */
	secs: number;
	ticks: Tick[];
	tinted?: boolean;
}

const LANES: Lane[] = [
	{
		label: "tool calling",
		caption:
			"How agents normally work: the model can't touch your systems itself, so it asks your app to run one tool, reads the result, and only then decides the next call. Every step is a full trip through the model, and the whole conversation rides along each time.",
		secs: 11.9,
		ticks: [
			{
				at: 300,
				kind: "call",
				text: 'model asks: run listIssues("api")',
				tokens: 1300,
			},
			{
				at: 1000,
				kind: "result",
				text: "← 5 issues, sent back for the model to read",
			},
			{
				at: 1700,
				kind: "call",
				text: "model asks: run closeIssue(#42)",
				tokens: 2900,
			},
			{
				at: 2400,
				kind: "pause",
				text: "⏸ needs your approval - everything waits",
			},
			{
				at: 3200,
				kind: "pause",
				text: "approved… model re-reads the whole exchange",
				tokens: 3700,
			},
			{
				at: 3900,
				kind: "call",
				text: "model asks: closeIssue(#57), then post to #eng",
				tokens: 6400,
			},
			{
				at: 4600,
				kind: "ok",
				text: "✓ done, after 6 trips through the model",
				tokens: 2100,
			},
		],
	},
	{
		label: "code mode",
		caption:
			"Code Mode's fix: let the model write one small program that makes all the calls itself. One trip through the model instead of six - but the program is AI-written code, so it has to run inside a locked-down sandbox.",
		secs: 8.9,
		ticks: [
			{ at: 300, kind: "call", text: "model writes one program", tokens: 1600 },
			{
				at: 1000,
				kind: "result",
				text: "sandbox starts, program runs the calls itself",
			},
			{ at: 1700, kind: "result", text: "found 5 issues, 2 stale" },
			{ at: 2400, kind: "pause", text: "⏸ closeIssue(#42) needs approval" },
			{
				at: 3100,
				kind: "pause",
				text: "running code can't pause: re-run it all later",
			},
			{ at: 3900, kind: "ok", text: "✓ done · results read out of the logs" },
		],
	},
	{
		label: "callscript",
		caption:
			"CallScript keeps the one-program idea but never runs the code: the script becomes a plan - plain data. No sandbox to operate, and a plan can stop, be saved anywhere, and pick up where it left off.",
		secs: 4.3,
		tinted: true,
		ticks: [
			{
				at: 300,
				kind: "call",
				text: "model writes one script → becomes a plan",
				tokens: 1500,
			},
			{
				at: 1000,
				kind: "result",
				text: "plan checked whole before anything runs",
			},
			{ at: 1700, kind: "result", text: "found 5 issues, 2 stale" },
			{
				at: 2400,
				kind: "pause",
				text: "⏸ closeIssue(#42) needs approval - plan pauses",
			},
			{
				at: 3100,
				kind: "pause",
				text: "saved as data… resumes with earlier results kept",
			},
			{
				at: 3900,
				kind: "call",
				text: "closes both, posts to #eng - in parallel",
			},
			{
				at: 4600,
				kind: "ok",
				text: "✓ done · every step's result still readable",
			},
		],
	},
];

/** each lane starts when the previous one ends */
const laneDelay = (index: number) =>
	LANES.slice(0, index).reduce(
		(sum, lane) => sum + lane.ticks[lane.ticks.length - 1].at + 400,
		0,
	);

function useLane(runId: number, playing: boolean, lane: Lane, delay: number) {
	const [lines, setLines] = useState<Tick[]>([]);
	const [tokens, setTokens] = useState(0);
	const [secs, setSecs] = useState(0);
	const realTotal = lane.ticks[lane.ticks.length - 1].at;

	useEffect(() => {
		if (!playing) return;
		setLines([]);
		setTokens(0);
		setSecs(0);
		const timers = lane.ticks.map((t) =>
			setTimeout(() => {
				setLines((l) => [...l, t]);
				const spent = t.tokens ?? 0;
				if (spent) setTokens((v) => v + spent);
			}, delay + t.at),
		);
		const start = Date.now();
		const interval = setInterval(() => {
			const elapsed = Date.now() - start - delay;
			if (elapsed < 0) return;
			// playback is compressed; the clock shows the real run's seconds
			setSecs(Math.min((elapsed / realTotal) * lane.secs, lane.secs));
			if (elapsed >= realTotal) clearInterval(interval);
		}, 100);
		return () => {
			for (const t of timers) clearTimeout(t);
			clearInterval(interval);
		};
	}, [runId, playing, lane, delay, realTotal]);

	return { lines, tokens, secs, done: secs >= lane.secs };
}

function LaneCard({
	lane,
	index,
	runId,
	playing,
}: {
	lane: Lane;
	index: number;
	runId: number;
	playing: boolean;
}) {
	const { lines, tokens, secs } = useLane(
		runId,
		playing,
		lane,
		laneDelay(index),
	);
	const started = lines.length > 0;
	return (
		<div>
			<p className="mb-1.5 text-sm font-medium text-ink">
				{index + 1}. {lane.label}
			</p>
			<p className="mb-2.5 max-w-[65ch] text-[13.5px] leading-6 text-dim">
				{lane.caption}
			</p>
			<div
				className={`rounded-lg border border-line ${
					lane.tinted ? "bg-raise/60" : "bg-bg"
				}`}
			>
				<div className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-2">
					<span className="font-mono text-[11px] text-faint">
						{started ? "running…" : "waiting"}
					</span>
					<span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">
						{tokens === 0 ? "0" : `${(tokens / 1000).toFixed(1)}k`} tokens ·{" "}
						{secs.toFixed(1)}s
					</span>
				</div>
				<div className="h-44 overflow-hidden px-4 py-3 font-mono text-[12px] leading-6">
					{lines.map((t) => (
						<div key={t.at} className={`truncate ${STYLE[t.kind]}`}>
							{t.text}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

export function Compare() {
	const [playing, setPlaying] = useState(false);
	const [runId, setRunId] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);

	// start once, when the widget scrolls into view
	useEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setPlaying(true);
					observer.disconnect();
				}
			},
			{ threshold: 0.15 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div ref={rootRef} className="space-y-7">
			<div>
				<p className="mb-2 text-sm text-faint">the same request, three ways:</p>
				<div className="rounded-lg border border-line bg-bg px-4 py-3 font-mono text-[12.5px] text-ink">
					<div>
						<span className="text-faint">›</span> Close all stale issues and
						notify the team in the #eng channel
					</div>
					<div className="mt-1 text-[11.5px] text-faint">
						policy: closing an issue requires human approval
					</div>
				</div>
			</div>
			{LANES.map((lane, i) => (
				<LaneCard
					key={lane.label}
					lane={lane}
					index={i}
					runId={runId}
					playing={playing}
				/>
			))}
			<button
				type="button"
				onClick={() => setRunId((n) => n + 1)}
				className="text-[11px] text-faint transition-colors hover:text-ink"
			>
				replay
			</button>
		</div>
	);
}
