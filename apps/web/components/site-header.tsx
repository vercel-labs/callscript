import Link from "next/link";

/** The TypeScript-mark homage: a white rounded square with "CS" set
 * low and right of center, where the TS logo puts its letters. */
export function Logo({ size = 22 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 128 128"
			aria-hidden="true"
			className="shrink-0"
		>
			<rect width="128" height="128" rx="12" fill="#e8e8e8" />
			<text
				x="76"
				y="100"
				textAnchor="middle"
				fontFamily="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
				fontWeight="700"
				fontSize="62"
				fill="#0a0a0a"
			>
				CS
			</text>
		</svg>
	);
}

/** Minimal sticky nav shared by the readme and the playground: the logo on
 * the left, the page links and GitHub link on the right. */
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
					? "text-ink underline decoration-current decoration-2 underline-offset-4"
					: "text-dim transition-colors hover:text-ink"
			}
		>
			{label === "readme" ? "Readme" : "Playground"}
		</Link>
	);

	return (
		<header className="sticky top-0 z-20">
			<nav className="flex items-center justify-between px-6 py-3 sm:px-10">
				<Link
					href="/"
					aria-label="callscript home"
					className="-ml-4 inline-flex items-center transition-opacity hover:opacity-80"
				>
					<Logo />
				</Link>
				<div className="flex items-center gap-5 text-[13px]">
					{link("/", "readme")}
					{link("/playground", "playground")}
					<a
						href={github}
						className="text-dim transition-colors hover:text-ink"
					>
						Github
					</a>
				</div>
			</nav>
		</header>
	);
}
