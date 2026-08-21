"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "running" | "done";

interface Tick {
	at: number;
	step?: string;
	status?: Status;
	note?: string;
	log?: string;
	end?: boolean;
}

/** A canned run of the "close stale issues" plan: what the engine
 * actually does, played back on a timer. */
const TIMELINE: Tick[] = [
	{ at: 200, log: "validate ✓ 3 steps · worst-case 11 calls" },
	{
		at: 700,
		step: "issues",
		status: "running",
		log: 'issues → github.listIssues({ repo: "api" })',
	},
	{
		at: 1700,
		step: "issues",
		status: "done",
		note: "5 issues",
		log: "issues ✓ 5 issues",
	},
	{
		at: 1900,
		step: "stale",
		status: "running",
		log: "stale → issues.filter(i => i.stale)",
	},
	{
		at: 2200,
		step: "stale",
		status: "done",
		note: "2 stale",
		log: "stale ✓ 2 stale",
	},
	{
		at: 2500,
		step: "closed",
		status: "running",
		log: "closed → each: 2 calls, concurrent (max 10)",
	},
	{ at: 2600, log: "  → github.closeIssue({ number: 42 })" },
	{ at: 2700, log: "  → github.closeIssue({ number: 57 })" },
	{ at: 3500, log: "  ✓ #42 closed" },
	{
		at: 3700,
		step: "closed",
		status: "done",
		note: "2 closed",
		log: "  ✓ #57 closed",
	},
	{ at: 4100, log: "output ✓ { closed: [42, 57] }", end: true },
];

const STEPS = [
	{ id: "issues", kind: "call", detail: "github.listIssues" },
	{ id: "stale", kind: "let", detail: "issues.filter(i => i.stale)" },
	{ id: "closed", kind: "each", detail: "github.closeIssue × stale" },
] as const;

export function Simulator() {
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [log, setLog] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const [finished, setFinished] = useState(false);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	const clear = () => {
		for (const t of timers.current) clearTimeout(t);
		timers.current = [];
	};

	const run = useCallback(() => {
		clear();
		setStatuses({});
		setNotes({});
		setLog([]);
		setFinished(false);
		setRunning(true);
		for (const tick of TIMELINE) {
			timers.current.push(
				setTimeout(() => {
					if (tick.step && tick.status) {
						const { step, status } = tick;
						setStatuses((s) => ({ ...s, [step]: status }));
					}
					if (tick.step && tick.note) {
						const { step, note } = tick;
						setNotes((n) => ({ ...n, [step]: note }));
					}
					if (tick.log) {
						const { log: line } = tick;
						setLog((l) => [...l, line]);
					}
					if (tick.end) {
						setRunning(false);
						setFinished(true);
					}
				}, tick.at),
			);
		}
	}, []);

	// auto-play once shortly after mount
	useEffect(() => {
		const t = setTimeout(run, 600);
		return () => {
			clearTimeout(t);
			clear();
		};
	}, [run]);

	return (
		<div className="flex h-full flex-col border border-line bg-bg">
			<div className="flex items-center justify-between border-b border-line px-4 py-2.5">
				<span className="text-[13px] font-medium text-ink">runtime</span>
				<button
					type="button"
					onClick={run}
					disabled={running}
					className="border border-line px-2.5 py-1 text-[12px] text-dim transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-50"
				>
					{finished ? "replay" : "run"}
				</button>
			</div>

			{/* steps */}
			<div className="space-y-1 border-b border-line px-4 py-3">
				{STEPS.map((s) => {
					const st = statuses[s.id] ?? "idle";
					return (
						<div
							key={s.id}
							className="flex items-center gap-3 py-1 font-mono text-[12.5px]"
						>
							<span
								aria-hidden
								className={`inline-block size-2 shrink-0 rounded-full transition-colors ${
									st === "done"
										? "bg-ink"
										: st === "running"
											? "animate-pulse bg-ink/70"
											: "border border-faint/60"
								}`}
							/>
							<span className={st === "idle" ? "text-faint" : "text-ink"}>
								{s.id}
							</span>
							<span className="truncate text-faint">{s.detail}</span>
							<span className="ml-auto shrink-0 text-dim">
								{notes[s.id] ?? ""}
							</span>
						</div>
					);
				})}
			</div>

			{/* log */}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-6 text-dim">
				{log.length === 0 ? (
					<span className="text-faint">· waiting</span>
				) : (
					log.map((line, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only log
							key={i}
							className={line.startsWith("output") ? "text-ink" : ""}
						>
							{line}
						</div>
					))
				)}
			</div>
		</div>
	);
}
