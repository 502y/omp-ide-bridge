/**
 * Renders the cached IDE state into the `<ide-context>` message injected
 * before each agent run. Format is normative (docs/protocol.md §6).
 */

import { relative, sep } from "node:path";
import { pathContains, uriToPath, type Diagnostic, type Editor, type Selection } from "./protocol";

export interface IdeSnapshot {
	ideName: string;
	editors: Editor[];
	selection: Selection | null;
	diagnostics: Diagnostic[];
}

const MAX_SELECTION_CHARS = 2000;
const MAX_TABS = 10;
const MAX_DIAGNOSTIC_ITEMS = 10;

const LANG_BY_EXT: Record<string, string> = {
	ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
	py: "py", java: "java", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust",
	c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
	rb: "ruby", php: "php", swift: "swift", md: "markdown", json: "json",
	yaml: "yaml", yml: "yaml", sh: "bash", zsh: "bash", sql: "sql",
	css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
	xml: "xml", toml: "toml",
};

function displayPath(uri: string, cwd: string): string {
	const nativePath = uriToPath(uri);
	const pathRelativeToCwd = relative(cwd, nativePath);
	const displayedPath =
		pathRelativeToCwd !== "" && pathContains(cwd, nativePath)
			? pathRelativeToCwd
			: nativePath;
	return sep === "\\" ? displayedPath.replaceAll("\\", "/") : displayedPath;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function langOf(uri: string): string {
	const ext = uriToPath(uri).split(".").pop()?.toLowerCase() ?? "";
	return LANG_BY_EXT[ext] ?? "";
}

/** Total width budget for the status entry; the line suffix is never truncated. */
const STATUS_WIDTH_BUDGET = 44;

/** Middle-truncate so both the directory head and the filename survive. */
function ellipsizeMiddle(path: string, budget: number): string {
	if (path.length <= budget || budget < 8) return path;
	const head = Math.ceil((budget - 1) / 2);
	const tail = budget - 1 - head;
	return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/**
 * One-line status for the TUI status bar, Claude-Code style:
 * ` src/foo.ts:12-34` for a range, ` src/foo.ts:7` for a caret/same-line
 * range. ANSI is stripped by the status sanitizer, so decoration is limited
 * to a Nerd Font file glyph + smart truncation.
 */
export function formatSelectionStatus(sel: Selection, cwd: string): string {
	const startLine = sel.start.line + 1;
	const endLine = sel.end.line + 1;
	const suffix = startLine === endLine ? `:${startLine}` : `:${startLine}-${endLine}`;
	const path = displayPath(sel.uri, cwd);
	const shown = ellipsizeMiddle(path, STATUS_WIDTH_BUDGET - 2 - suffix.length);
	// Nerd Font file glyph U+F15B as an escape: a literal PUA char does not
	// survive the edit toolchain (it arrives as a plain space).
	return `\u{F15B} ${shown}${suffix}`;
}

/** Null when there is nothing worth the model's attention. */
export function buildIdeContext(snap: IdeSnapshot, cwd: string): string | null {
	const sections: string[] = [];

	const active = snap.editors.find((e) => e.isActive) ?? null;
	const sel = snap.selection;

	if (sel) {
		const path = displayPath(sel.uri, cwd);
		const hasRange =
			sel.start.line !== sel.end.line || sel.start.character !== sel.end.character;
		sections.push(
			hasRange
				? `Active file: ${path} (selection lines ${sel.start.line + 1}-${sel.end.line + 1})`
				: `Active file: ${path} (cursor at line ${sel.start.line + 1})`,
		);
		if (sel.text.length > 0) {
			const lang = langOf(sel.uri);
			sections.push(
				`<selection${lang ? ` language="${lang}"` : ""}>\n${truncate(sel.text, MAX_SELECTION_CHARS)}\n</selection>`,
			);
		}
	} else if (active) {
		sections.push(`Active file: ${displayPath(active.uri, cwd)}`);
	}

	const tabs = snap.editors.map((e) => displayPath(e.uri, cwd));
	if (tabs.length > 0) {
		const shown = tabs.slice(0, MAX_TABS);
		const suffix = tabs.length > MAX_TABS ? ` (+${tabs.length - MAX_TABS} more)` : "";
		sections.push(`Open tabs: ${shown.join(", ")}${suffix}`);
	}

	if (snap.diagnostics.length > 0) {
		const counts: Partial<Record<Diagnostic["severity"], number>> = {};
		for (const d of snap.diagnostics) {
			counts[d.severity] = (counts[d.severity] ?? 0) + 1;
		}
		const order: Diagnostic["severity"][] = ["error", "warning", "information", "hint"];
		const summary = order
			.filter((s) => (counts[s] ?? 0) > 0)
			.map((s) => `${counts[s]} ${s}s`)
			.join(", ");
		const items = snap.diagnostics
			.slice(0, MAX_DIAGNOSTIC_ITEMS)
			.map(
				(d) =>
					`- ${displayPath(d.uri, cwd)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.severity} ${d.message}`,
			);
		const more =
			snap.diagnostics.length > MAX_DIAGNOSTIC_ITEMS
				? [`- … and ${snap.diagnostics.length - MAX_DIAGNOSTIC_ITEMS} more`]
				: [];
		sections.push([`Diagnostics: ${summary}`, ...items, ...more].join("\n"));
	}

	if (sections.length === 0) return null;
	return `<ide-context source="${snap.ideName}">\n${sections.join("\n")}\n</ide-context>`;
}
