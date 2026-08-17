/**
 * Smoke test for the OMP IDE bridge protocol core.
 *
 * Imports the BUILT standalone server bundle (dist/server.js — run
 * `npm run compile` first), starts an IdeBridgeServer with a fake in-memory
 * IdeAdapter, and drives it with a real `ws` client. Exits non-zero on any
 * failed assertion.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { IdeBridgeServer } = require('../dist/server.js');

const FAKE_WORKSPACE_PATH = path.join(os.tmpdir(), 'omp-fake');
const FAKE_WORKSPACE_URI = pathToFileURL(FAKE_WORKSPACE_PATH).href;
const FIRST_FILE_URI = pathToFileURL(path.join(FAKE_WORKSPACE_PATH, 'a.ts')).href;
const SECOND_FILE_URI = pathToFileURL(path.join(FAKE_WORKSPACE_PATH, 'b.ts')).href;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function makeFakeAdapter() {
  const handlers = {};
  const state = {
    folders: [FAKE_WORKSPACE_URI],
    editors: [
      { uri: FIRST_FILE_URI, isActive: true },
      { uri: SECOND_FILE_URI, isActive: false },
    ],
    selection: {
      uri: FIRST_FILE_URI,
      start: { line: 1, character: 2 },
      end: { line: 3, character: 4 },
      text: 'const x = 1;',
    },
    diagnostics: [
      {
        uri: FIRST_FILE_URI,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 'error',
        message: 'boom',
        source: 'fake',
      },
      {
        uri: SECOND_FILE_URI,
        range: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } },
        severity: 'warning',
        message: 'meh',
        source: null,
      },
    ],
    dirty: true,
    calls: [],
  };
  return {
    state,
    handlers,
    getWorkspaceFolders: () => ({ folders: state.folders }),
    getOpenEditors: () => ({ editors: state.editors }),
    getCurrentSelection: () => ({ selection: state.selection }),
    getLatestSelection: () => ({ selection: state.selection }),
    getDiagnostics: (uri) => ({
      diagnostics: uri ? state.diagnostics.filter((d) => d.uri === uri) : state.diagnostics,
    }),
    openFile: async (params) => {
      state.calls.push(['openFile', params]);
      return { opened: true };
    },
    checkDocumentDirty: (uri) => {
      state.calls.push(['checkDocumentDirty', uri]);
      return { isDirty: state.dirty };
    },
    saveDocument: async (uri) => {
      state.calls.push(['saveDocument', uri]);
      return { saved: true };
    },
    closeTab: async (uri) => {
      state.calls.push(['closeTab', uri]);
      return { closed: true };
    },
    openDiff: async (params) => {
      state.calls.push(['openDiff', params]);
      return { status: 'accepted', finalText: params.newText };
    },
    onSelectionChanged: (cb) => ((handlers.selection = cb), () => {}),
    onEditorsChanged: (cb) => ((handlers.editors = cb), () => {}),
    onDiagnosticsChanged: (cb) => ((handlers.diagnostics = cb), () => {}),
    onWorkspaceChanged: (cb) => ((handlers.workspace = cb), () => {}),
  };
}

function connect(port, token) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { 'x-omp-ide-authorization': token },
  });
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 5000).unref();
  return promise;
}

/** JSON-RPC client over a ws socket: send request, await matching response. */
function makeRpc(ws) {
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        entry(msg);
      }
    } else if (msg.method) {
      notifications.push(msg);
      for (const w of waiters.splice(0)) w();
    }
  });
  const waitNotification = (method, timeoutMs = 3000) => {
    const found = notifications.find((n) => n.method === method);
    if (found) return Promise.resolve(found);
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    const poll = () => {
      const hit = notifications.find((n) => n.method === method);
      if (hit) {
        clearTimeout(timer);
        resolve(hit);
      } else {
        waiters.push(poll);
      }
    };
    waiters.push(poll);
    return promise;
  };
  const call = (id, method, params) => {
    const { promise, resolve } = Promise.withResolvers();
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    return promise;
  };
  return { call, waitNotification };
}

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ide-lock-'));

