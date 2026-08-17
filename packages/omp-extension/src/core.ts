/**
 * Host-agnostic orchestration: lockfile discovery, (re)connect, state cache,
 * diagnostics pulling, and the per-turn context injection.
 *
 * No OMP imports — this module is driven by index.ts inside the agent and by
 * tests against a mock IDE server.
 */

import { isAbsolute, resolve, win32 } from "node:path";
import { BridgeClient } from "./bridge-client";
import { buildIdeContext } from "./context";
import { pickCandidate, scanCandidates, type IdeCandidate } from "./lockfile";
import {
	diagnosticList,
	editorList,
	readField,
	selectionOrNull,
	stringList,
} from "./parse";
import {
	pathToUri,
	uriToPath,
	type AtMention,
	type Diagnostic,
	type Editor,
	type Selection,
} from "./protocol";

export interface BridgeEvents {
	/** Human-readable status transitions, e.g. connected/disconnected. */
	onStatus(text: string): void;
	onAtMentioned(mention: AtMention): void;
	/**
	 * Live selection for the status line: fired with the effective selection
	 * (current, else last non-empty) on every selection_changed, and with
	 * `null` when the connection drops.
	 */
	onSelectionStatus(sel: Selection | null): void;
}

export interface BridgeStatus {
	connected: boolean;
	ideName: string | null;
	port: number | null;
	candidates: Array<{ port: number; ideName: string; folders: string[] }>;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000] as const;
const DIAG_PULL_DEBOUNCE_MS = 500;

export class OmpIdeBridge {
	private cwd = "";
	private client: BridgeClient | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private stopped = true;

	private editors: Editor[] = [];
	private currentSelection: Selection | null = null;
	private latestSelection: Selection | null = null;
	private diagnostics = new Map<string, Diagnostic[]>();
	private diagPullTimer: NodeJS.Timeout | null = null;
	private lastInjection: string | null = null;

	constructor(
		private readonly events: BridgeEvents,
		private readonly lockDir?: string,
	) {}

	get connected(): boolean {
		return this.client?.connected ?? false;
	}

	get ideName(): string | null {
		return this.client?.ide?.ideName ?? null;
	}

	get supportsDiff(): boolean {
		return this.client?.ide?.capabilities.openDiff ?? false;
	}

	start(cwd: string): void {
		this.cwd = cwd;
		this.stopped = false;
		void this.tryConnect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimers();
		this.client?.close();
		this.client = null;
	}

	disconnect(): void {
		// User-initiated: stop reconnecting until start()/connectTo() runs again.
		this.stop();
		this.events.onStatus("IDE bridge disconnected");
	}

	/** Connect to a specific discovered port (from `/ide <n>`). */
	connectTo(port: number): Promise<boolean> {
		this.stopped = false;
		const hit = scanCandidates(this.lockDir).find((c) => c.port === port);
		if (!hit) return Promise.resolve(false);
		return this.open(hit);
	}

	status(): BridgeStatus {
		return {
			connected: this.connected,
			ideName: this.ideName,
			port: this.client?.connected ? this.client.port : null,
			candidates: scanCandidates(this.lockDir).map((c) => ({
				port: c.port,
				ideName: c.lock.ideName,
				folders: c.lock.workspaceFolders,
			})),
		};
	}

	/** Side-effect-free view of the pending injection (for status/tests). */
	peekContextInjection(): string | null {
		if (!this.connected) return null;
		const text = buildIdeContext(
			{
				ideName: this.ideName ?? "IDE",
				editors: this.editors,
				selection: this.effectiveSelection(),
				diagnostics: [...this.diagnostics.values()].flat(),
			},
			this.cwd,
		);
		return text === null || text === this.lastInjection ? null : text;
	}

	/** Effective selection for status/context; nothing counts when no editor is open. */
	private effectiveSelection(): Selection | null {
		if (this.editors.length === 0) return null;
		return this.currentSelection ?? this.latestSelection;
	}

	/** Message for `before_agent_start`; consumes the pending injection. */
	getContextInjection(): string | null {
		const text = this.peekContextInjection();
		if (text !== null) this.lastInjection = text;
		return text;
	}

	// ---- LLM-callable operations (thin proxies over JSON-RPC) ----

	async getEditorContext(): Promise<unknown> {
		const c = this.requireClient();
		const [folders, editors, selection] = await Promise.all([
			c.call("getWorkspaceFolders"),
			c.call("getOpenEditors"),
			c.call("getCurrentSelection"),
		]);
		return {
			folders: readField(folders, "folders", stringList).map(uriToPath),
			editors: readField(editors, "editors", editorList),
			// Wire-native LSP shape, 0-based — matches model priors; presenting
			// line+1 is then the correct, habitual conversion.
			selection: readField(selection, "selection", selectionOrNull),
			positionConvention: "0-based (LSP)",
		};
	}

	/** [line]/[character] are 0-based (LSP convention), passed straight through. */
	openFile(path: string, line?: number, character?: number): Promise<unknown> {
		return this.requireClient().call("openFile", {
			uri: this.toUri(path),
			...(line !== undefined ? { line } : {}),
			...(character !== undefined ? { character } : {}),
		});
	}

