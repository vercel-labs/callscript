"use client";

import { useState } from "react";

/** Basic markdown-style tabs: a row of plain labels over a hairline,
 * the active one underlined in ink, the panel below. */
export function Tabs({
	tabs,
}: {
	tabs: { label: string; icon?: React.ReactNode; panel: React.ReactNode }[];
}) {
	const [active, setActive] = useState(0);
	return (
		<div>
			<div className="flex border-b border-line text-sm">
				{tabs.map((t, i) => (
					<button
						key={t.label}
						type="button"
						onClick={() => setActive(i)}
						className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2 transition-colors ${
							i === active
								? "border-ink bg-raise font-medium text-ink"
								: "border-transparent text-dim hover:bg-raise hover:text-ink"
						}`}
					>
						{t.icon}
						{t.label}
					</button>
				))}
			</div>
			<div className="mt-3">
				{tabs.map((t, i) => (
					<div key={t.label} className={i === active ? "" : "hidden"}>
						{t.panel}
					</div>
				))}
			</div>
		</div>
	);
}
