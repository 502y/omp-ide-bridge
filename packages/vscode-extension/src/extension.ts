/**
 * Extension entry point: wires the protocol core to the VS Code adapter,
 * manages the lockfile, the OMP_IDE_PORT env var for new integrated terminals,
 * the mention command, and the status bar item.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { Selection } from './adapter';
import { IdeBridgeServer } from './server';
import { VscodeAdapter } from './vscode-adapter';

let server: IdeBridgeServer | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  const adapter = new VscodeAdapter();
  server = new IdeBridgeServer({
    adapter,
    ideName: vscode.env.appName, // "Visual Studio Code", "Cursor", ...
    ideVersion: vscode.version,
    capabilities: { openDiff: true, diagnostics: true, executeCode: false },
  });
  const port = await server.start(); // writes ~/.omp/ide/<port>.lock after listening

  // New integrated terminals auto-discover this window.
  context.environmentVariableCollection.replace('OMP_IDE_PORT', String(port));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const updateStatus = () => {
    const n = server?.clientCount ?? 0;
    status.text = `$(plug) OMP: ${n}`;
    status.tooltip = `OMP IDE Bridge — port ${port}, ${n} client${n === 1 ? '' : 's'} connected`;
  };
  updateStatus();
  status.show();
  const connSub = server.onClientCountChanged(updateStatus);

  const mentionCmd = vscode.commands.registerCommand('omp-ide-bridge.mentionSelection', () => {
    const selection = adapter.getCurrentSelection().selection;
    if (!selection || selection.text.length === 0 || !server) {
      void vscode.window.showInformationMessage('OMP: no text selected to mention');
      return;
    }
    server.broadcast('at_mentioned', { selection, text: formatMention(selection) });
  });

  context.subscriptions.push(status, mentionCmd, { dispose: () => connSub() });
}

export async function deactivate(): Promise<void> {
  extensionContext?.environmentVariableCollection.clear();
  extensionContext = undefined;
  await server?.stop(); // closes server, deletes lockfile, broadcasts shutdown
  server = undefined;
}

/** file path + line range + fenced code block (protocol §5 at_mentioned). */
function formatMention(sel: Selection): string {
  let filePath = sel.uri;
  try {
    filePath = fileURLToPath(sel.uri);
  } catch {
    /* keep uri form */
  }
  const startLine = sel.start.line + 1;
  const endLine = sel.end.line + 1;
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  const lang = path.extname(filePath).replace(/^\./, '');
  return `${filePath} (${range})\n\`\`\`${lang}\n${sel.text}\n\`\`\``;
}
