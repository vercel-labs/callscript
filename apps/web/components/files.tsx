"use client";

import { useState } from "react";

/** A tiny file-type swatch, better-auth style: a solid square that
 * carries the tab's current text color. */
function Swatch({ active }: { active: boolean }) {
	return (
		<span
			aria-hidden
			className={`inline-block size-1.5 bg-current transition-opacity ${
				active ? "opacity-70" : "opacity-30"
			}`}
		/>
	);
}

/** An editor-like files view: one tab per file over a shared code
 * pane. Panels arrive pre-rendered (shiki runs on the server). */
export function Files({
	files,
}: {
	files: { name: string; panel: React.ReactNode }[];
}) {
	const [active, setActive] = useState(0);
	const single = files.length === 1;
	return (
		<div>
			<div className="flex items-center overflow-x-auto border-b border-line bg-raise text-[12px]">
				{files.map((f, i) =>
					single ? (
						<span
							key={f.name}
							className="flex items-center gap-2 px-3.5 py-2 text-faint"
						>
							<Swatch active />
							{f.name}
						</span>
					) : (
						<button
							key={f.name}
							type="button"
							onClick={() => setActive(i)}
							className={`flex items-center gap-2 whitespace-nowrap border-r border-line px-3.5 py-2 transition-colors duration-150 ${
								i === active
									? "bg-bg text-ink"
									: "text-faint hover:bg-ink/5 hover:text-dim"
							}`}
						>
							<Swatch active={i === active} />
							{f.name}
						</button>
					),
				)}
			</div>
			<div className="min-h-24 bg-bg">
				{files.map((f, i) => (
					<div key={f.name} className={i === active ? "" : "hidden"}>
						{f.panel}
					</div>
				))}
			</div>
		</div>
	);
}
