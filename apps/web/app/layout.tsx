import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const jetbrainsMono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
	title: "callscript - Code Mode, without the sandbox",
	description:
		"The model writes JavaScript - and it never runs. Compiled to one validated, bounded, inert JSON plan; the only things that can execute are the tools you mounted.",
	metadataBase: new URL("https://callscript.dev"),
	openGraph: {
		title: "callscript - Code Mode, without the sandbox",
		description:
			"The model writes JavaScript - and it never runs. Plain JS in, one validated, bounded, inert plan out; only mounted tools execute.",
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${geist.variable} ${jetbrainsMono.variable} dark`}>
			<body className="font-sans">{children}</body>
		</html>
	);
}
