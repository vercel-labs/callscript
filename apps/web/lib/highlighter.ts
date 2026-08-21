"use client";

import { useEffect, useState } from "react";
import type { HighlighterCore } from "shiki/core";

/** One shared client-side shiki instance: fine-grained core + the js
 * regex engine (no wasm), only the two themes/langs the site uses. */
let loading: Promise<HighlighterCore> | null = null;
let loaded: HighlighterCore | null = null;

function load(): Promise<HighlighterCore> {
	if (!loading) {
		loading = Promise.all([
			import("shiki/core"),
			import("shiki/engine/javascript"),
		]).then(([core, engine]) =>
			core
				.createHighlighterCore({
					themes: [
						import("shiki/dist/themes/github-light.mjs"),
						import("shiki/dist/themes/vesper.mjs"),
					],
					langs: [
						import("shiki/dist/langs/javascript.mjs"),
						import("shiki/dist/langs/json.mjs"),
					],
					engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
				})
				.then((h) => {
					loaded = h;
					return h;
				}),
		);
	}
	return loading;
}

/** Null until the highlighter is ready - render plain text meanwhile. */
export function useHighlighter(): HighlighterCore | null {
	const [highlighter, setHighlighter] = useState<HighlighterCore | null>(
		loaded,
	);
	useEffect(() => {
		if (highlighter) return;
		let live = true;
		load().then((h) => {
			if (live) setHighlighter(h);
		});
		return () => {
			live = false;
		};
	}, [highlighter]);
	return highlighter;
}

export type HighlightLang = "javascript" | "json";

export function toHtml(
	highlighter: HighlighterCore,
	code: string,
	lang: HighlightLang,
): string {
	return highlighter.codeToHtml(code, {
		lang,
		themes: { light: "github-light", dark: "vesper" },
		defaultColor: "light",
	});
}
