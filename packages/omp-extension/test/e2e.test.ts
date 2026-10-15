/**
 * E2E: OmpIdeBridge against a mock IDE server speaking protocol v1.
 * Also covers lockfile discovery rules and the context injection builder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { AutoDiff } from "../src/auto-diff";
import { BridgeClient } from "../src/bridge-client";
import { buildIdeContext, formatSelectionStatus, type IdeSnapshot } from "../src/context";
import { OmpIdeBridge } from "../src/core";
import { pickCandidate, scanCandidates } from "../src/lockfile";
import { pathContains, pathToUri, uriToPath, type AtMention, type Selection } from "../src/protocol";
import { MockIdeServer } from "./mock-ide-server";

const PROJ = join(tmpdir(), "omp-ide-test-project");
const A_TS = join(PROJ, "src", "a.ts");
const ELSEWHERE = join(tmpdir(), "omp-ide-test-elsewhere");

// Integration exception (ts-no-test-timers): these tests exercise real
// WebSocket I/O and the client's real reconnect backoff — fake timers cannot
// drive sockets, so we poll real conditions with a hard deadline instead of
// sleeping a guessed duration.
function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const deadline = Date.now() + timeoutMs;
	const tick = () => {
		if (cond()) return resolve();
		if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
		setTimeout(tick, 25);
	};
	tick();
	return promise;
}

interface Fixture {
	dir: string;
	token: string;
	mock: MockIdeServer;
	bridge: OmpIdeBridge;
	statuses: string[];
	mentions: AtMention[];
	liveSelections: Array<Selection | null>;
}

function writeLock(dir: string, port: number, token: string, pid = process.pid): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${port}.lock`),
		JSON.stringify({
			pid,
			workspaceFolders: [PROJ],
			ideName: "MockIDE",
			transport: "ws",
			runningInWindows: process.platform === "win32",
			authToken: token,
		}),
		{ mode: 0o600 },
	);
}

async function makeFixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "omp-ide-test-"));
	const token = randomUUID();
	const mock = new MockIdeServer(token);
	mock.folders = [pathToUri(PROJ)];
	mock.editors = [{ uri: pathToUri(A_TS), isActive: true }];
	await mock.start();
	writeLock(dir, mock.port, token);
	const statuses: string[] = [];
	const mentions: AtMention[] = [];
	const liveSelections: Array<Selection | null> = [];
	const bridge = new OmpIdeBridge(
		{
			onStatus: (s) => statuses.push(s),
			onAtMentioned: (m) => mentions.push(m),
			onSelectionStatus: (s) => liveSelections.push(s),
		},
		dir,
	);
	return { dir, token, mock, bridge, statuses, mentions, liveSelections };
}

describe("OmpIdeBridge e2e", () => {
	let fx: Fixture;

	beforeEach(async () => {
		delete process.env.OMP_IDE_PORT;
		fx = await makeFixture();
	});

	afterEach(async () => {
		fx.bridge.stop();
		await fx.mock.stop();
		rmSync(fx.dir, { recursive: true, force: true });
	});

	test("connects via lockfile and pulls initial state", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		expect(fx.bridge.ideName).toBe("MockIDE");
		expect(fx.mock.countCalls("initialize")).toBe(1);
		// initial state pull
		await waitFor(() => fx.mock.countCalls("getOpenEditors") >= 1);
		const st = fx.bridge.status();
		expect(st.connected).toBe(true);
		expect(st.candidates.length).toBe(1);
		expect(st.candidates[0]?.port).toBe(fx.mock.port);
	});

	test("rejects a wrong auth token with close 1008", async () => {
		const client = new BridgeClient(fx.mock.port, "wrong-token", {
			onSelectionChanged: () => {},
			onEditorsChanged: () => {},
			onDiagnosticsChanged: () => {},
			onWorkspaceChanged: () => {},
			onAtMentioned: () => {},
			onClose: () => {},
		});
		// The close frame races the handshake teardown: undici surfaces either
		// the protocol code (1008) or an abnormal closure (1006).
		await expect(client.connect()).rejects.toThrow(/1008|1006/);
	});

	test("rejects an unsupported protocol version", async () => {
		fx.mock.protocolVersion = 2;
		fx.bridge.start(PROJ);
		await waitFor(() => fx.mock.countCalls("initialize") >= 1);
		expect(fx.bridge.connected).toBe(false);
	});

	test("selection notification flows into the context injection, deduped", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		// initial pull yields one active-file injection; consume it, then dedupe
		expect(fx.bridge.getContextInjection()).toContain("Active file: src/a.ts");
		expect(fx.bridge.getContextInjection()).toBeNull();

		fx.mock.notify("selection_changed", {
			selection: {
				uri: pathToUri(A_TS),
				start: { line: 11, character: 0 },
				end: { line: 13, character: 5 },
				text: "const a = 1;\nconst b = 2;\nconst c = 3;",
			},
		});
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		// live status line event carries the same selection
		expect(fx.liveSelections.at(-1)?.text).toContain("const b = 2;");

		const first = fx.bridge.getContextInjection();
		expect(first).not.toBeNull();
		expect(first).toContain(`Active file: src/a.ts (selection lines 12-14)`);
		expect(first).toContain('<selection language="ts">');
		expect(first).toContain("const b = 2;");
		expect(first).toContain("Open tabs: src/a.ts");
		expect(first).toContain('source="MockIDE"');
		// getContextInjection consumes the pending injection; next call dedupes.
		expect(fx.bridge.getContextInjection()).toBeNull();

		// a changed selection re-arms the injection
		fx.mock.notify("selection_changed", {
			selection: {
				uri: pathToUri(A_TS),
				start: { line: 0, character: 0 },
				end: { line: 0, character: 10 },
				text: "import x;",
			},
		});
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		expect(fx.bridge.getContextInjection()).toContain("selection lines 1-1");
	});

	test("diagnostics are pulled after diagnostics_changed and injected", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		await waitFor(() => fx.mock.countCalls("getDiagnostics") >= 1); // initial pull
		fx.bridge.getContextInjection(); // consume initial active-file injection
		const before = fx.mock.countCalls("getDiagnostics");

		fx.mock.diagnostics = [
			{
				uri: pathToUri(A_TS),
				range: { start: { line: 11, character: 4 }, end: { line: 11, character: 9 } },
				severity: "error",
				message: "cannot assign string to number",
				source: "tsc",
			},
		];
		fx.mock.notify("diagnostics_changed", { uris: [pathToUri(A_TS)] });

		await waitFor(() => fx.mock.countCalls("getDiagnostics") > before);
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		const ctx = fx.bridge.getContextInjection();
		expect(ctx).toContain("Diagnostics: 1 errors");
		expect(ctx).toContain("src/a.ts:12:5 error cannot assign string to number");
	});

	test("at_mentioned reaches the host callback", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		fx.mock.notify("at_mentioned", {
			selection: null,
			text: "src/a.ts (lines 12-14)\n```ts\nconst a = 1;\n```",
		});
		await waitFor(() => fx.mentions.length === 1);
		expect(fx.mentions[0]?.text).toContain("lines 12-14");
	});

	test("LLM-callable operations proxy to the IDE", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);

		// tool boundary passes 0-based LSP positions straight through (protocol §3/§6)
		await fx.bridge.openFile("src/a.ts", 2, 5);
		const openCall = fx.mock.lastCall("openFile");
		expect(openCall?.params).toEqual({ uri: pathToUri(A_TS), line: 2, character: 5 });

		const ctx = (await fx.bridge.getEditorContext()) as { folders: string[] };
		expect(ctx.folders).toEqual([PROJ]);

		const diag = (await fx.bridge.getDiagnostics()) as { diagnostics: unknown[] };
		expect(diag.diagnostics).toEqual([]);

		const diff = (await fx.bridge.openDiff("src/a.ts", "new content")) as {
			status: string;
		};
		expect(diff.status).toBe("accepted");
		expect(fx.mock.lastCall("openDiff")?.params.newText).toBe("new content");
	});

	test("showDiff is optional and does not change the openDiff capability", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		expect(fx.bridge.supportsShowDiff).toBe(false);
		expect(fx.bridge.supportsDiff).toBe(true);
		await expect(fx.bridge.showDiff(A_TS, "before", "after", true, true))
			.rejects.toThrow("does not support showDiff");
		const autoDiff = new AutoDiff(fx.bridge);
		const path = join(fx.dir, "unsupported.txt");
		writeFileSync(path, "before");
		const event: ToolCallEvent = {
			type: "tool_call", toolCallId: "unsupported", toolName: "write", input: { path, content: "after" },
		};
		await autoDiff.beforeTool(event, fx.dir);
		writeFileSync(path, "after");
		await autoDiff.afterTool({ ...event, type: "tool_result", content: [], details: undefined, isError: false });
		expect(fx.mock.countCalls("showDiff")).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("after");
	});

	describe("automatic post-edit diffs", () => {
		beforeEach(async () => {
			fx.mock.capabilities.showDiff = true;
			fx.bridge.start(PROJ);
			await waitFor(() => fx.bridge.supportsShowDiff);
		});

		test("parallel writes use each call's disk snapshots, including new files", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const existing = join(fx.dir, "existing.txt");
			const created = join(fx.dir, "created.txt");
			writeFileSync(existing, "before existing\r\n");
			const first: ToolCallEvent = {
				type: "tool_call", toolCallId: "first", toolName: "write",
				input: { path: "existing.txt", content: "proposed, not actual" },
			};
			const second: ToolCallEvent = {
				type: "tool_call", toolCallId: "second", toolName: "write",
				input: { path: "created.txt", content: "also not actual" },
			};
			await Promise.all([autoDiff.beforeTool(first, fx.dir), autoDiff.beforeTool(second, fx.dir)]);
			writeFileSync(existing, "formatted existing\n");
			writeFileSync(created, "created on disk\n");
			await autoDiff.afterTool({ ...second, type: "tool_result", content: [], details: undefined, isError: false });
			await autoDiff.afterTool({ ...first, type: "tool_result", content: [], details: undefined, isError: false });
			await waitFor(() => fx.mock.countCalls("showDiff") === 2);
			expect(fx.mock.calls.filter((call) => call.method === "showDiff").map(({ params }) => ({
				uri: params.uri, oldText: params.oldText, newText: params.newText,
			}))).toEqual([
				{
					uri: pathToUri(created), oldText: "", newText: "created on disk\n",
				},
				{
					uri: pathToUri(existing), oldText: "before existing\r\n", newText: "formatted existing\n",
				},
			]);
			expect(readFileSync(existing, "utf8")).toBe("formatted existing\n");
			expect(readFileSync(created, "utf8")).toBe("created on disk\n");
		});

		test("empty file creation and deletion remain distinguishable for Refuse", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const path = join(fx.dir, "empty.txt");
			const create: ToolCallEvent = {
				type: "tool_call", toolCallId: "empty-create", toolName: "write", input: { path, content: "" },
			};
			await autoDiff.beforeTool(create, fx.dir);
			writeFileSync(path, "");
			await autoDiff.afterTool({
				...create, type: "tool_result", content: [], details: undefined, isError: false,
			});
			const remove: ToolCallEvent = {
				type: "tool_call", toolCallId: "empty-delete", toolName: "edit", input: { path },
			};
			await autoDiff.beforeTool(remove, fx.dir);
			rmSync(path);
			await autoDiff.afterTool({
				...remove, type: "tool_result", content: [], details: undefined, isError: false,
			});
			await waitFor(() => fx.mock.countCalls("showDiff") === 2);
			expect(fx.mock.calls.filter((call) => call.method === "showDiff").map(({ params }) => ({
				oldText: params.oldText, newText: params.newText,
				oldExists: params.oldExists, newExists: params.newExists,
			}))).toEqual([
				{ oldText: "", newText: "", oldExists: false, newExists: true },
				{ oldText: "", newText: "", oldExists: true, newExists: false },
			]);
		});

		test("hashline multi-file updates, deletes and quoted moves review every changed path", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const edited = join(fx.dir, "edited.txt");
			const deleted = join(fx.dir, "deleted.txt");
			const source = join(fx.dir, "source.txt");
			const destination = join(fx.dir, "renamed file.txt");
			writeFileSync(edited, "old edit\n");
			writeFileSync(deleted, "deleted text\n");
			writeFileSync(source, "moved text\n");
			const event: ToolCallEvent = {
				type: "tool_call", toolCallId: "multi", toolName: "edit",
				input: {
					paths: ["edited.txt", "deleted.txt", "source.txt"],
					input: "*** Begin Patch\n[edited.txt#A1B2]\nPUT 1.=1:\n+new edit\n" +
						"[deleted.txt#A1B2]\nREM\n[source.txt#A1B2]\nMV \"renamed file.txt\"\n*** End Patch\n",
				},
			};
			await autoDiff.beforeTool(event, fx.dir);
			writeFileSync(edited, "new edit\n");
			rmSync(deleted);
			renameSync(source, destination);
			await autoDiff.afterTool({
				...event, type: "tool_result", content: [], isError: false,
				details: {
					diff: "",
					perFileResults: [
						{ path: edited, diff: "", op: "update", oldText: "old edit\n", newText: "not used" },
						{ path: deleted, diff: "", op: "delete", oldText: "deleted text\n" },
						{ path: destination, sourcePath: source, move: destination, diff: "", op: "update" },
					],
				},
			});
			await waitFor(() => fx.mock.countCalls("showDiff") === 4);
			const snapshots = fx.mock.calls.filter((call) => call.method === "showDiff").map(({ params }) => ({
				uri: params.uri, oldText: params.oldText, newText: params.newText,
			}));
			expect(snapshots).toEqual([
				{ uri: pathToUri(edited), oldText: "old edit\n", newText: "new edit\n" },
				{ uri: pathToUri(deleted), oldText: "deleted text\n", newText: "" },
				{ uri: pathToUri(source), oldText: "moved text\n", newText: "" },
				{ uri: pathToUri(destination), oldText: "", newText: "moved text\n" },
			]);
			expect(existsSync(deleted)).toBe(false);
			expect(existsSync(source)).toBe(false);
			expect(readFileSync(destination, "utf8")).toBe("moved text\n");
		});

		test("structured patch rename captures an overwritten destination and partial failure", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const source = join(fx.dir, "old.txt");
			const destination = join(fx.dir, "new.txt");
			writeFileSync(source, "source text");
			writeFileSync(destination, "destination text");
			const event: ToolCallEvent = {
				type: "tool_call", toolCallId: "rename", toolName: "edit",
				input: { path: "old.txt", edits: [{ op: "update", rename: "new.txt", diff: "@@" }] },
			};
			await autoDiff.beforeTool(event, fx.dir);
			renameSync(source, destination);
			await autoDiff.afterTool({
				...event, type: "tool_result", content: [], details: undefined, isError: true,
			});
			await waitFor(() => fx.mock.countCalls("showDiff") === 2);
			expect(fx.mock.lastCall("showDiff")?.params).toMatchObject({
				uri: pathToUri(destination), oldText: "destination text", newText: "source text",
			});
		});

		test("apply_patch paths and hashline-wrapped write paths use actual snapshots", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const path = join(fx.dir, "apply.txt");
			const created = join(fx.dir, "added.txt");
			writeFileSync(path, "old");
			const event: ToolCallEvent = {
				type: "tool_call", toolCallId: "apply", toolName: "edit",
				input: { input: "*** Begin Patch\n*** Update File: apply.txt\n@@\n-old\n+new\n" +
					"*** Add File: added.txt\n+added\n*** End Patch\n" },
			};
			await autoDiff.beforeTool(event, fx.dir);
			writeFileSync(path, "new");
			writeFileSync(created, "added");
			await autoDiff.afterTool({ ...event, type: "tool_result", content: [], details: undefined, isError: false });
			const write: ToolCallEvent = {
				type: "tool_call", toolCallId: "wrapped", toolName: "write",
				input: { path: "[added.txt#A1B2]", content: "proposed" },
			};
			await autoDiff.beforeTool(write, fx.dir);
			writeFileSync(created, "actual");
			await autoDiff.afterTool({ ...write, type: "tool_result", content: [], details: undefined, isError: false });
			await waitFor(() => fx.mock.countCalls("showDiff") === 3);
			expect(fx.mock.lastCall("showDiff")?.params).toMatchObject({
				uri: pathToUri(created), oldText: "added", newText: "actual",
			});
		});

		test("no-ops, unsupported tools, internal URIs, binary and oversized files are skipped", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const unchanged = join(fx.dir, "unchanged.txt");
			const binary = join(fx.dir, "binary.dat");
			const invalidUtf8 = join(fx.dir, "invalid.dat");
			const large = join(fx.dir, "large.txt");
			writeFileSync(unchanged, "same");
			writeFileSync(binary, Buffer.from([1, 0, 2]));
			writeFileSync(invalidUtf8, Buffer.from([0xFF, 0xFE]));
			writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 65));
			const paths = [unchanged, binary, invalidUtf8, large, "local://plan.txt", "xd://ast_edit"];
			for (const [index, path] of paths.entries()) {
				const event: ToolCallEvent = {
					type: "tool_call", toolCallId: `skip-${index}`, toolName: "write", input: { path, content: "same" },
				};
				await autoDiff.beforeTool(event, fx.dir);
				if (path === binary || path === invalidUtf8 || path === large) {
					writeFileSync(path, "now valid text");
				}
				await autoDiff.afterTool({
					...event, type: "tool_result", content: [], details: undefined, isError: index === 0,
				});
			}
			const shell: ToolCallEvent = {
				type: "tool_call", toolCallId: "shell", toolName: "bash", input: { path: unchanged, command: "ignored" },
			};
			await autoDiff.beforeTool(shell, fx.dir);
			writeFileSync(unchanged, "shell edit");
			await autoDiff.afterTool({ ...shell, type: "tool_result", content: [], details: undefined, isError: false });
			const internal: ToolCallEvent = {
				type: "tool_call", toolCallId: "internal", toolName: "edit",
				input: { path: "local://private.txt" },
			};
			await autoDiff.beforeTool(internal, fx.dir);
			await autoDiff.afterTool({
				...internal, type: "tool_result", content: [], isError: false,
				details: { path: unchanged, diff: "", oldText: "private contents", newText: "shell edit" },
			});
			await fx.bridge.getEditorContext();
			expect(fx.mock.countCalls("showDiff")).toBe(0);
		});

		test("cleanup drops pending snapshots and IDE errors never fail tool results", async () => {
			const autoDiff = new AutoDiff(fx.bridge);
			const path = join(fx.dir, "cleanup.txt");
			writeFileSync(path, "before");
			const event: ToolCallEvent = {
				type: "tool_call", toolCallId: "cleanup", toolName: "write", input: { path, content: "after" },
			};
			const result: ToolResultEvent = {
				...event, type: "tool_result", content: [{ type: "text", text: "ok" }], details: undefined, isError: false,
			};
			await autoDiff.beforeTool(event, fx.dir);
			autoDiff.clear();
			writeFileSync(path, "after");
			await autoDiff.afterTool(result);
			expect(fx.mock.countCalls("showDiff")).toBe(0);
			fx.mock.showDiffError = true;
			await autoDiff.beforeTool(event, fx.dir);
			writeFileSync(path, "after again");
			await expect(autoDiff.afterTool(result)).resolves.toBeUndefined();
			await waitFor(() => fx.mock.countCalls("showDiff") === 1);
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(result.isError).toBe(false);
			expect(readFileSync(path, "utf8")).toBe("after again");
		});
	});

	test("reports a refused document save", async () => {
		fx.mock.saveResult = false;
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		await expect(fx.bridge.saveDocument("src/a.ts")).rejects.toThrow("IDE did not save");
	});

	test("tool results pass through 0-based LSP positions", async () => {
		fx.mock.selection = {
			uri: pathToUri(A_TS),
			start: { line: 2, character: 10 },
			end: { line: 4, character: 1 },
			text: "x",
		};
		fx.mock.diagnostics = [
			{
				uri: pathToUri(A_TS),
				range: { start: { line: 2, character: 25 }, end: { line: 2, character: 52 } },
				severity: "error",
				message: "boom",
				source: "ts",
			},
		];
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);

		const ctx = (await fx.bridge.getEditorContext()) as {
			selection: { start: { line: number; character: number } };
			positionConvention: string;
		};
		expect(ctx.selection.start).toEqual({ line: 2, character: 10 });
		expect(ctx.positionConvention).toBe("0-based (LSP)");

		const diag = (await fx.bridge.getDiagnostics()) as {
			diagnostics: Array<{ range: { start: { line: number; character: number } } }>;
			positionConvention: string;
		};
		expect(diag.diagnostics[0]?.range.start).toEqual({ line: 2, character: 25 });
		expect(diag.positionConvention).toBe("0-based (LSP)");
	});

	test("closing all editors clears status and context injection", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		fx.bridge.getContextInjection(); // consume initial

		fx.mock.notify("selection_changed", {
			selection: {
				uri: pathToUri(A_TS),
				start: { line: 4, character: 0 },
				end: { line: 6, character: 2 },
				text: "some code",
			},
		});
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		fx.bridge.getContextInjection(); // consume

		fx.mock.notify("editors_changed", { editors: [] });
		await waitFor(() => fx.liveSelections.at(-1) === null);
		expect(fx.bridge.peekContextInjection()).toBeNull();
	});

	test("null selection with editors still open keeps last selection", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		fx.mock.notify("selection_changed", {
			selection: {
				uri: pathToUri(A_TS),
				start: { line: 1, character: 0 },
				end: { line: 1, character: 8 },
				text: "selected!",
			},
		});
		await waitFor(() => fx.liveSelections.some((s) => s?.text === "selected!"));

		const before = fx.liveSelections.length;
		fx.mock.notify("selection_changed", { selection: null });
		await waitFor(() => fx.liveSelections.length > before);
		// focus-loss null must not wipe the status line
		expect(fx.liveSelections.at(-1)?.text).toBe("selected!");
	});

	test("reconnects after the IDE pushes shutdown", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		const initCalls = fx.mock.countCalls("initialize");

		fx.mock.notify("shutdown", {});
		await waitFor(() => !fx.bridge.connected);
		expect(fx.liveSelections.at(-1)).toBeNull(); // status line cleared
		// server stays up; backoff (1s) should reconnect against the same lockfile
		await waitFor(() => fx.bridge.connected, 5000);
		expect(fx.mock.countCalls("initialize")).toBeGreaterThan(initCalls);
	});

	test("reconnects after an abrupt socket close", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		const initializeCallsBeforeDisconnect = fx.mock.countCalls("initialize");

		fx.mock.terminateClients();
		await waitFor(() => !fx.bridge.connected);
		await waitFor(() => fx.bridge.connected, 5000);
		expect(fx.mock.countCalls("initialize")).toBeGreaterThan(initializeCallsBeforeDisconnect);
	});
});

describe("lockfile discovery", () => {
	test("stale locks (dead pid, bad json) are removed; live ones listed", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ide-scan-"));
		writeLock(dir, 31001, randomUUID()); // live
		writeLock(dir, 31002, randomUUID(), 2_000_000); // dead pid
		writeFileSync(join(dir, "31003.lock"), "{not json");
		const candidates = scanCandidates(dir);
		expect(candidates.map((c) => c.port)).toEqual([31001]);
		expect(existsSync(join(dir, "31002.lock"))).toBe(false);
		expect(existsSync(join(dir, "31003.lock"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	test("explicit port wins; otherwise newest matching workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ide-pick-"));
		writeLock(dir, 32001, randomUUID());
		writeLock(dir, 32002, randomUUID());
		// make 32001 the newer lock
		const now = new Date();
		utimesSync(join(dir, "32001.lock"), now, now);
		utimesSync(join(dir, "32002.lock"), new Date(0), new Date(0));

		expect(pickCandidate(PROJ, 32002, dir)?.port).toBe(32002);
		expect(pickCandidate(PROJ, undefined, dir)?.port).toBe(32001);
		expect(pickCandidate(ELSEWHERE, undefined, dir)).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("path helpers", () => {
	test("round-trips native paths with spaces and non-ASCII characters", () => {
		const nativePath = join(PROJ, "space and 你好.ts");
		const fileUri = pathToUri(nativePath);
		expect(fileUri).toContain("space%20and%20%E4%BD%A0%E5%A5%BD.ts");
		expect(uriToPath(fileUri)).toBe(nativePath);
	});

	test("checks containment on path boundaries", () => {
		expect(pathContains(PROJ, PROJ)).toBe(true);
		expect(pathContains(PROJ, A_TS)).toBe(true);
		expect(pathContains(PROJ, `${PROJ}-sibling`)).toBe(false);
		if (process.platform === "win32") {
			expect(pathContains(PROJ.toUpperCase(), A_TS.toLowerCase())).toBe(true);
		}
	});

	test("converts Windows drive paths without depending on the host OS", () => {
		const windowsPath = String.raw`Z:\Codes\repo\a b.ts`;
		expect(pathToUri(windowsPath)).toBe("file:///Z:/Codes/repo/a%20b.ts");
	});

	test("decodes empty-authority POSIX file URIs without adding a slash", () => {
		if (process.platform === "win32") return;
		expect(uriToPath("file:///tmp/omp-ide-test-project/src/a.ts")).toBe(
			"/tmp/omp-ide-test-project/src/a.ts",
		);
	});

	test("decodes Windows drive file URIs on every host platform", () => {
		expect(uriToPath("file:///Z:/Codes/repo/a%20b.ts").replaceAll("\\", "/")).toBe(
			"Z:/Codes/repo/a b.ts",
		);
	});

	test("resolves relative paths against a Windows cwd without host contamination", async () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "omp-ide-uri-"));
		const bridge = new OmpIdeBridge(
			{ onStatus: () => {}, onAtMentioned: () => {}, onSelectionStatus: () => {} },
			dir,
		);
		bridge.start(String.raw`Z:\Codes\remote-workspace`);
		try {
			// @ts-expect-error private contract exercised to cover cross-runtime cwd
			expect(bridge.toUri("src/a.ts")).toBe("file:///Z:/Codes/remote-workspace/src/a.ts");
		} finally {
			bridge.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("round-trips Windows UNC paths", () => {
		if (process.platform !== "win32") return;
		const uncPath = String.raw`\\server\share\repo\a b.ts`;
		const fileUri = pathToUri(uncPath);
		expect(fileUri).toBe("file://server/share/repo/a%20b.ts");
		expect(uriToPath(fileUri)).toBe(uncPath);
	});
});

describe("buildIdeContext", () => {
	const base: IdeSnapshot = {
		ideName: "MockIDE",
		editors: [],
		selection: null,
		diagnostics: [],
	};

	test("empty snapshot injects nothing", () => {
		expect(buildIdeContext(base, PROJ)).toBeNull();
	});

	test("active file without selection still reported", () => {
		const out = buildIdeContext(
			{ ...base, editors: [{ uri: pathToUri(A_TS), isActive: true }] },
			PROJ,
		);
		expect(out).toContain("Active file: src/a.ts");
		expect(out).not.toContain("<selection");
	});

	test("tabs capped at 10 with overflow count", () => {
		const editors = Array.from({ length: 15 }, (_, i) => ({
			uri: pathToUri(join(PROJ, `f${i}.ts`)),
			isActive: false,
		}));
		const out = buildIdeContext({ ...base, editors }, PROJ);
		expect(out).toContain("(+5 more)");
	});

	test("formatSelectionStatus: range, caret, and cwd-relative paths", () => {
		const sel = (start: number, end: number): Selection => ({
			uri: pathToUri(A_TS),
			start: { line: start, character: 0 },
			end: { line: end, character: 3 },
			text: "x",
		});
		expect(formatSelectionStatus(sel(11, 13), PROJ, "\u{F15B}", 80)).toBe("\u{F15B} src/a.ts:12-14");
		expect(formatSelectionStatus(sel(6, 6), PROJ, "\u{F15B}", 80)).toBe("\u{F15B} src/a.ts:7");
		const outsideStatus = formatSelectionStatus(sel(0, 0), ELSEWHERE, "\u{F15B}", 200);
		expect(outsideStatus).toStartWith("\u{F15B} ");
		expect(outsideStatus).toContain("/src/a.ts:1");
		expect(Bun.stringWidth(outsideStatus)).toBeLessThanOrEqual(160);
	});

	test.each(["\u{F15B}", "\u{1F4C4}", "[F]", ""])("formatSelectionStatus: icon %s fits with a long path and line suffix", (icon) => {
		const deep = join(
			PROJ,
			"very",
			"deeply",
			"nested",
			"directory",
			"structure",
			"with",
			"a",
			"really",
			"long",
			"file-name.ts",
		);
		const out = formatSelectionStatus(
			{
				uri: pathToUri(deep),
				start: { line: 122, character: 0 },
				end: { line: 122, character: 0 },
				text: "",
			},
			PROJ,
			icon,
			55,
		);
		expect(Bun.stringWidth(out)).toBeLessThanOrEqual(44);
		expect(out).toStartWith(icon ? `${icon} ` : "very/");
		expect(out).toEndWith(":123");
		expect(out).toContain("…");
		expect(out).toContain("file-name.ts");
		expect(out).toContain("very/…/");
	});

	test("formatSelectionStatus: terminal width restores the complete path", () => {
		const path = "packages/omp-extension/src/very-long-directory/editor-selection-handler.ts";
		const sel: Selection = {
			uri: pathToUri(join(PROJ, path)),
			start: { line: 65, character: 0 },
			end: { line: 73, character: 0 },
			text: "",
		};
		const narrow = formatSelectionStatus(sel, PROJ, "\u{1F4C4}", 64);
		expect(narrow).toBe("\u{1F4C4} packages/…/editor-selection-handler.ts:66-74");
		expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(Math.floor(64 * 0.8));
		expect(formatSelectionStatus(sel, PROJ, "\u{1F4C4}", 120)).toBe(`\u{1F4C4} ${path}:66-74`);
	});

	test("formatSelectionStatus: wide filenames and tiny terminals stay within budget", () => {
		const sel: Selection = {
			uri: pathToUri(join(PROJ, "目录", "nested", "非常长的文件名称👩‍💻.ts")),
			start: { line: 9, character: 0 },
			end: { line: 9, character: 0 },
			text: "",
		};
		for (const columns of [0, 1, 4, 10, 30, 50]) {
			const out = formatSelectionStatus(sel, PROJ, "\u{1F4C4}", columns);
			expect(Bun.stringWidth(out)).toBeLessThanOrEqual(Math.floor(columns * 0.8));
			if (columns >= 4) expect(out).toEndWith(":10");
		}
		expect(formatSelectionStatus(sel, PROJ, "", 40)).toContain("目录/…/");
	});

	test("selection text truncated at 2000 chars", () => {
		const out = buildIdeContext(
			{
				...base,
				selection: {
					uri: pathToUri(A_TS),
					start: { line: 0, character: 0 },
					end: { line: 99, character: 0 },
					text: "x".repeat(5000),
				},
			},
			PROJ,
		);
		expect(out).toContain("… (truncated)");
		expect(out!.length).toBeLessThan(2400);
	});
});
