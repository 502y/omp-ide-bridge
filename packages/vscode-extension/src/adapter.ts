/**
 * Host-IDE adapter interface for the OMP IDE bridge.
 *
 * The protocol core (`server.ts`) depends only on this interface, never on a
 * concrete IDE API, so it can be driven by a fake adapter in tests.
 *
 * All `uri` values are `file://` URIs (protocol v1 §3).
 */

export interface Position {
  line: number; // 0-based
  character: number; // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Selection {
  uri: string;
  start: Position;
  end: Position;
  text: string; // may be "" for caret-only
}

export interface Editor {
  uri: string;
  isActive: boolean;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface Diagnostic {
  uri: string;
  range: Range;
  severity: DiagnosticSeverity;
  message: string;
  source: string | null;
}

export type DiffStatus = 'accepted' | 'rejected';
export type Unsubscribe = () => void;
export type MaybePromise<T> = T | Promise<T>;

export interface OpenFileParams {
  uri: string;
  line?: number;
  character?: number;
  preview?: boolean;
}

export interface OpenDiffParams {
  uri: string;
  newText: string;
  tabName?: string;
}

export interface OpenDiffResult {
  status: DiffStatus;
  finalText?: string;
}

/**
 * Mirrors protocol v1 methods (§4). Each method returns the *result payload*
 * of the corresponding JSON-RPC method; `initialize` is handled by the server
 * itself and is not part of the adapter.
 */
export interface IdeAdapter {
  getWorkspaceFolders(): MaybePromise<{ folders: string[] }>;
  getOpenEditors(): MaybePromise<{ editors: Editor[] }>;
  getCurrentSelection(): MaybePromise<{ selection: Selection | null }>;
  /** Last non-empty selection; survives focus loss. */
  getLatestSelection(): MaybePromise<{ selection: Selection | null }>;
  /** Diagnostics for `uri`, or for all open editors when omitted. */
  getDiagnostics(uri?: string): MaybePromise<{ diagnostics: Diagnostic[] }>;
  openFile(params: OpenFileParams): MaybePromise<{ opened: true }>;
  checkDocumentDirty(uri: string): MaybePromise<{ isDirty: boolean }>;
  saveDocument(uri: string): MaybePromise<{ saved: boolean }>;
  closeTab(uri: string): MaybePromise<{ closed: boolean }>;
  /**
   * Resolves when the user closes the diff: `accepted` when the modified
   * document was saved before close, `rejected` otherwise.
   */
  openDiff(params: OpenDiffParams): Promise<OpenDiffResult>;

  /** Debounced by the adapter (≤150 ms); `null` when nothing selected/focused. */
  onSelectionChanged(cb: (selection: Selection | null) => void): Unsubscribe;
  onEditorsChanged(cb: (editors: Editor[]) => void): Unsubscribe;
  /** Coarse hint (uris only); debounced by the adapter (≤500 ms). */
  onDiagnosticsChanged(cb: (uris: string[]) => void): Unsubscribe;
  onWorkspaceChanged(cb: (folders: string[]) => void): Unsubscribe;
}
