"use client";

import { useMemo } from "react";
import { type HighlightLang, toHtml, useHighlighter } from "@/lib/highlighter";

/**
 * A real textarea with a shiki layer painted underneath: the textarea's
 * text is transparent (the caret stays visible), the highlighted copy
 * shows through. Both layers share font metrics and wrapping, so they
 * stay glyph-aligned; line numbers are css counters on the per-line
 * spans (see .code-lines in globals.css), so a wrapped line keeps one
 * number at its first row. The extra bottom padding leaves room for the
 * caret's trailing empty line.
 */
export function CodeEditor({
	value,
	onChange,
	onMetaEnter,
	lang,
	label,
	pad = "py-4 pr-4 pb-10",
	className = "",
}: {
	value: string;
	onChange: (next: string) => void;
	/** cmd/ctrl+enter inside the editor - the playground's run shortcut. */
	onMetaEnter?: () => void;
	lang: HighlightLang;
	label: string;
	pad?: string;
	className?: string;
}) {
	const highlighter = useHighlighter();
	const html = useMemo(
		() => (highlighter ? toHtml(highlighter, value, lang) : null),
		[highlighter, value, lang],
	);

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onMetaEnter) {
			e.preventDefault();
			onMetaEnter();
			return;
		}
		if (e.key !== "Tab") return;
		e.preventDefault();
		const el = e.currentTarget;
		el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
		onChange(el.value);
	};

	const layer = `${pad} pl-13 whitespace-pre-wrap break-words`;
	return (
		<div
			className={`code-editor cs-hl relative min-h-full font-mono text-[13px] leading-6 ${className}`}
		>
			{html !== null ? (
				<div
					aria-hidden
					className={`code-lines pointer-events-none select-none ${layer}`}
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre
					aria-hidden
					className={`code-lines pointer-events-none select-none text-ink ${layer}`}
				>
					{value.split("\n").map((lineText, i) => (
						<span key={i} className="line">
							{lineText}
							{"\n"}
						</span>
					))}
				</pre>
			)}
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={onKeyDown}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				aria-label={label}
				className={`absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-ink outline-none ${layer}`}
			/>
		</div>
	);
}
