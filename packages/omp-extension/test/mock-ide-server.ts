/**
 * Mock IDE server for e2e tests: speaks protocol v1 over `ws`,
 * records every request, and lets tests push notifications.
 */

import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface RecordedCall {
	method: string;
	params: Record<string, unknown>;
}

export class MockIdeServer {
	port = 0;
	calls: RecordedCall[] = [];
	folders: string[] = [];
	editors: unknown[] = [];
	selection: unknown = null;
	diagnostics: unknown[] = [];
	capabilities = { openDiff: true, diagnostics: true, executeCode: false };
	protocolVersion = 1;
	saveResult = true;

	private wss: WebSocketServer | null = null;
	private sockets = new Set<WebSocket>();

	constructor(readonly token: string) {}

	start(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		this.wss = wss;
		wss.on("listening", () => {
			const addr: AddressInfo | string | null = wss.address();
			if (addr === null || typeof addr === "string") {
				throw new Error("mock server did not bind a TCP port");
			}
			this.port = addr.port;
			resolve();
		});
		wss.on("connection", (socket, req) => {
			if (req.headers["x-omp-ide-authorization"] !== this.token) {
				socket.close(1008, "bad auth");
				return;
			}
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("message", (raw) => {
				const parsed: unknown = JSON.parse(String(raw));
				if (typeof parsed !== "object" || parsed === null) return;
				if (!("id" in parsed) || typeof parsed.id !== "number") return;
				if (!("method" in parsed) || typeof parsed.method !== "string") return;
				const params =
					"params" in parsed && typeof parsed.params === "object" && parsed.params !== null
						? (parsed.params as Record<string, unknown>)
						: {};
				const id = parsed.id;
				const method = parsed.method;
				this.calls.push({ method, params });
				const result = this.route(method, params);
				const frame =
					result instanceof Error
						? { jsonrpc: "2.0", id, error: { code: -32601, message: result.message } }
						: { jsonrpc: "2.0", id, result };
				socket.send(JSON.stringify(frame));
			});
		});
		return promise;
	}

	private route(method: string, params: Record<string, unknown>): unknown {
		switch (method) {
			case "initialize":
				return {
					ideName: "MockIDE",
					ideVersion: "1.0.0",
					protocolVersion: this.protocolVersion,
					capabilities: this.capabilities,
				};
			case "getWorkspaceFolders":
				return { folders: this.folders };
			case "getOpenEditors":
				return { editors: this.editors };
			case "getCurrentSelection":
			case "getLatestSelection":
				return { selection: this.selection };
			case "getDiagnostics":
				return { diagnostics: this.diagnostics };
			case "openFile":
				return { opened: true };
			case "saveDocument":
				return { saved: this.saveResult };
			case "checkDocumentDirty":
				return { isDirty: false };
			case "closeTab":
				return { closed: true };
			case "openDiff":
				return { status: "accepted", finalText: params.newText ?? "" };
			default:
				return new Error(`unknown method: ${method}`);
		}
	}

	notify(method: string, params: Record<string, unknown>): void {
		const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
		for (const s of this.sockets) s.send(frame);
	}

	terminateClients(): void {
		for (const socket of this.sockets) socket.terminate();
	}

	countCalls(method: string): number {
		return this.calls.filter((c) => c.method === method).length;
	}

	lastCall(method: string): RecordedCall | undefined {
		return [...this.calls].reverse().find((c) => c.method === method);
	}

	stop(): Promise<void> {
		for (const s of this.sockets) s.terminate();
		this.sockets.clear();
		const wss = this.wss;
		this.wss = null;
		// ws#close's callback never fires under Bun once clients existed;
		// fire-and-forget suffices — each fixture uses a fresh server/port.
		wss?.close();
		return Promise.resolve();
	}
}
