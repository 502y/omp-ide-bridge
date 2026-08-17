/**
 * Cross-test fixture: runs the BUILT VS Code extension server core under
 * plain Node (the production runtime of the VS Code extension host), while
 * the Bun-side OmpIdeBridge client connects to it.
 *
 * Usage: node vs-server-runner.mjs <path-to-dist/server.js> <lockDir> <projectPath>
 * Control channel: newline-delimited JSON on stdin —
 *   {"set": {"selection"?: ..., "diagnostics"?: ..., "editors"?: ...}}
 *   {"fire": "selection"|"editors"|"diagnostics"|"workspace", "arg": ...}
 *   {"stop": true}
 * Prints one line to stdout when ready: READY <port>
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { IdeBridgeServer } = require(process.argv[2]);
const lockDir = process.argv[3];
const projectRootPath = process.argv[4];
if (!projectRootPath) throw new Error('projectPath argument is required');
const projectRootUri = pathToFileURL(projectRootPath).href;
const firstFileUri = pathToFileURL(join(projectRootPath, 'src', 'a.ts')).href;
const secondFileUri = pathToFileURL(join(projectRootPath, 'src', 'b.ts')).href;

const state = {
  editors: [
    { uri: firstFileUri, isActive: true },
    { uri: secondFileUri, isActive: false },
  ],
  selection: {
    uri: firstFileUri,
    start: { line: 4, character: 0 },
    end: { line: 6, character: 2 },
    text: 'export const answer = 42;',
  },
  diagnostics: [
    {
      uri: firstFileUri,
      range: { start: { line: 4, character: 6 }, end: { line: 4, character: 12 } },
      severity: 'error',
      message: 'unused constant',
      source: 'eslint',
    },
  ],
};

const listeners = new Map();
const on = (name) => (cb) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
};

const adapter = {
  getWorkspaceFolders: () => ({ folders: [projectRootUri] }),
  getOpenEditors: () => ({ editors: state.editors }),
  getCurrentSelection: () => ({ selection: state.selection }),
  getLatestSelection: () => ({ selection: state.selection }),
  getDiagnostics: (uri) => ({
    diagnostics: uri ? state.diagnostics.filter((d) => d.uri === uri) : state.diagnostics,
  }),
  openFile: () => ({ opened: true }),
  checkDocumentDirty: () => ({ isDirty: false }),
  saveDocument: () => ({ saved: true }),
  closeTab: () => ({ closed: true }),
  openDiff: (params) => ({ status: 'accepted', finalText: params?.newText ?? '' }),
  onSelectionChanged: on('selection'),
  onEditorsChanged: on('editors'),
  onDiagnosticsChanged: on('diagnostics'),
  onWorkspaceChanged: on('workspace'),
};

const server = new IdeBridgeServer({
  adapter,
  ideName: 'FakeCode',
  ideVersion: '9.9.9',
  capabilities: { openDiff: true, diagnostics: true, executeCode: false },
  lockDir,
});

const port = await server.start();
console.log('READY', port);

let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (cmd.set) Object.assign(state, cmd.set);
    if (cmd.fire) listeners.get(cmd.fire)?.(cmd.arg);
    if (cmd.stop) {
      await server.stop();
      process.exit(0);
    }
  }
});
