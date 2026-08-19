# OMP IDE Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

> [!CAUTION]
> **This is currently a pure Vibe Coding project.** Its code, tests,
> documentation, and visual assets have all been generated and iterated by AI
> coding agents under human direction. Automated checks pass, but the project
> has not received an independent human code or security audit. Review it
> carefully before production use.

> Unofficial community integration for [Oh My Pi](https://github.com/can1357/oh-my-pi).
> This project is not affiliated with or endorsed by the Oh My Pi maintainers.

Live IDE integration for the OMP coding agent: the agent learns **which files you
have open, what you have selected, and what the language server is reporting** on
every turn, automatically.

## Install

### IDE plugin from a marketplace

Install the IDE-side plugin first if you prefer one-click installation:

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=502y.omp-ide-bridge)
  for VS Code, Cursor, Windsurf, and other VS Code-compatible editors.
- [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/33610)
  for IntelliJ IDEA, PyCharm, WebStorm, GoLand, Rider, CLion, and other
  IntelliJ Platform IDEs (2023.1+).

### OMP side

Install from the public repository:

```sh
omp plugin install github:502y/omp-ide-bridge
```

To test a local checkout instead:

```sh
omp plugin install /absolute/path/to/omp-ide-bridge
```

### VS Code / Cursor / Windsurf from source

```sh
cd packages/vscode-extension
npm ci
npm run typecheck && npm run compile && npm run smoke
npx @vscode/vsce package
code --install-extension omp-ide-bridge-*.vsix
```

The same VSIX works in every VS Code fork. New integrated terminals get
`OMP_IDE_PORT` injected automatically; older terminals are discovered via the
lockfile scan (workspace match).

### JetBrains (IDEA, PyCharm, WebStorm, GoLand, Rider, CLion, …)

```sh
cd packages/jetbrains-plugin
./gradlew buildPlugin
./gradlew verifyPlugin
# Settings → Plugins → ⚙ → Install Plugin from Disk → build/distributions/*.zip
```

The committed Gradle wrapper uses JDK 17. Compatibility is verified against
IntelliJ IDEA Community 2023.1.7 and 2024.3.1. Runtime-only checks are tracked in
`packages/jetbrains-plugin/DEV-NOTE.md`.

```
┌─────────────────────────┐          ┌──────────────────────────┐
│  IDE (server)           │          │  OMP terminal (client)   │
│  vscode-extension /     │  ws://   │  packages/omp-extension  │
│  jetbrains-plugin       │ ◀──────▶ │                          │
│  WS server 127.0.0.1    │ JSON-RPC │  · injects <ide-context> │
│  writes ~/.omp/ide/     │          │    before every turn     │
│  <port>.lock            │          │  · ide_* tools, /ide cmd │
└─────────────────────────┘          └──────────────────────────┘
```

Wire contract: [docs/protocol.md](docs/protocol.md). Packages:

| Package | Role | Status |
|---|---|---|
| `packages/omp-extension` | OMP-side client + context injection + tools | TypeScript checks + 27 Bun integration tests |
| `packages/vscode-extension` | VS Code / Cursor / Windsurf / VSCodium server | TypeScript checks + cross-platform smoke suite |
| `packages/jetbrains-plugin` | IntelliJ-platform server (IDEA, PyCharm, …) | `buildPlugin` + verifier coverage for IC 2023.1.7 and 2024.3.1 |

## How it works

1. The IDE plugin starts a WebSocket server on `127.0.0.1` (random port 10000–65535)
   and writes `~/.omp/ide/<port>.lock` containing its PID, workspace folders, IDE
   name, and a per-window `authToken`. POSIX systems enforce directory mode `0700`
   and file mode `0600`; Windows relies on the current user's profile ACL.
2. OMP scans that directory on session start, chooses the IDE whose workspace
   contains the agent's cwd (or `$OMP_IDE_PORT` for a newly opened integrated
   terminal), and connects with the token in the
   `x-omp-ide-authorization` upgrade header.
3. Before every agent turn, the extension injects one hidden message:

   ```
   <ide-context source="VS Code">
   Active file: src/foo.ts (selection lines 12-34)
   <selection language="ts">…</selection>
   Open tabs: a.ts, src/b.ts
   Diagnostics: 2 errors, 1 warning
   - src/foo.ts:12:5 error …
   </ide-context>
   ```

   Re-injection is deduped — unchanged context costs zero tokens.
4. The IDE pushes `selection_changed` / `editors_changed` / `diagnostics_changed`
   notifications; OMP pulls diagnostics lazily (debounced).
5. Selecting code and running **"OMP: Mention Selection"** in the IDE queues the
   snippet into the next turn (`at_mentioned`).

## Usage in OMP

- Just talk — the agent sees your active file/selection each turn.
- `/ide` — connection status + discovered IDEs; `/ide 2` — connect to #2; `/ide off`.
- Tools the model can call while connected:
  `ide_get_editor_context`, `ide_open_file`, `ide_get_diagnostics`,
  `ide_save_document`, `ide_open_diff` (VS Code only; waits for accept/reject).

## Development

Prerequisites: Node.js 22+, Bun 1.3.14+, and JDK 17.

```sh
cd packages/vscode-extension
npm ci && npm run typecheck && npm run compile && npm run smoke

cd ../omp-extension
bun install --frozen-lockfile && bunx tsc --noEmit && bun test

cd ../jetbrains-plugin
./gradlew buildPlugin verifyPlugin
```

CI runs the TypeScript suites on Windows, macOS, and Linux, and verifies the
JetBrains plugin on Linux.

## Security and privacy

- The server binds only to `127.0.0.1`.
- Every IDE window generates a random authentication token.
- Incoming WebSocket messages are capped at 16 MiB.
- No telemetry or remote service calls are implemented.
- Selected text and diagnostics are sent only to the locally running OMP process;
  OMP's configured model provider may then receive them as part of the agent context.
- `executeCode` is intentionally unsupported.

See [SECURITY.md](SECURITY.md) for reporting and threat-model details.

## Design lineage

The architecture is inspired by terminal-mode IDE bridges: IDE as a loopback
WebSocket server, lockfile discovery, and authenticated JSON-RPC. This project is
an independent community implementation for OMP and uses its own namespace:
`~/.omp/ide/`, `OMP_IDE_PORT`, and `x-omp-ide-authorization`.

Licensed under the [MIT License](LICENSE).
