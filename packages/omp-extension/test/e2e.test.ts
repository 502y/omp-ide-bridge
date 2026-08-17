/**
 * E2E: OmpIdeBridge against a mock IDE server speaking protocol v1.
 * Also covers lockfile discovery rules and the context injection builder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(formatSelectionStatus(sel(11, 13), PROJ)).toBe("\u{F15B} src/a.ts:12-14");
		expect(formatSelectionStatus(sel(6, 6), PROJ)).toBe("\u{F15B} src/a.ts:7");
		const outsideStatus = formatSelectionStatus(sel(0, 0), ELSEWHERE);
		expect(outsideStatus).toStartWith("\u{F15B} ");
		expect(outsideStatus).toContain("…");
		expect(outsideStatus).toEndWith("/src/a.ts:1");
	});

	test("formatSelectionStatus: long paths middle-truncate, line suffix survives", () => {
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
		);
		expect(out.length).toBeLessThanOrEqual(46);
		expect(out).toEndWith(":123");
		expect(out).toContain("…");
		expect(out).toContain("file-name.ts");
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
