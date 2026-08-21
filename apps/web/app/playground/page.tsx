import type { Metadata } from "next";
import { Playground } from "@/components/playground";
import { SiteHeader } from "@/components/site-header";

const GITHUB = "https://github.com/better-auth/callscript";

export const metadata: Metadata = {
	title: "callscript playground",
	description:
		"Write a callscript and run it against the real engine, in your browser: demo tools mounted, plans validated before anything fires.",
};

export default function PlaygroundPage() {
	return (
		<div className="readme-bg flex h-dvh flex-col overflow-hidden">
			<SiteHeader github={GITHUB} active="playground" />
			<main className="mx-auto flex w-full min-h-0 max-w-[1400px] flex-1 flex-col px-6 py-6 sm:px-10">
				<h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
					Playground
				</h1>
				<div className="mt-6 min-h-0 flex-1">
					<Playground />
				</div>
			</main>
		</div>
	);
}
