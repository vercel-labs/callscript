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
		"A tool-calling script language for LLMs: the model writes plain JavaScript, compiled to one validated, bounded, inert plan - never executed as code.",
	metadataBase: new URL("https://callscript.dev"),
	openGraph: {
		title: "callscript - Code Mode, without the sandbox",
		description:
			"A tool-calling script language for LLMs: plain JS in, one validated, bounded, inert plan out - never executed as code.",
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
