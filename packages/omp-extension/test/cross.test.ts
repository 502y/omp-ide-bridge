/**
 * Cross-implementation integration test, production topology:
 * THEIR VS Code extension server core runs under plain Node (like the real
 * VS Code extension host); OUR OmpIdeBridge client runs here under Bun
 * (the omp runtime). Both sides were implemented independently from
 * docs/protocol.md — this proves the contract across runtimes.
 *
 * NOTE: running their esbuild-bundled ws server *inside* Bun stalls the
 * upgrade handshake (bundled ws + Bun's node:http compat) — a test-harness
 * artifact, not a protocol or production issue, hence the child process.
 *
 * Requires `npm run compile` in packages/vscode-extension first.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmpIdeBridge } from "../src/core";
import { pathToUri } from "../src/protocol";

setDefaultTimeout(20_000);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "vs-server-runner.mjs");
const SERVER_BUNDLE = join(HERE, "..", "..", "vscode-extension", "dist", "server.js");
const PROJ = join(tmpdir(), "omp-ide-cross-project");
const SECOND_FILE_URI = pathToUri(join(PROJ, "src", "b.ts"));

// Same integration exception as e2e.test.ts: real sockets, real backoff.
function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
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

function waitForReady(child: ChildProcess, timeoutMs = 8000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let stdoutText = "";
	const timeout = setTimeout(
		() => finish(new Error(`VS Code test server did not become ready. stdout: ${stdoutText}`)),
		timeoutMs,
	);
	const onData = (chunk: Buffer) => {
		stdoutText += chunk.toString();
		if (/^READY \d+$/m.test(stdoutText)) finish();
	};
	const onError = (error: Error) => finish(error);
	const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
		finish(new Error(`VS Code test server exited before ready: code=${code}, signal=${signal}`));
	const finish = (error?: Error) => {
		clearTimeout(timeout);
		child.stdout?.off("data", onData);
		child.off("error", onError);
		child.off("exit", onExit);
		if (error) reject(error);
		else resolve();
	};
	child.stdout?.on("data", onData);
	child.on("error", onError);
	child.on("exit", onExit);
	return promise;
}

interface CrossFixture {
	dir: string;
	child: ChildProcess;
	bridge: OmpIdeBridge;
	statuses: string[];
}

function send(child: ChildProcess, cmd: Record<string, unknown>): void {
	if (child.exitCode !== null || child.stdin?.destroyed) return;
	try {
		child.stdin?.write(`${JSON.stringify(cmd)}\n`);
	} catch {
		// Test child may have exited between the liveness check and write.
	}
}

describe("cross: omp client (Bun) × vscode server build (Node)", () => {
	let fx: CrossFixture;

	beforeEach(async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-ide-cross-"));
		const child = spawn(
			Bun.which("node") ?? "node",
			[RUNNER, SERVER_BUNDLE, dir, PROJ],
			{ stdio: ["pipe", "pipe", "inherit"] },
		);
		const statuses: string[] = [];
		const bridge = new OmpIdeBridge(
			{ onStatus: (s) => statuses.push(s), onAtMentioned: () => {}, onSelectionStatus: () => {} },
			dir,
		);
		fx = { dir, child, bridge, statuses };
		await waitForReady(child);
		if (!readdirSync(dir).some((fileName) => fileName.endsWith(".lock"))) {
			throw new Error("VS Code test server reported ready without a lockfile");
		}
	});

	afterEach(async () => {
		fx.bridge.stop();
		// The graceful shutdown test may already have asked the server to stop;
		// avoid a second control write racing its process exit.
		if (fx.child.exitCode === null) {
			send(fx.child, { stop: true });
		}
		await waitFor(() => fx.child.exitCode !== null, 8000).catch(() => {
			fx.child.kill("SIGKILL");
		});
		rmSync(fx.dir, { recursive: true, force: true });
	});

	test("full protocol round trip across runtimes", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		expect(fx.bridge.ideName).toBe("FakeCode");

		// initial pull → injection reflects their adapter state
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		const ctx = fx.bridge.getContextInjection();
		expect(ctx).toContain('source="FakeCode"');
		expect(ctx).toContain("Active file: src/a.ts (selection lines 5-7)");
		expect(ctx).toContain("export const answer = 42;");
		expect(ctx).toContain("Open tabs: src/a.ts, src/b.ts");
		expect(ctx).toContain("Diagnostics: 1 errors");
		expect(ctx).toContain("src/a.ts:5:7 error unused constant");

		// server-pushed selection notification re-arms the injection
		send(fx.child, {
			fire: "selection",
			arg: {
				uri: SECOND_FILE_URI,
				start: { line: 0, character: 0 },
				end: { line: 2, character: 0 },
				text: "// b file",
			},
		});
		await waitFor(() => fx.bridge.peekContextInjection() !== null);
		expect(fx.bridge.getContextInjection()).toContain(
			"Active file: src/b.ts (selection lines 1-3)",
		);

		// request proxying
		const opened = (await fx.bridge.openFile("src/b.ts", 1)) as { opened: boolean };
		expect(opened.opened).toBe(true);
		const diag = (await fx.bridge.getDiagnostics("src/a.ts")) as {
			diagnostics: Array<{ message: string }>;
		};
		const diagnosticMessages = diag.diagnostics.map((diagnostic) => diagnostic.message);
		expect(diagnosticMessages, JSON.stringify(diag)).toContain("unused constant");
		const diff = (await fx.bridge.openDiff("src/a.ts", "replacement")) as {
			status: string;
			finalText: string;
		};
		expect(diff).toEqual({ status: "accepted", finalText: "replacement" });
	});

	test("graceful shutdown disconnects the client", async () => {
		fx.bridge.start(PROJ);
		await waitFor(() => fx.bridge.connected);
		send(fx.child, { stop: true });
		await waitFor(() => !fx.bridge.connected);
		expect(fx.statuses.some((s) => s.includes("disconnected"))).toBe(true);
	});
});
