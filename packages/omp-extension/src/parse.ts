/**
 * Runtime validators for values arriving over the wire (RPC boundary).
 * Every read of remote data goes through these — no inline casts.
 */

import type {
	Diagnostic,
	DiagnosticSeverity,
	Editor,
	InitializeResult,
	Position,
	Range,
	Selection,
} from "./protocol";

function isObj(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}

function num(x: unknown): number | null {
	return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function str(x: unknown): string | null {
	return typeof x === "string" ? x : null;
}

function position(x: unknown): Position | null {
	if (!isObj(x)) return null;
	const line = num(x.line);
	const character = num(x.character);
	return line !== null && character !== null ? { line, character } : null;
}

function range(x: unknown): Range | null {
	if (!isObj(x)) return null;
	const start = position(x.start);
	const end = position(x.end);
	return start && end ? { start, end } : null;
}

/** Parses a Selection; also accepts a bare `null`. */
export function selectionOrNull(x: unknown): Selection | null {
	if (x === null || x === undefined) return null;
	if (!isObj(x)) return null;
	const uri = str(x.uri);
	const start = position(x.start);
	const end = position(x.end);
	const text = str(x.text);
	return uri !== null && start && end && text !== null
		? { uri, start, end, text }
		: null;
}

export function editorList(x: unknown): Editor[] {
	if (!Array.isArray(x)) return [];
	const out: Editor[] = [];
	for (const item of x) {
		if (!isObj(item)) continue;
		const uri = str(item.uri);
		if (uri === null) continue;
		out.push({ uri, isActive: item.isActive === true });
	}
	return out;
}

const SEVERITIES: readonly DiagnosticSeverity[] = [
	"error",
	"warning",
	"information",
	"hint",
];

export function diagnosticList(x: unknown): Diagnostic[] {
	if (!Array.isArray(x)) return [];
	const out: Diagnostic[] = [];
	for (const item of x) {
		if (!isObj(item)) continue;
		const uri = str(item.uri);
		const r = range(item.range);
		const severity = str(item.severity);
		const message = str(item.message);
		const sev = SEVERITIES.find((s) => s === severity);
		if (uri === null || !r || sev === undefined || message === null) continue;
		out.push({ uri, range: r, severity: sev, message, source: str(item.source) });
	}
	return out;
}

export function stringList(x: unknown): string[] {
	return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

/** Envelope readers: unwrap `{field: ...}` RPC results. */
export function readField<T>(res: unknown, field: string, read: (x: unknown) => T): T {
	return read(isObj(res) ? res[field] : undefined);
}

/** Throws when the peer's initialize reply is malformed. */
export function initializeResult(x: unknown): InitializeResult {
	if (!isObj(x)) throw new Error("malformed initialize result");
	const ideName = str(x.ideName);
	const ideVersion = str(x.ideVersion);
	const protocolVersion = num(x.protocolVersion);
	if (ideName === null || ideVersion === null || protocolVersion === null) {
		throw new Error("malformed initialize result");
	}
	const caps = isObj(x.capabilities) ? x.capabilities : {};
	return {
		ideName,
		ideVersion,
		protocolVersion,
		capabilities: {
			openDiff: caps.openDiff === true,
			diagnostics: caps.diagnostics === true,
			executeCode: caps.executeCode === true,
		},
	};
}
