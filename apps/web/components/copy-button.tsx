"use client";

import { useState } from "react";

/** Hover-revealed copy control for code blocks: hidden until the
 * enclosing `group` is hovered (or the button itself is focused). */
export function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};
	return (
		<button
			type="button"
			onClick={copy}
			aria-label="copy code"
			className={`absolute top-2.5 right-2.5 rounded-md border border-line bg-raise p-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 ${
				copied ? "text-ink" : "text-faint hover:text-ink"
			}`}
		>
			{copied ? (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			) : (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
					<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
				</svg>
			)}
		</button>
	);
}
