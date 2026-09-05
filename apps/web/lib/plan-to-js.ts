import type { CallStep, Script, Step } from "callscript";

/** True when a key is safe to write bare as an object-literal key. Reserved
 * words are fine as property names, so only identifier grammar is checked. */
const isIdentifierKey = (key: string): boolean =>
	/^[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*$/u.test(key);

/** Render stored call args back to JS source: "=expr" strings become
 * bare expressions, "==lit" unescapes to the literal string. */
function argsToJs(value: unknown): string {
	if (typeof value === "string") {
		if (value.startsWith("==")) return JSON.stringify(value.slice(1));
		if (value.startsWith("=")) return value.slice(1);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => argsToJs(v)).join(", ")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).map(
			([k, v]) =>
				`${isIdentifierKey(k) ? k : JSON.stringify(k)}: ${argsToJs(v)}`,
		);
		return `{ ${entries.join(", ")} }`;
	}
	return JSON.stringify(value);
}

const OPT_KEYS = ["reason", "onError", "suspend", "max"] as const;

function optsToJs(step: CallStep): string {
	const parts: string[] = [];
	for (const key of OPT_KEYS) {
		const value = step[key];
		if (value !== undefined) parts.push(`${key}: ${JSON.stringify(value)}`);
	}
	return parts.length > 0 ? `, { ${parts.join(", ")} }` : "";
}

function stepLine(step: Step, inCondBlock: boolean): string {
	if ("return" in step && step.return !== undefined) {
		// inside a block opened by this step's own condition the guard is
		// just the return; without a condition the value gates truthily
		if (step.if !== undefined && inCondBlock) {
			return `return ${step.return};`;
		}
		if (step.if !== undefined) {
			return `if (${step.if}) return ${step.return};`;
		}
		return `if (${step.return}) return ${step.return};`;
	}
	if ("call" in step && step.call !== undefined) {
		if (step.each !== undefined) {
			return `const ${step.id} = await Promise.all((${step.each}).map((_args) => ${step.call}(_args${optsToJs(step)})));`;
		}
		const args = step.args === undefined ? "" : argsToJs(step.args);
		const prefix = step.await === false ? "" : "await ";
		const detached =
			step.await === false
				? ` // fire-and-forget; a later script joins it: await ${step.id}`
				: "";
		return `const ${step.id} = ${prefix}${step.call}(${args}${optsToJs(step)});${detached}`;
	}
	if ("let" in step && step.let !== undefined) {
		return `const ${step.id} = ${step.let};`;
	}
	return `// ? ${JSON.stringify(step)}`;
}

/** Render an inert JSON plan back to its JS surface - the readable form
 * of what the engine stores and executes. */
export function planToJs(script: Script): string {
	const lines: string[] = [];
	if (script.intent) lines.push(`// ${script.intent}`);
	let openCond: string | undefined;
	let depth = 0;
	const pad = () => "\t".repeat(depth);
	for (const step of script.steps) {
		const cond = step.if;
		if (cond !== openCond) {
			if (openCond !== undefined) {
				depth -= 1;
				lines.push(`${pad()}}`);
				openCond = undefined;
			}
			if (cond !== undefined) {
				lines.push(`${pad()}if (${cond}) {`);
				depth += 1;
				openCond = cond;
			}
		}
		lines.push(pad() + stepLine(step, openCond !== undefined));
	}
	if (openCond !== undefined) {
		depth -= 1;
		lines.push(`${pad()}}`);
	}
	if (script.output !== undefined) {
		if (lines.length > 0) lines.push("");
		lines.push(`return ${script.output};`);
	}
	return lines.join("\n");
}
