# OMP IDE Bridge Protocol v1

Wire protocol between an IDE plugin (VS Code family / JetBrains) and the OMP
coding-agent extension. Modeled on Claude Code's terminal-mode IDE bridge:
**the IDE is the WebSocket server, the agent (OMP) is the client.**

```
┌────────────────────┐   discovers via lockfile    ┌─────────────────────┐
│  OMP (TUI client)  │ ──────────────────────────▶ │  IDE plugin (WS     │
│  omp-extension     │   ws://127.0.0.1:<port>     │  server, per window)│
│                    │ ◀────────────────────────── │  ~/.omp/ide/        │
│  JSON-RPC requests │   notifications             │  <port>.lock        │
└────────────────────┘                             └─────────────────────┘
```

## 1. Discovery (lockfile)

- Directory: `~/.omp/ide/` (created by the IDE plugin; POSIX mode 0700,
  current-user profile ACL on Windows).
- One file per IDE window: `<port>.lock` (POSIX mode 0600, UTF-8 JSON):

```json
{
  "pid": 12345,
  "workspaceFolders": ["/abs/path/one", "/abs/path/two"],
  "ideName": "VS Code",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

- Port number = filename stem. Random in `[10000, 65535]`, bound to `127.0.0.1` only.
- The IDE plugin MUST delete its lockfile on window close / deactivate.
- The OMP client MUST treat a lockfile as stale when `pid` is not alive
  (`process.kill(pid, 0)` throws ESRCH) and SHOULD delete it.
- Client selection order:
  1. `OMP_IDE_PORT` env var, if set (IDE injects it into new integrated terminals).
  2. Lockfiles whose `workspaceFolders` contains the agent cwd (path prefix on a
     path-segment boundary; case-insensitive only on win32/darwin default FS).
  3. Most-recently-mtime wins among matches.

## 2. Connection & handshake

- Client connects to `ws://127.0.0.1:<port>/` with HTTP header
  `x-omp-ide-authorization: <authToken>`. Server closes with code **1008** on mismatch.
- Immediately after connect, client sends `initialize`; server replies with identity
  and capabilities. `protocolVersion` is `1`; a client MUST NOT use methods the
  server did not advertise.
- A client MUST reject an `initialize` result whose `protocolVersion` it does not support.
- The server MUST reject methods other than `initialize` until that connection initializes.

```jsonc
// → request
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"clientName":"omp","clientVersion":"0.1.0","pid":4242}}
// ← result
{"jsonrpc":"2.0","id":1,"result":{
  "ideName":"VS Code","ideVersion":"1.96.0","protocolVersion":1,
  "capabilities":{"openDiff":true,"diagnostics":true,"executeCode":false}}}
```

- Either side may send `shutdown` (notification) before closing the socket.
- Client reconnect policy: rescan lockfiles and retry with backoff
  1s → 2s → 5s → 10s (capped), indefinitely while the session lives.

## 3. Data types

All messages are JSON-RPC 2.0. `id` is a monotonically increasing integer per connection.
Unsupported/unknown method → error `-32601`. Invalid params → `-32602`.
- Implementations MUST reject incoming messages larger than 16 MiB. WebSocket close
  code `1009` is used when the transport supports early payload rejection.

```
Position  = { "line": uint, "character": uint }          // 0-based, LSP-style
Range     = { "start": Position, "end": Position }
Selection = { "uri": "file:///abs/path", "start": Position,
              "end": Position, "text": string }          // text may be "" for caret-only
Editor    = { "uri": string, "isActive": boolean }
Diagnostic= { "uri": string, "range": Range,
              "severity": "error"|"warning"|"information"|"hint",
              "message": string, "source": string|null }
```

- All `uri` values are `file://` URIs (POSIX separators; win32 drive letters as
  `file:///C:/...`). Plugins convert to/from native paths.

## 4. Methods (client → server)

| Method | Params | Result |
|---|---|---|
| `initialize` | `{clientName, clientVersion, pid}` | `{ideName, ideVersion, protocolVersion, capabilities}` |
| `getWorkspaceFolders` | — | `{folders: uri[]}` |
| `getOpenEditors` | — | `{editors: Editor[]}` |
| `getCurrentSelection` | — | `{selection: Selection\|null}` |
| `getLatestSelection` | — | `{selection: Selection\|null}` (last non-empty, survives focus loss) |
| `getDiagnostics` | `{uri?}` | `{diagnostics: Diagnostic[]}` (all open editors when `uri` omitted; capability `diagnostics`) |
| `openFile` | `{uri, line?, character?, preview?}` | `{opened: true}` |
| `checkDocumentDirty` | `{uri}` | `{isDirty: boolean}` |
| `saveDocument` | `{uri}` | `{saved: boolean}` |
| `closeTab` | `{uri}` | `{closed: boolean}` |
| `openDiff` | `{uri, newText, tabName?}` | `{status: "accepted"\|"rejected", finalText?}` (capability `openDiff`; resolves when the user closes the diff: accepted = saved, rejected = closed without save) |

## 5. Notifications (server → client)

| Method | Params | Meaning |
|---|---|---|
| `selection_changed` | `{selection: Selection\|null}` | Debounced ≤150 ms; `null` when nothing selected/focused |
| `editors_changed` | `{editors: Editor[]}` | Tab opened/closed/activated |
| `diagnostics_changed` | `{uris: uri[]}` | Coarse hint; client re-pulls `getDiagnostics` lazily |
| `workspace_changed` | `{folders: uri[]}` | Folder added/removed |
| `at_mentioned` | `{selection: Selection\|null, text: string}` | User invoked "Mention to OMP" in the IDE; `text` is preformatted |
| `shutdown` | `{}` | IDE window is going away |

## 6. OMP-side behavior (normative for the extension)

- On `session_start`: scan/connect. On WS close: cleanup + reconnect policy (§2).
- Cache server state: open editors, latest selection, per-uri diagnostics (pulled lazily
  after `diagnostics_changed`, TTL 5s to coalesce bursts).
- On `before_agent_start`: inject one custom message (see format below) when
  (a) first turn after connect, or (b) the rendered payload differs from the last injection.
- `at_mentioned` → `pi.sendMessage({customType:"ide-mention", content:text, display:true,
  attribution:"user"}, {deliverAs:"nextTurn", triggerTurn:false})`.
- Tools registered while connected (deregistered/stubbed when not):
  `ide_get_editor_context`, `ide_open_file`, `ide_get_diagnostics`,
  `ide_save_document`, plus `ide_open_diff` iff capability.
- Tool boundary convention: positions exposed TO and accepted FROM the model are
  the wire-native 0-based LSP values, passed through unconverted (matching model
  priors: presenting line+1 is then the model's own, correct conversion).
  Results carry `positionConvention: "0-based (LSP)"`.
- `/ide` command: no args → status + discovered IDEs; `/ide <n>` → connect to n-th;
  `/ide off` → disconnect.

### Injected message format

```
<ide-context source="<ideName>">
Active file: /abs/path.ts (selection lines 12-34)
<selection language="ts">
<selected text, hard-capped at 2000 chars>
</selection>
Open tabs: a.ts, src/b.ts (max 10, cwd-relative when possible)
Diagnostics: 2 errors, 1 warning
- path.ts:12:5 error message…        (max 10 items)
</ide-context>
```

Omit empty sections; inject nothing when there is no active file, no selection,
and no diagnostics. `display: false`, `attribution: "ide"`, `customType: "ide-context"`.
