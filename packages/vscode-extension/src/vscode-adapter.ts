/**
 * IdeAdapter implementation backed by the `vscode` extension API.
 *
 * Wire boundary: all uris exposed to the protocol core are `file://` URIs
 * (via vscode.Uri.toString()); incoming uris are parsed back with
 * vscode.Uri.parse / Uri.file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type {
  Diagnostic,
  DiagnosticSeverity,
  Editor,
  IdeAdapter,
  OpenDiffParams,
  OpenDiffResult,
  OpenFileParams,
  Selection,
  Unsubscribe,
} from './adapter';

const SEVERITY_BY_VSCODE: Record<vscode.DiagnosticSeverity, DiagnosticSeverity> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'information',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

export class VscodeAdapter implements IdeAdapter {
  private latestSelection: Selection | null = null;

  // ------------------------------------------------------------ methods

  getWorkspaceFolders(): { folders: string[] } {
    return { folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()) };
  }

  getOpenEditors(): { editors: Editor[] } {
    // One entry per open text tab; isActive = active tab of the active group.
    const byUri = new Map<string, boolean>();
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri.toString();
          const isActive = group === activeGroup && group.activeTab === tab;
          byUri.set(uri, (byUri.get(uri) ?? false) || isActive);
        }
      }
    }
    return { editors: [...byUri].map(([uri, isActive]) => ({ uri, isActive })) };
  }

  getCurrentSelection(): { selection: Selection | null } {
    return { selection: this.currentSelection() };
  }

  getLatestSelection(): { selection: Selection | null } {
    return { selection: this.latestSelection };
  }

  getDiagnostics(uri?: string): { diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    for (const [u, diags] of vscode.languages.getDiagnostics()) {
      const wire = u.toString();
      if (uri !== undefined && wire !== uri) continue;
      for (const d of diags) {
        diagnostics.push({
          uri: wire,
          range: {
            start: { line: d.range.start.line, character: d.range.start.character },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
          severity: SEVERITY_BY_VSCODE[d.severity] ?? 'information',
          message: d.message,
          source: d.source ?? null,
        });
      }
    }
    return { diagnostics };
  }

  async openFile(params: OpenFileParams): Promise<{ opened: true }> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(params.uri));
    const opts: vscode.TextDocumentShowOptions = { preview: params.preview ?? false };
    if (params.line !== undefined) {
      const pos = new vscode.Position(params.line, params.character ?? 0);
      opts.selection = new vscode.Range(pos, pos);
    }
    await vscode.window.showTextDocument(doc, opts);
    return { opened: true };
  }

  checkDocumentDirty(uri: string): { isDirty: boolean } {
    return { isDirty: this.findDocument(uri)?.isDirty ?? false };
  }

  async saveDocument(uri: string): Promise<{ saved: boolean }> {
    const doc = this.findDocument(uri);
    if (!doc) return { saved: false };
    return { saved: await doc.save() };
  }

  async closeTab(uri: string): Promise<{ closed: boolean }> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri) {
          return { closed: await vscode.window.tabGroups.close(tab) };
        }
      }
    }
    return { closed: false };
  }

  async openDiff(params: OpenDiffParams): Promise<OpenDiffResult> {
    // Write newText to a temp file (same extension for syntax highlighting),
    // then open a vscode.diff of original vs modified.
    let ext = '';
    try {
      ext = path.extname(fileURLToPath(params.uri));
    } catch {
      /* keep empty ext */
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-diff-'));
    const tmpPath = path.join(dir, `modified${ext}`);
    fs.writeFileSync(tmpPath, params.newText);
    const original = vscode.Uri.parse(params.uri);
    const modified = vscode.Uri.file(tmpPath);
    const tabName = params.tabName ?? `${path.basename(original.path)} ↔ proposed changes`;
    await vscode.commands.executeCommand('vscode.diff', original, modified, tabName);

    const { promise, resolve } = Promise.withResolvers<OpenDiffResult>();
    let saved = false;
    let finalText: string | undefined;
    let settled = false;
    const modifiedKey = modified.toString();
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const settle = (result: OpenDiffResult) => {
      if (settled) return;
      settled = true;
      saveSub.dispose();
      closeSub.dispose();
      cleanup();
      resolve(result);
    };
    const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() === modifiedKey) {
        saved = true;
        finalText = doc.getText();
      }
    });
    const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.toString() === modifiedKey) {
        settle(saved ? { status: 'accepted', ...(finalText !== undefined ? { finalText } : {}) } : { status: 'rejected' });
      }
    });
    return promise;
  }

  // ------------------------------------------------------------ events

  onSelectionChanged(cb: (selection: Selection | null) => void): Unsubscribe {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb(this.currentSelection()), 150);
    };
    const subs = [
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const sel = this.selectionFromEditor(e.textEditor);
        if (sel && sel.text.length > 0) this.latestSelection = sel; // survives focus loss
        emit();
      }),
      // Focus moved to another editor / no editor → report current (possibly null).
      vscode.window.onDidChangeActiveTextEditor(() => emit()),
    ];
    return () => {
      clearTimeout(timer);
      for (const s of subs) s.dispose();
    };
  }

  onEditorsChanged(cb: (editors: Editor[]) => void): Unsubscribe {
    const fire = () => cb(this.getOpenEditors().editors);
    const subs = [
      vscode.window.tabGroups.onDidChangeTabs(fire),
      vscode.window.onDidChangeActiveTextEditor(fire),
    ];
    return () => {
      for (const s of subs) s.dispose();
    };
  }

  onDiagnosticsChanged(cb: (uris: string[]) => void): Unsubscribe {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      for (const u of e.uris) pending.add(u.toString());
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Coarse hint, restricted to uris of currently open editors.
        const open = new Set(this.getOpenEditors().editors.map((ed) => ed.uri));
        const uris = [...pending].filter((u) => open.has(u));
        pending.clear();
        if (uris.length > 0) cb(uris);
      }, 500);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }

  onWorkspaceChanged(cb: (folders: string[]) => void): Unsubscribe {
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => cb(this.getWorkspaceFolders().folders));
    return () => sub.dispose();
  }

  // ------------------------------------------------------------ private

  private currentSelection(): Selection | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    return this.selectionFromEditor(editor);
  }

  private selectionFromEditor(editor: vscode.TextEditor): Selection {
    const s = editor.selection;
    return {
      uri: editor.document.uri.toString(),
      start: { line: s.start.line, character: s.start.character },
      end: { line: s.end.line, character: s.end.character },
      text: editor.document.getText(s),
    };
  }

  private findDocument(uri: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  }
}
