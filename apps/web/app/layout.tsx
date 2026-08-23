import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({
	subsets: ["latin"],
	variable: "--font-geist-mono",
});

export const metadata: Metadata = {
	title: "CallScript - Code Mode, without the sandbox",
	description:
		"The model writes JavaScript; callscript parses it into a JSON plan instead of executing it. Plans validate before they run, suspend and resume across processes, and keep intermediate results addressable. No sandbox, no separate runtime.",
	metadataBase: new URL("https://callscript.dev"),
	openGraph: {
		title: "CallScript - Code Mode, without the sandbox",
		description:
			"The model writes JavaScript; callscript parses it into a JSON plan instead of executing it. No sandbox, no separate runtime — the only thing the code can execute is your tools.",
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${geist.variable} ${geistMono.variable} dark`}>
			<body className="font-sans">{children}</body>
		</html>
	);
}
