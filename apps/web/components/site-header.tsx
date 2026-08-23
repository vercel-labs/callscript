import Link from "next/link";

/** Vercel triangle mark. */
function VercelMark({ size = 18 }: { size?: number }) {
	return (
		<svg
			height={size}
			width={size}
			viewBox="0 0 16 16"
			strokeLinejoin="round"
			aria-hidden="true"
			className="shrink-0"
		>
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d="M8 1L16 15H0L8 1Z"
				fill="currentColor"
			/>
		</svg>
	);
}

/** Vercel Labs header: sticky, blurred page background, the triangle
 * linking to vercel.com, a slash divider, and the project wordmark. */
export function SiteHeader({
	github,
	active,
}: {
	github: string;
	active: "readme" | "playground";
}) {
	const link = (href: string, label: "readme" | "playground") => (
		<Link
			href={href}
			aria-current={active === label ? "page" : undefined}
			className={
				active === label
					? "text-ink"
					: "text-dim transition-colors hover:text-ink"
			}
		>
			{label === "readme" ? "Readme" : "Playground"}
		</Link>
	);

	return (
		<header className="sticky top-0 z-50 bg-bg/90 backdrop-blur-sm">
			<nav className="flex h-14 items-center justify-between px-4 sm:px-6">
				<div className="flex items-center gap-2">
					<a
						title="Made with love by Vercel"
						href="https://vercel.com"
						className="text-ink"
					>
						<VercelMark />
					</a>
					<span aria-hidden className="text-line">
						<svg
							height="16"
							width="16"
							viewBox="0 0 16 16"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path
								fillRule="evenodd"
								clipRule="evenodd"
								d="M4.01526 15.3939L4.3107 14.7046L10.3107 0.704556L10.6061 0.0151978L11.9849 0.606077L11.6894 1.29544L5.68942 15.2954L5.39398 15.9848L4.01526 15.3939Z"
								fill="currentColor"
							/>
						</svg>
					</span>
					<Link
						href="/"
						aria-label="CallScript home"
						className="font-mono text-lg font-medium tracking-tight text-ink"
					>
						CallScript
					</Link>
				</div>
				<div className="flex items-center gap-4 text-sm">
					{link("/", "readme")}
					{link("/playground", "playground")}
					<a
						href={github}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1.5 text-dim transition-colors hover:text-ink"
					>
						<svg
							viewBox="0 0 16 16"
							width="16"
							height="16"
							fill="currentColor"
							aria-hidden="true"
						>
							<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
						</svg>
						<span className="hidden sm:inline">GitHub</span>
					</a>
				</div>
			</nav>
		</header>
	);
}
