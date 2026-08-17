/**
 * OMP IDE Bridge protocol v1 — shared types & URI helpers (client side).
 * Contract: ../../docs/protocol.md
 */

import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Position {
	line: number;
	character: number;
}
export interface Range {
	start: Position;
	end: Position;
}
export interface Selection {
	uri: string;
	start: Position;
	end: Position;
	text: string;
}
export interface Editor {
	uri: string;
	isActive: boolean;
}
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";
export interface Diagnostic {
	uri: string;
	range: Range;
	severity: DiagnosticSeverity;
	message: string;
	source: string | null;
}
export interface IdeCapabilities {
	openDiff: boolean;
	diagnostics: boolean;
	executeCode: boolean;
}
export interface InitializeResult {
	ideName: string;
	ideVersion: string;
	protocolVersion: number;
	capabilities: IdeCapabilities;
}
export interface LockFile {
	pid: number;
	workspaceFolders: string[];
	ideName: string;
	transport: "ws";
	runningInWindows: boolean;
	authToken: string;
}
export interface AtMention {
	selection: Selection | null;
	text: string;
}

/** JSON-RPC 2.0 error codes used by the protocol. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const PROTOCOL_VERSION = 1;

export function pathToUri(absolutePath: string): string {
	if (process.platform !== "win32" && win32.isAbsolute(absolutePath)) {
		const windowsPathWithForwardSlashes = absolutePath.replaceAll("\\", "/");
		return `file:///${windowsPathWithForwardSlashes
			.split("/")
			.map((pathSegment, index) =>
				index === 0
					? encodeURIComponent(pathSegment).replace("%3A", ":")
					: encodeURIComponent(pathSegment),
			)
			.join("/")}`;
	}
	// Bun's POSIX pathToFileURL treats backslashes as ordinary characters;
	// normalize separators before asking it to serialize an absolute path.
	return pathToFileURL(absolutePath.replaceAll("\\", sep)).href;
}

export function uriToPath(uri: string): string {
	if (!uri.startsWith("file:")) return uri;
	const decodedPath = fileURLToPath(uri);
	// Bun's POSIX fileURLToPath returns `//...` for RFC 3986 URIs with an empty
	// authority (file:///tmp/a). Collapse the implementation artifact back to
	// one slash; a real UNC URI (file://server/share) has a non-empty authority
	// and never reaches this branch.
	if (decodedPath.startsWith("//")) return decodedPath.slice(1);
	// Bun's POSIX fileURLToPath also treats `file:///Z:/...` as POSIX and
	// leaves `/Z:/...`. Windows drive URIs produced by an IDE must decode to
	// a native Windows path even when the OMP runtime is POSIX.
	if (process.platform !== "win32" && /^\/[A-Za-z]:\//.test(decodedPath)) {
		return decodedPath.slice(1);
	}
	return decodedPath;
}

/** True when `child` is `parent` itself or lives under it (segment boundary). */
export function pathContains(parentPath: string, childPath: string): boolean {
	const compareCaseInsensitively =
		process.platform === "win32" || process.platform === "darwin";
	const resolvedParentPath = resolve(parentPath);
	const resolvedChildPath = resolve(childPath);
	const comparisonParentPath = compareCaseInsensitively
		? resolvedParentPath.toLowerCase()
		: resolvedParentPath;
	const comparisonChildPath = compareCaseInsensitively
		? resolvedChildPath.toLowerCase()
		: resolvedChildPath;
	const relativeChildPath = relative(comparisonParentPath, comparisonChildPath);
	return (
		relativeChildPath === "" ||
		(relativeChildPath !== ".." &&
			!relativeChildPath.startsWith(`..${sep}`) &&
			!isAbsolute(relativeChildPath))
	);
}