	async getDiagnostics(path?: string): Promise<unknown> {
		if (!(this.client?.ide?.capabilities.diagnostics ?? false)) {
			throw new Error("Connected IDE does not support diagnostics");
		}
		const res = await this.requireClient().call("getDiagnostics", {
			...(path !== undefined ? { uri: this.toUri(path) } : {}),
		});
		return {
			// Wire-native LSP shape, 0-based (see getEditorContext).
			diagnostics: readField(res, "diagnostics", diagnosticList).map((d) => ({
				...d,
				path: uriToPath(d.uri),
			})),
			positionConvention: "0-based (LSP)",
		};
	}

	async saveDocument(path: string): Promise<void> {
		const result = await this.requireClient().call("saveDocument", { uri: this.toUri(path) });
		const saved = readField(result, "saved", (value) => value === true);
		if (!saved) throw new Error(`IDE did not save ${path}`);
	}

	openDiff(path: string, newText: string, tabName?: string): Promise<unknown> {
		if (!this.supportsDiff) {
			throw new Error("Connected IDE does not support openDiff");
		}
		return this.requireClient().callDiff({
			uri: this.toUri(path),
			newText,
			...(tabName !== undefined ? { tabName } : {}),
		});
	}

	// ---- internals ----

	private requireClient(): BridgeClient {
		if (!this.client?.connected) throw new Error("IDE not connected");
		return this.client;
	}

	private toUri(pathOrUri: string): string {
		if (pathOrUri.startsWith("file:")) return pathOrUri;
		if (isAbsolute(pathOrUri) || win32.isAbsolute(pathOrUri)) {
			return pathToUri(pathOrUri);
		}
		return pathToUri(resolve(this.cwd, pathOrUri));
	}

	private clearTimers(): void {
		clearTimeout(this.reconnectTimer ?? undefined);
		clearTimeout(this.diagPullTimer ?? undefined);
		this.reconnectTimer = this.diagPullTimer = null;
	}

	private async tryConnect(): Promise<void> {
		if (this.stopped || this.connected) return;
		const envPort = process.env.OMP_IDE_PORT
			? Number(process.env.OMP_IDE_PORT)
			: undefined;
		const candidate = pickCandidate(
			this.cwd,
			Number.isInteger(envPort) ? envPort : undefined,
			this.lockDir,
		);
		if (candidate) {
			await this.open(candidate);
			return;
		}
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		const delay =
			RECONNECT_BACKOFF_MS[
				Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
			];
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.tryConnect();
		}, delay);
	}

	private async open(candidate: IdeCandidate): Promise<boolean> {
		this.client?.close();
		const client = new BridgeClient(candidate.port, candidate.lock.authToken, {
			onSelectionChanged: (sel) => {
				this.currentSelection = sel;
				if (sel !== null && sel.text !== "") this.latestSelection = sel;
				this.events.onSelectionStatus(this.effectiveSelection());
			},
			onEditorsChanged: (editors) => {
				this.editors = editors;
				if (editors.length === 0) {
					this.currentSelection = null;
					this.events.onSelectionStatus(null);
				}
			},
			onDiagnosticsChanged: () => {
				this.scheduleDiagnosticsPull();
			},
			onWorkspaceChanged: () => {
				/* informational only; workspace comes from lockfile for discovery */
			},
			onAtMentioned: (m) => this.events.onAtMentioned(m),
			onClose: () => {
				this.client = null;
				this.lastInjection = null;
				this.events.onSelectionStatus(null);
				this.events.onStatus("IDE bridge disconnected");
				this.scheduleReconnect();
			},
		});
		this.client = client;
		try {
			const ide = await client.connect();
			this.reconnectAttempt = 0;
			this.lastInjection = null;
			this.events.onStatus(`IDE bridge connected: ${ide.ideName} ${ide.ideVersion}`);
			await this.pullInitialState(client);
			this.events.onSelectionStatus(this.effectiveSelection());
			return true;
		} catch {
			if (this.client === client) this.client = null;
			if (!this.stopped) this.scheduleReconnect();
			return false;
		}
	}

	private async pullInitialState(client: BridgeClient): Promise<void> {
		const safe = async (fn: () => Promise<unknown>) => {
			try {
				return await fn();
			} catch {
				return null;
			}
		};
		const editors = await safe(() => client.call("getOpenEditors"));
		if (editors !== null) {
			this.editors = readField(editors, "editors", editorList);
		}
		const selRes = await safe(() => client.call("getLatestSelection"));
		const sel = selRes === null ? null : readField(selRes, "selection", selectionOrNull);
		if (sel !== null) {
			this.latestSelection = sel;
			this.currentSelection = sel;
		}
		if (client.ide?.capabilities.diagnostics) {
			const diags = await safe(() => client.call("getDiagnostics"));
			if (diags !== null) {
				this.rebuildDiagnostics(readField(diags, "diagnostics", diagnosticList));
			}
		}
	}

	private scheduleDiagnosticsPull(): void {
		if (this.diagPullTimer) return;
		this.diagPullTimer = setTimeout(() => {
			this.diagPullTimer = null;
			const client = this.client;
			if (!client?.connected || !client.ide?.capabilities.diagnostics) return;
			client
				.call("getDiagnostics")
				.then((res) => {
					this.rebuildDiagnostics(readField(res, "diagnostics", diagnosticList));
				})
				.catch(() => {
					/* connection tearing down; next change re-triggers */
				});
		}, DIAG_PULL_DEBOUNCE_MS);
	}

	private rebuildDiagnostics(diags: Diagnostic[]): void {
		this.diagnostics.clear();
		for (const d of diags) {
			const list = this.diagnostics.get(d.uri) ?? [];
			list.push(d);
			this.diagnostics.set(d.uri, list);
		}
	}
}
