/**
 * WebSocket JSON-RPC client for one IDE connection.
 *
 * Uses the global `WebSocket` (Node >=22 / Bun) so the OMP extension needs
 * zero runtime dependencies. Auth token travels in the upgrade header
 * `x-omp-ide-authorization`.
 */

import {
	diagnosticList,
	editorList,
	initializeResult,
	selectionOrNull,
	stringList,
} from "./parse";
import { PROTOCOL_VERSION, type AtMention, type Editor, type InitializeResult, type Selection } from "./protocol";

export interface BridgeClientEvents {
	onSelectionChanged(sel: Selection | null): void;
	onEditorsChanged(editors: Editor[]): void;
	onDiagnosticsChanged(uris: string[]): void;
	onWorkspaceChanged(folders: string[]): void;
	onAtMentioned(mention: AtMention): void;
	onClose(): void;
}

interface PendingCall {
	resolve(value: unknown): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DIFF_CALL_TIMEOUT_MS = 10 * 60_000;

export class BridgeClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	private closedByUs = false;
	private closeNotified = false;

	/** Filled after a successful `initialize`. */
	ide: InitializeResult | null = null;

	constructor(
		readonly port: number,
		private readonly authToken: string,
		private readonly events: BridgeClientEvents,
	) {}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	connect(): Promise<InitializeResult> {
		this.closedByUs = false;
		this.closeNotified = false;
		const { promise, resolve, reject } = Promise.withResolvers<InitializeResult>();
		const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`, {
			headers: { "x-omp-ide-authorization": this.authToken },
		});
		this.ws = ws;
		const fail = (msg: string) => {
			if (this.ws === ws) this.disposeSocket();
			reject(new Error(msg));
		};
		ws.onerror = () => fail(`IDE bridge connect failed on port ${this.port}`);
		ws.onclose = (ev) => {
			const completedHandshake = this.ide !== null;
			this.handleSocketClosed();
			if (!completedHandshake && !this.closedByUs) {
				reject(
					new Error(
						ev.code === 1008
							? "IDE bridge auth rejected (1008)"
							: `IDE bridge closed before handshake (code ${ev.code})`,
					),
				);
			}
			this.notifyUnexpectedClose();
		};
		ws.onmessage = (ev) => this.handleMessage(String(ev.data));
		ws.onopen = () => {
			this.call("initialize", {
				clientName: "omp",
				clientVersion: "0.1.0",
				pid: process.pid,
			})
				.then((res) => {
					const initializeResponse = initializeResult(res);
					if (initializeResponse.protocolVersion !== PROTOCOL_VERSION) {
						throw new Error(
							`unsupported IDE bridge protocol version ${initializeResponse.protocolVersion}; expected ${PROTOCOL_VERSION}`,
						);
					}
					this.ide = initializeResponse;
					resolve(initializeResponse);
				})
				.catch((err: Error) => {
					this.disposeSocket();
					reject(err);
				});
		};
		return promise;
	}

	/** JSON-RPC request; rejects on error response, timeout, or disconnect. */
	call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("IDE bridge not connected"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = this.nextId++;
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`IDE call timed out: ${method}`));
		}, timeoutMs);
		this.pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
		return promise;
	}

	/** openDiff blocks on user review — needs a much longer budget. */
	callDiff(params: unknown): Promise<unknown> {
		return this.call("openDiff", params, DIFF_CALL_TIMEOUT_MS);
	}

	close(): void {
		this.closedByUs = true;
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			try {
				this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "shutdown" }));
			} catch {
				/* best effort */
			}
		}
		this.disposeSocket();
	}

	private disposeSocket(): void {
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		}
		this.handleSocketClosed();
	}

	private notifyUnexpectedClose(): void {
		if (this.closedByUs || this.closeNotified) return;
		this.closeNotified = true;
		this.events.onClose();
	}

	private handleSocketClosed(): void {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("IDE bridge disconnected"));
			this.pending.delete(id);
		}
		this.ide = null;
	}

	private handleMessage(raw: string): void {
		let msg: {
			id?: number;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { code: number; message: string };
		};
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
			else p.resolve(msg.result);
			return;
		}
		if (typeof msg.method === "string") {
			this.dispatchNotification(msg.method, msg.params ?? {});
		}
	}

	private dispatchNotification(method: string, params: Record<string, unknown>): void {
		switch (method) {
			case "selection_changed":
				this.events.onSelectionChanged(selectionOrNull(params.selection));
				break;
			case "editors_changed":
				this.events.onEditorsChanged(editorList(params.editors));
				break;
			case "diagnostics_changed":
				this.events.onDiagnosticsChanged(stringList(params.uris));
				break;
			case "workspace_changed":
				this.events.onWorkspaceChanged(stringList(params.folders));
				break;
			case "at_mentioned": {
				const text = typeof params.text === "string" ? params.text : "";
				this.events.onAtMentioned({ selection: selectionOrNull(params.selection), text });
				break;
			}
			case "shutdown":
				this.disposeSocket();
				this.notifyUnexpectedClose();
				break;
		}
	}
}
