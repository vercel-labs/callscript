"use client";

import { useEffect, useState } from "react";

/** Left-rail table of contents: plain section links, the one whose
 * heading is on screen rendered in ink. Hidden on small screens by
 * the caller; highlighting is an IntersectionObserver on the section
 * elements themselves. */
export function Toc({ items }: { items: { id: string; title: string }[] }) {
	const [active, setActive] = useState(items[0]?.id);

	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries.find((e) => e.isIntersecting);
				if (visible) setActive(visible.target.id);
			},
			// a thin band below the sticky header decides the active section
			{ rootMargin: "-80px 0px -75% 0px" },
		);
		for (const { id } of items) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	}, [items]);

	return (
		<nav aria-label="On this page" className="text-sm">
			<p className="mb-3 font-medium text-faint">On this page</p>
			<ul className="space-y-2 border-l border-line">
				{items.map((item) => (
					<li key={item.id}>
						<a
							href={`#${item.id}`}
							className={`-ml-px block border-l pl-3 capitalize transition-colors ${
								active === item.id
									? "border-ink text-ink"
									: "border-transparent text-dim hover:text-ink"
							}`}
						>
							{item.title}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