async function main() {
  const adapter = makeFakeAdapter();
  const server = new IdeBridgeServer({
    adapter,
    ideName: 'Visual Studio Code',
    ideVersion: '1.96.0',
    capabilities: { openDiff: true, diagnostics: true, executeCode: false },
    lockDir,
  });
  const port = await server.start();
  console.log(`server listening on 127.0.0.1:${port}`);

  // --- lockfile shape + modes -------------------------------------------
  const lockPath = path.join(lockDir, `${port}.lock`);
  check('lockfile exists', fs.existsSync(lockPath));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  check('lockfile pid', lock.pid === process.pid);
  check('lockfile workspaceFolders are native paths', JSON.stringify(lock.workspaceFolders) === JSON.stringify([FAKE_WORKSPACE_PATH]), JSON.stringify(lock.workspaceFolders));
  check('lockfile ideName', lock.ideName === 'Visual Studio Code');
  check('lockfile transport', lock.transport === 'ws');
  check('lockfile runningInWindows is boolean', typeof lock.runningInWindows === 'boolean');
  check('lockfile authToken is uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lock.authToken), lock.authToken);
  if (process.platform === 'win32') {
    check('lockfile is a regular file', fs.statSync(lockPath).isFile());
    check('lock dir is a directory', fs.statSync(lockDir).isDirectory());
  } else {
    check('lockfile mode 0600', (fs.statSync(lockPath).mode & 0o777) === 0o600, (fs.statSync(lockPath).mode & 0o777).toString(8));
    check('lock dir mode 0700', (fs.statSync(lockDir).mode & 0o777) === 0o700, (fs.statSync(lockDir).mode & 0o777).toString(8));
  }

  // --- wrong token → close 1008 ------------------------------------------
  {
    const { promise, resolve, reject } = Promise.withResolvers();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { 'x-omp-ide-authorization': 'wrong-token' },
    });
    ws.once('close', (code) => (code === 1008 ? resolve(code) : reject(new Error(`expected 1008, got ${code}`))));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('timeout waiting for 1008 close')), 5000).unref();
    try {
      await promise;
      check('wrong-token upgrade rejected with 1008', true);
    } catch (err) {
      check('wrong-token upgrade rejected with 1008', false, err.message);
    }
  }

  // --- client 1: initialize + methods ------------------------------------
  {
    const uninitializedSocket = await connect(port, lock.authToken);
    const uninitializedRpc = makeRpc(uninitializedSocket);
    const response = await uninitializedRpc.call(1, 'getOpenEditors');
    check('methods require initialize', response.error?.code === -32602, JSON.stringify(response));
    uninitializedSocket.close();
    await new Promise((resolve) => uninitializedSocket.once('close', resolve));
  }
  const ws1 = await connect(port, lock.authToken);
  const rpc1 = makeRpc(ws1);
  {
    const res = await rpc1.call(1, 'initialize', { clientName: 'omp-smoke', clientVersion: '0.0.0', pid: process.pid });
    check('initialize result ideName', res.result?.ideName === 'Visual Studio Code');
    check('initialize result ideVersion', res.result?.ideVersion === '1.96.0');
    check('initialize result protocolVersion', res.result?.protocolVersion === 1);
    check(
      'initialize result capabilities',
      JSON.stringify(res.result?.capabilities) === JSON.stringify({ openDiff: true, diagnostics: true, executeCode: false }),
      JSON.stringify(res.result?.capabilities),
    );
  }
  {
    const res = await rpc1.call(2, 'getWorkspaceFolders');
    check('getWorkspaceFolders', JSON.stringify(res.result) === JSON.stringify({ folders: adapter.state.folders }));
  }
  {
    const res = await rpc1.call(3, 'getCurrentSelection');
    check('getCurrentSelection matches adapter', JSON.stringify(res.result) === JSON.stringify({ selection: adapter.state.selection }));
  }
  {
    const res = await rpc1.call(4, 'getOpenEditors');
    check('getOpenEditors matches adapter', JSON.stringify(res.result) === JSON.stringify({ editors: adapter.state.editors }));
  }
  {
    const res = await rpc1.call(5, 'getDiagnostics');
    check('getDiagnostics (all) matches adapter', JSON.stringify(res.result) === JSON.stringify({ diagnostics: adapter.state.diagnostics }));
    const resFiltered = await rpc1.call(6, 'getDiagnostics', { uri: SECOND_FILE_URI });
    check(
      'getDiagnostics (uri filter)',
      JSON.stringify(resFiltered.result) === JSON.stringify({ diagnostics: [adapter.state.diagnostics[1]] }),
    );
  }
  {
    const res = await rpc1.call(7, 'openFile', { uri: FIRST_FILE_URI, line: 4, character: 2 });
    check('openFile result', JSON.stringify(res.result) === JSON.stringify({ opened: true }));
    const call = adapter.state.calls.find(([n]) => n === 'openFile');
    check('openFile params forwarded', call && call[1].uri === FIRST_FILE_URI && call[1].line === 4 && call[1].character === 2, JSON.stringify(call));
  }
  {
    const res = await rpc1.call(8, 'checkDocumentDirty', { uri: FIRST_FILE_URI });
    check('checkDocumentDirty', JSON.stringify(res.result) === JSON.stringify({ isDirty: true }));
  }
  {
    const res = await rpc1.call(9, 'saveDocument', { uri: FIRST_FILE_URI });
    check('saveDocument', JSON.stringify(res.result) === JSON.stringify({ saved: true }));
  }
  {
    const res = await rpc1.call(10, 'getLatestSelection');
    check('getLatestSelection matches adapter', JSON.stringify(res.result) === JSON.stringify({ selection: adapter.state.selection }));
  }
  {
    const res = await rpc1.call(11, 'openFile', { line: 'x' });
    check('invalid params → -32602', res.error?.code === -32602, JSON.stringify(res));
  }
  {
    const res = await rpc1.call(12, 'no.such.method');
    check('unknown method → -32601', res.error?.code === -32601, JSON.stringify(res));
  }
  {
    const res = await rpc1.call(13, 'executeCode', { code: '1+1' });
    check('executeCode (unadvertised) → -32601', res.error?.code === -32601, JSON.stringify(res));
  }

  // --- adapter event → notification ---------------------------------------
  {
    const newSel = { ...adapter.state.selection, text: 'updated text' };
    const p = rpc1.waitNotification('selection_changed');
    adapter.handlers.selection(newSel);
    const n = await p;
    check('selection_changed notification received', JSON.stringify(n.params) === JSON.stringify({ selection: newSel }), JSON.stringify(n.params));
  }

  // --- second concurrent client -------------------------------------------
  const ws2 = await connect(port, lock.authToken);
  const rpc2 = makeRpc(ws2);
  {
    const res = await rpc2.call(1, 'initialize', { clientName: 'omp-smoke-2', clientVersion: '0.0.0', pid: process.pid });
    check('client 2 initialize', res.result?.protocolVersion === 1);
    check('server sees 2 clients', server.clientCount === 2, String(server.clientCount));
    const res2 = await rpc2.call(2, 'getOpenEditors');
    check('client 2 getOpenEditors', JSON.stringify(res2.result) === JSON.stringify({ editors: adapter.state.editors }));
    // broadcast reaches both initialized clients (waiters armed before trigger)
    const p1 = rpc1.waitNotification('editors_changed');
    const p2 = rpc2.waitNotification('editors_changed');
    adapter.handlers.editors(adapter.state.editors);
    const [m1, m2] = await Promise.all([p1, p2]);
    check('broadcast reaches client 1', m1.method === 'editors_changed');
    check('broadcast reaches client 2', m2.method === 'editors_changed');
  }

  // --- stop: lockfile deleted ---------------------------------------------
  ws2.close();
  await new Promise((r) => ws2.once('close', r));
  await server.stop();
  check('lockfile deleted on stop', !fs.existsSync(lockPath));
  await new Promise((r) => ws1.once('close', r)); // server closed client 1

  fs.rmSync(lockDir, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nsmoke OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  fs.rmSync(lockDir, { recursive: true, force: true });
  process.exit(1);
});
