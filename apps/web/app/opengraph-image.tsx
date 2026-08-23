import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "CallScript - Code Mode, without the sandbox";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
	const [geist, geistMono] = await Promise.all([
		readFile(join(process.cwd(), "assets/Geist-Medium.ttf")),
		readFile(join(process.cwd(), "assets/GeistMono-Regular.ttf")),
	]);
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				background: "#0a0a0a",
				border: "1px solid #262626",
				padding: "64px 72px",
				fontFamily: "Geist",
			}}
		>
			<div
				style={{
					fontFamily: "Geist Mono",
					fontSize: 24,
					color: "#737373",
				}}
			>
				callscript.dev
			</div>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					marginTop: "auto",
					marginBottom: "auto",
				}}
			>
				<div style={{ fontSize: 96, color: "#f5f5f5", letterSpacing: -3 }}>
					CallScript
				</div>
				<div style={{ fontSize: 40, color: "#a3a3a3", marginTop: 12 }}>
					Code Mode, without the sandbox.
				</div>
			</div>
		</div>,
		{
			...size,
			fonts: [
				{ name: "Geist", data: geist, weight: 500 },
				{ name: "Geist Mono", data: geistMono, weight: 400 },
			],
		},
	);
}
