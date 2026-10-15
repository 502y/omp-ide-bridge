import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve, win32 } from "node:path";
import type { OmpIdeBridge } from "./core";
import { uriToPath } from "./protocol";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Snapshot {
	text: string;
	exists: boolean;
}

interface PendingEdit {
	cwd: string;
	generation: number;
	allowDetails: boolean;
	snapshots: Promise<Map<string, Snapshot | null>>;
}

function localPath(value: unknown, cwd: string): string | null {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		return null;
	}
	try {
		let path = value;
		const header = /^\[(.*)#[0-9a-f]{4}\]$/i.exec(path);
		if (header?.[1] !== undefined) {
			path = unquote(header[1]);
		}
		if (path.startsWith("file:")) {
			return uriToPath(path);
		}
		if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !win32.isAbsolute(path)) {
			return null;
		}
		if (path === "~" || path.startsWith("~/")) {
			return resolve(homedir(), path.slice(2));
		}
		return resolve(cwd, path);
	} catch {
		return null;
	}
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const first = trimmed[0];
	return trimmed.length >= 2 && (first === '"' || first === "'") && trimmed.at(-1) === first
		? trimmed.slice(1, -1)
		: trimmed;
}

function inputPaths(input: Record<string, unknown>): unknown[] {
	const paths: unknown[] = [input.path];
	if (Array.isArray(input.paths)) {
		paths.push(...input.paths);
	}
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (typeof edit === "object" && edit !== null && "rename" in edit) {
				paths.push(edit.rename);
			}
		}
	}
	const patch = typeof input.input === "string" ? input.input : input._input;
	if (typeof patch !== "string") {
		return paths;
	}
	// Odczytujemy tylko cele operacji; nie odtwarzamy tresci z proponowanego patcha.
	for (const rawLine of patch.replace(/^\uFEFF/, "").split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const header = /^\[(.*)#[0-9a-f]{4}\]$/i.exec(line);
		const legacyHeader = /^\s*¶+\s*(.*?)(?:#[0-9a-f]{4})?$/i.exec(line);
		const applyPath = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
		const move = /^MV\s+(.+)$/.exec(line);
		const target = header?.[1] ?? legacyHeader?.[1] ?? applyPath?.[1] ?? move?.[1];
		if (target !== undefined) {
			paths.push(unquote(target));
		}
	}
	return paths;
}

async function readSnapshot(path: string): Promise<Snapshot | null> {
	let file: FileHandle | undefined;
	try {
		// NONBLOCK zapobiega zatrzymaniu OMP dla FIFO i innych plikow specjalnych.
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) {
			return null;
		}
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
			if (bytesRead === 0) {
				break;
			}
			length += bytesRead;
		}
		if (length > info.size) {
			return null;
		}
		const text = utf8.decode(bytes.subarray(0, length));
		if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) {
			return null;
		}
		return { text, exists: true };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { text: "", exists: false } : null;
	} finally {
		await file?.close().catch(() => {});
	}
}

export class AutoDiff {
	private pending = new Map<string, PendingEdit>();
	private generation = 0;

	constructor(private readonly bridge: OmpIdeBridge) {}

	clear(): void {
		this.generation += 1;
		this.pending.clear();
	}

	async beforeTool(event: ToolCallEvent, cwd: string): Promise<void> {
		if (!this.bridge.supportsShowDiff || (event.toolName !== "edit" && event.toolName !== "write")) {
			return;
		}
		const paths = new Set<string>();
		const values = event.toolName === "write" ? [event.input.path] : inputPaths(event.input);
		let allowDetails = true;
		for (const value of values) {
			const path = localPath(value, cwd);
			if (path !== null) {
				paths.add(path);
			} else if (typeof value === "string") {
				allowDetails = false;
			}
		}
		if (paths.size === 0) {
			return;
		}
		const snapshots = Promise.all([...paths].map(async (path) => [path, await readSnapshot(path)] as const))
			.then((entries) => new Map(entries));
		this.pending.set(event.toolCallId, { cwd, generation: this.generation, allowDetails, snapshots });
		await snapshots;
	}

	async afterTool(event: ToolResultEvent): Promise<void> {
		const pending = this.pending.get(event.toolCallId);
		this.pending.delete(event.toolCallId);
		if (!pending || !this.bridge.supportsShowDiff) {
			return;
		}
		const snapshots = await pending.snapshots;
		const details = event.toolName === "edit" && typeof event.details === "object" && event.details !== null
			? event.details as Record<string, unknown>
			: null;
		const results: unknown[] = Array.isArray(details?.perFileResults) ? details.perFileResults : [details];
		const seenDetails = new Set<string>();
		for (const result of results) {
			if (typeof result !== "object" || result === null) {
				continue;
			}
			const entry = result as Record<string, unknown>;
			const path = localPath(entry.sourcePath ?? entry.path, pending.cwd);
			const destination = localPath(entry.move ?? entry.path, pending.cwd);
			// Migawka OMP pochodzi z wykonanej operacji, takze przy rownoleglych wywolaniach.
			if (path !== null && !seenDetails.has(path) && typeof entry.oldText === "string") {
				if (snapshots.get(path) !== null && (pending.allowDetails || snapshots.has(path)) &&
					Buffer.byteLength(entry.oldText, "utf8") <= MAX_SNAPSHOT_BYTES &&
					!/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(entry.oldText)) {
					snapshots.set(path, { text: entry.oldText, exists: entry.op !== "create" });
				}
				seenDetails.add(path);
			}
			if (pending.allowDetails && path !== null && !snapshots.has(path) && entry.op === "create") {
				snapshots.set(path, { text: "", exists: false });
			}
			if (destination !== null && destination !== path && !snapshots.has(destination)) {
				// Bez migawki sprzed przeniesienia nie zgadujemy zawartosci celu.
				snapshots.set(destination, null);
			}
		}
		const changed = await Promise.all([...snapshots].map(async ([path, before]) => {
			if (before === null) {
				return null;
			}
			const after = await readSnapshot(path);
			return after !== null && (before.text !== after.text || before.exists !== after.exists)
				? { path, before, after }
				: null;
		}));
		if (pending.generation !== this.generation || !this.bridge.supportsShowDiff) {
			return;
		}
		for (const change of changed) {
			if (change === null) {
				continue;
			}
			const { path, before, after } = change;
			const label = !before.exists ? "nowy plik" : !after.exists ? "usunięty plik" : "zmiany";
			// Nie czekamy na IDE ani decyzje uzytkownika i nie zmieniamy wyniku narzedzia.
			void this.bridge.showDiff(
				path, before.text, after.text, before.exists, after.exists, `OMP: ${basename(path)} (${label})`,
			).catch(() => {});
		}
	}
}
