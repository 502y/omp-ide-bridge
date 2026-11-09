/**
 * OMP IDE Bridge protocol v1 — shared types & URI helpers (client side).
 * Contract: ../../docs/protocol.md
 */

import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { domainToUnicode } from "node:url";

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
	const pathWithForwardSlashes = absolutePath.replaceAll("\\", "/");
	// UNC keeps its authority: \\server\share\a.ts -> file://server/share/a.ts.
	if (pathWithForwardSlashes.startsWith("//")) {
		return `file:${pathWithForwardSlashes
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`;
	}
	const encodedPath = pathWithForwardSlashes
		.split("/")
		.filter((pathSegment) => pathSegment.length > 0)
		.map((pathSegment, index) =>
			index === 0
				? encodeURIComponent(pathSegment).replace("%3A", ":").replaceAll("~", "%7E")
				: encodeURIComponent(pathSegment).replaceAll("~", "%7E"),
		)
		.join("/");
	if (process.platform !== "win32" && !win32.isAbsolute(absolutePath)) {
		return `file:///${encodedPath}`;
	}
	return `file:///${encodedPath}`;
}

export function uriToPath(uri: string): string {
	if (!uri.startsWith("file:")) return uri;
	const url = new URL(uri);
	// Bun 1.3 ignores fileURLToPath's `windows` option. Decode the URI
	// directly so IDE path semantics never depend on the OMP host OS.
	const drive = /^\/[A-Za-z](?::|%3a)\//i.test(url.pathname);
	const windows = url.hostname !== "" || drive;
	if (/%2f/i.test(url.pathname) || (windows && /%5c/i.test(url.pathname))) {
		throw new TypeError("File URL path must not include encoded path separators");
	}
	const decodedPath = decodeURIComponent(url.pathname);
	const path = url.hostname !== ""
		? `//${domainToUnicode(url.hostname)}${decodedPath}`
		: drive ? decodedPath.slice(1) : decodedPath;
	return windows && process.platform === "win32" ? path.replaceAll("/", "\\") : path;
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
