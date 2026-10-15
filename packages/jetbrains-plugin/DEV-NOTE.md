# DEV-NOTE — jetbrains-plugin (OMP IDE Bridge)

Implements the IDE-plugin side of `docs/protocol.md` v1: the IDE is the WebSocket
server, OMP is the client.

**Build status (2026-08-13): `buildPlugin` + `verifyPlugin` PASS** — verified
compatible against IC 2023.1.7 (the since-build 231 floor) and IC 2024.3.1
(compile SDK), JDK 17, and Gradle wrapper 8.10.2. The verifier reports both IDEs
as compatible and the plugin as dynamically loadable.
The open-ended `until-build` workaround keeps the plugin installable on newer IDEs.

- `Application.invokeAndWait` in the 2024.3 SDK has **only Runnable overloads**
  (verified via `javap` on util-8.jar) — the Computable overload does not exist;
  `onEdt` now ferries results via `AtomicReference`.
- `SelectionListener.selectionChanged` takes `SelectionEvent`, not the guessed
  `EditorSelectionEvent`.
- `ProjectManagerListener.projectOpened` and `StartupActivity.Background` are
  deprecated — workspace refresh moved into `IdeBridgeStartupActivity`, which is
  now a coroutine `ProjectActivity`.

## Build

Prerequisites: JDK 17+ (wrapper is committed).

```bash
cd packages/jetbrains-plugin
./gradlew buildPlugin                    # -> build/distributions/omp-ide-bridge-jetbrains-0.1.1.zip
./gradlew verifyPlugin                   # binary compatibility vs the compile SDK
./gradlew runIde                         # manual smoke test in a sandbox IDE
```

Target SDK is pinned in `gradle.properties` (`platformType=IC`, `platformVersion=2024.3.1`);
`since-build 231` (2023.1+) is set via `intellijPlatform.pluginConfiguration.ideaVersion`.
`until-build` is intentionally unset (open-ended).

## Layout

| File | Role |
|---|---|
| `Protocol.kt` | Protocol v1 data types, Gson JSON-RPC parsing, and error codes |
| `IdeBridgeServer.kt` | Application service: WebSocket server, auth, lockfile, dispatch, broadcasts |
| `ProjectAdapter.kt` | Project service: selections, editors, files, diagnostics, URI conversion |
| `Listeners.kt` | Startup activity, project changes, diagnostics notifications, cleanup |
| `MentionAction.kt` | Editor context-menu action that sends `at_mentioned` |

Diagnostics use the semi-internal `DaemonCodeAnalyzerEx.processHighlights` API to
read already-computed highlights. The plugin verifier accepts it on both tested
IDE versions, but it remains a compatibility risk because it is not public API.
`showDiff` opens JetBrains' built-in nonmodal Diff View for read-only before/after
text snapshots. It uses the URI filename for syntax highlighting and associates
the view with the matching open project (falling back to the active project).
Opening the view does not require a disk file. Required `oldExists`/`newExists`
flags distinguish absent files from empty files. The RPC returns
`{ "opened": true }` without waiting for a decision. Accept keeps the applied
change; Refuse restores original UTF-8 bytes through a VFS write command only if
current disk bytes still match the after-snapshot and no editor changes are unsaved.
Refuse removes a created file or recreates a deleted file; conflicting requests
leave the window open with an inline warning, without a blocking dialog.
Closing the window does not revert. VFS lookup/refresh runs on a pooled worker;
document checks and the write command return to an EDT write-safe context.
The native diff panel and buttons share a nonmodal `WindowWrapper`; disposal
releases diff editors and plugin disposal closes outstanding review windows.
`openDiff` remains unsupported (`-32601`): unlike post-edit `showDiff`, its protocol
waits for approval before applying a proposal.

Services are **light services** (`@Service` annotation) and deliberately NOT declared in
`plugin.xml` — the platform forbids double registration.

## Runtime-only checks remaining

1. **Handshake rejection (auth).** Confirm Java-WebSocket closes a bad or missing
   `x-omp-ide-authorization` header with code 1008.
2. **Startup-failure detection.** Force a bind conflict and confirm scanning moves
   to another port within the 20-attempt limit.
3. **URI helpers.** Unit-check win32 drive letters, UNC paths, spaces, and non-ASCII
   round-tripping through `uriToPath` and `pathToUri`.
4. **Navigation.** Confirm `OpenFileDescriptor(...).navigate(true)` reveals the
   requested zero-based line and column under `runIde`.
5. **Payload limit.** Confirm oversized text messages close with code 1009.

## Functional checks for the first real run

- Lockfile `~/.omp/ide/<port>.lock` appears after the first project opens; POSIX
  mode `0600` with directory `0700`, or current-user profile ACL on Windows.
- Workspace folders update on project open/close and `workspace_changed` broadcasts.
- Two simultaneous OMP clients connect and both receive notifications.
- `initialize` advertises `showDiff:true`, `openDiff:false`, `diagnostics:true`,
  `executeCode:false`; `openDiff` returns `-32601`.
- `showDiff` validates `uri`, `oldText`, `newText`, `oldExists`, `newExists`, and
  optional `tabName`, then opens native read-only panes with Accept/Refuse buttons.
  Check edits, additions, deletions (including empty files), repeated requests,
  stale disk snapshots, dirty documents, and project/plugin disposal.
  The RPC must return promptly. Accept and window close must preserve disk contents;
  Refuse must restore only the reviewed change, never later edits.
- `selection_changed` is debounced to ≤150 ms and carries 0-based positions;
  `getLatestSelection` survives focus loss.
- Threading: no EDT freezes during `openFile`/`saveDocument`/`closeTab` round trips
  (WS worker threads block in `invokeAndWait`; nothing on the EDT blocks on a WS thread).
