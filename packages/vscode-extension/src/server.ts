/**
 * Protocol core for the OMP IDE bridge (protocol v1).
 *
 * ZERO vscode imports — the host IDE is reached exclusively through the
 * `IdeAdapter` interface, so this module is fully testable with a fake adapter.
 *
 * Owns:
 *  - WebSocketServer bound to 127.0.0.1, random port in [10000, 65535] (≤20 tries)
 *  - lockfile lifecycle: <lockDir>/<port>.lock (mode 0600, dir mode 0700),
 *    written after the server is listening, deleted on stop()
 *  - auth: client must send HTTP header `x-omp-ide-authorization: <authToken>`;
 *    mismatch → close code 1008
 *  - JSON-RPC 2.0 framing/dispatch (requests with id → result/error,
 *    notifications without id), per-connection state, multi-client support
 */

import { randomInt, randomUUID } from 'node:crypto';

// VS Code 1.85 embeds Node 18, which predates Promise.withResolvers (Node 22+).
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
import * as fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { IdeAdapter } from './adapter';

export const AUTH_HEADER = 'x-omp-ide-authorization';
export const PROTOCOL_VERSION = 1;

const MIN_PORT = 10000;
const MAX_PORT = 65535;
const MAX_PORT_ATTEMPTS = 20;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface Capabilities {
  openDiff: boolean;
  diagnostics: boolean;
  executeCode: boolean;
}

export interface IdeBridgeServerOptions {
  adapter: IdeAdapter;
  ideName: string;
  ideVersion: string;
  capabilities: Capabilities;
  /** Defaults to ~/.omp/ide. Overridable for tests. */
  lockDir?: string;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Conn {
  ws: WebSocket;
  initialized: boolean;
}

interface JsonRpcError {
  code: number;
  message: string;
}

export class IdeBridgeServer {
  private wss: WebSocketServer | undefined;
  private conns = new Set<Conn>();
  private unsubs: Array<() => void> = [];
  private connListeners = new Set<() => void>();
  private readonly authToken = randomUUID();
  private portValue: number | undefined;
  private lockPath: string | undefined;

  constructor(private readonly opts: IdeBridgeServerOptions) {}

  get port(): number | undefined {
    return this.portValue;
  }

  get token(): string {
    return this.authToken;
  }

  get lockFilePath(): string | undefined {
    return this.lockPath;
  }

  get clientCount(): number {
    return this.conns.size;
  }

  /** Fires whenever a client connects or disconnects. */
  onClientCountChanged(cb: () => void): () => void {
    this.connListeners.add(cb);
    return () => this.connListeners.delete(cb);
  }

