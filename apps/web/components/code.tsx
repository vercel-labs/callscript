import { codeToHtml } from "shiki";
import { CopyButton } from "./copy-button";

export async function Code({
	code,
	lang = "ts",
	title,
	bare = false,
}: {
	code: string;
	lang?: string;
	title?: string;
	bare?: boolean;
}) {
	const html = await codeToHtml(code.trim(), {
		lang,
		themes: { light: "github-light", dark: "vesper" },
		defaultColor: "light",
	});
	if (bare) {
		return (
			<div className="group relative">
				<div
					className="overflow-x-auto px-4 py-3.5"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: build-time shiki output
					dangerouslySetInnerHTML={{ __html: html }}
				/>
				<CopyButton text={code.trim()} />
			</div>
		);
	}
	return (
		<figure className="overflow-hidden rounded-lg border border-line bg-bg">
			{title ? (
				<figcaption className="flex items-center gap-2 border-b border-line bg-raise px-3.5 py-2 text-[12px] text-faint">
					<span
						aria-hidden
						className="inline-block size-1.5 bg-current opacity-40"
					/>
					<span>{title}</span>
				</figcaption>
			) : null}
			<div className="group relative">
				<div
					className="overflow-x-auto px-4 py-3.5"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: build-time shiki output
					dangerouslySetInnerHTML={{ __html: html }}
				/>
				<CopyButton text={code.trim()} />
			</div>
		</figure>
	);
}