  async start(): Promise<number> {
    if (this.wss) throw new Error('IdeBridgeServer already started');
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = randomInt(MIN_PORT, MAX_PORT + 1);
      try {
        await this.tryListen(port);
        this.portValue = port;
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (this.portValue === undefined) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`no free port in [${MIN_PORT}, ${MAX_PORT}] after ${MAX_PORT_ATTEMPTS} attempts`);
    }
    this.subscribeAdapterEvents();
    this.writeLockfile();
    return this.portValue;
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs.splice(0)) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    if (this.lockPath) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        /* already gone */
      }
      this.lockPath = undefined;
    }
    const wss = this.wss;
    this.wss = undefined;
    this.portValue = undefined;
    if (!wss) return;
    // Notify clients the IDE window is going away (protocol §5).
    const shutdown = JSON.stringify({ jsonrpc: '2.0', method: 'shutdown', params: {} });
    const conns = [...this.conns];
    const closes = conns.map((c) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
          c.ws.once('close', finish);
          try {
            if (c.ws.readyState === WebSocket.OPEN) c.ws.send(shutdown);
            c.ws.close();
          } catch {
            /* ignore */
          }
        setTimeout(() => {
          try {
            c.ws.terminate();
          } catch {
            /* ignore */
          }
          finish();
        }, 250).unref();
      }
      return promise;
    });
    this.conns.clear();
    this.notifyConnListeners();
    await Promise.all(closes);
    const { promise, resolve } = Promise.withResolvers<void>();
    wss.close(() => resolve());
    await promise;
  }

  /** Send a server→client notification to every connected+initialized client. */
  broadcast(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const c of this.conns) {
      if (c.initialized && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------- private

  private tryListen(port: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        maxPayload: MAX_MESSAGE_BYTES,
      });
      const onError = (err: Error) => {
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      wss.once('error', onError);
      wss.on('listening', () => {
        wss.removeListener('error', onError);
        wss.on('connection', (ws, req) => this.onConnection(ws, req));
        this.wss = wss;
        resolve();
      });
    }
    return promise;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    if (req.headers[AUTH_HEADER] !== this.authToken) {
      ws.close(1008, 'unauthorized');
      return;
    }
    const conn: Conn = { ws, initialized: false };
    this.conns.add(conn);
    this.notifyConnListeners();
    ws.on('message', (data) => {
      void this.onMessage(conn, data);
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      this.notifyConnListeners();
    });
    ws.on('error', () => {
      /* close event follows */
    });
  }

  private async onMessage(conn: Conn, data: RawData): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.sendMessage(conn, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return; // not a request/notification we serve
    const hasId = Object.prototype.hasOwnProperty.call(m, 'id') && m.id !== undefined;
    if (!hasId) return; // client→server notification (e.g. shutdown): nothing to do
    try {
      const result = await this.dispatch(conn, m.method, m.params);
      this.sendMessage(conn, { jsonrpc: '2.0', id: m.id as number | string, result });
    } catch (err) {
      const e: JsonRpcError =
        err instanceof RpcError
          ? { code: err.code, message: err.message }
          : { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
      this.sendMessage(conn, { jsonrpc: '2.0', id: m.id as number | string, error: e });
    }
  }

  private async dispatch(conn: Conn, method: string, params: unknown): Promise<unknown> {
    if (method !== 'initialize' && !conn.initialized) {
      throw new RpcError(INVALID_PARAMS, 'Client must initialize before calling other methods');
    }
    const a = this.opts.adapter;
    switch (method) {
      case 'initialize': {
        if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
          throw new RpcError(INVALID_PARAMS, 'Invalid params: expected object');
        }
        conn.initialized = true;
        this.notifyConnListeners();
        return {
          ideName: this.opts.ideName,
          ideVersion: this.opts.ideVersion,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: this.opts.capabilities,
        };
      }
      case 'getWorkspaceFolders':
        return a.getWorkspaceFolders();
      case 'getOpenEditors':
        return a.getOpenEditors();
      case 'getCurrentSelection':
        return a.getCurrentSelection();
      case 'getLatestSelection':
        return a.getLatestSelection();
      case 'getDiagnostics': {
        if (!this.opts.capabilities.diagnostics) throw new RpcError(METHOD_NOT_FOUND, 'Method not found');
        let uri: string | undefined;
        if (params !== undefined && params !== null) {
          const p = asObject(params);
          if (p.uri !== undefined) {
            if (typeof p.uri !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: uri must be a string');
            uri = p.uri;
          }
        }
        return a.getDiagnostics(uri);
      }
      case 'openFile': {
        const p = asObject(params);
        const uri = reqString(p, 'uri');
        return a.openFile({
          uri,
          line: optUint(p, 'line'),
          character: optUint(p, 'character'),
          preview: optBool(p, 'preview'),
        });
      }
      case 'checkDocumentDirty':
        return a.checkDocumentDirty(reqString(asObject(params), 'uri'));
      case 'saveDocument':
        return a.saveDocument(reqString(asObject(params), 'uri'));
      case 'closeTab':
        return a.closeTab(reqString(asObject(params), 'uri'));
      case 'openDiff': {
        if (!this.opts.capabilities.openDiff) throw new RpcError(METHOD_NOT_FOUND, 'Method not found');
        const p = asObject(params);
        const uri = reqString(p, 'uri');
        const newText = reqString(p, 'newText');
        let tabName: string | undefined;
        if (p.tabName !== undefined) {
          if (typeof p.tabName !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: tabName must be a string');
          tabName = p.tabName;
        }
        return a.openDiff({ uri, newText, tabName });
      }
      // executeCode and anything else unadvertised/unknown → -32601
      default:
        throw new RpcError(METHOD_NOT_FOUND, 'Method not found');
    }
  }

  private sendMessage(conn: Conn, msg: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  private subscribeAdapterEvents(): void {
    const a = this.opts.adapter;
    this.unsubs.push(
      a.onSelectionChanged((selection) => this.broadcast('selection_changed', { selection })),
      a.onEditorsChanged((editors) => this.broadcast('editors_changed', { editors })),
      a.onDiagnosticsChanged((uris) => this.broadcast('diagnostics_changed', { uris })),
      a.onWorkspaceChanged((folders) => this.broadcast('workspace_changed', { folders })),
    );
  }

  private writeLockfile(): void {
    const lockDir = this.opts.lockDir ?? path.join(os.homedir(), '.omp', 'ide');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(lockDir, 0o700);
    const foldersResult = this.opts.adapter.getWorkspaceFolders();
    if (foldersResult instanceof Promise) {
      throw new Error('getWorkspaceFolders must be synchronous for lockfile writing');
    }
    const workspaceFolders = foldersResult.folders.map((u) => {
      try {
        return fileURLToPath(u); // file:// URI → native absolute path
      } catch {
        return u;
      }
    });
    const content = JSON.stringify(
      {
        pid: process.pid,
        workspaceFolders,
        ideName: this.opts.ideName,
        transport: 'ws',
        runningInWindows: process.platform === 'win32',
        authToken: this.authToken,
      },
      null,
      2,
    );
    this.lockPath = path.join(lockDir, `${this.portValue}.lock`);
    fs.writeFileSync(this.lockPath, content, { mode: 0o600 });
    fs.chmodSync(this.lockPath, 0o600);
  }

  private notifyConnListeners(): void {
    for (const cb of this.connListeners) {
      try {
        cb();
      } catch {
        /* listener errors must not break the server */
      }
    }
  }
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new RpcError(INVALID_PARAMS, 'Invalid params: expected object');
  }
  return v as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new RpcError(INVALID_PARAMS, `Invalid params: ${key} must be a string`);
  return v;
}

function optUint(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RpcError(INVALID_PARAMS, `Invalid params: ${key} must be a non-negative integer`);
  }
  return v;
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new RpcError(INVALID_PARAMS, `Invalid params: ${key} must be a boolean`);
  return v;
}
