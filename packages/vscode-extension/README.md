# OMP IDE Bridge (Community)

> [!CAUTION]
> **This is currently a pure Vibe Coding project.** Its code, tests, documentation,
> and visual assets have been generated and iterated by AI coding agents under
> human direction. Automated checks pass, but the project has not received an
> independent human code or security audit. Review it before production use.

Unofficial community bridge between VS Code-compatible editors and
[Oh My Pi](https://github.com/can1357/oh-my-pi). It gives OMP live access to the
active file, selection, open editors, and language-server diagnostics.

## Install both sides

Install this extension from a VSIX or the Visual Studio Marketplace, then install
the OMP-side extension:

```sh
omp plugin install github:502y/omp-ide-bridge
```

The same VSIX supports VS Code, Cursor, Windsurf, and VSCodium. New integrated
terminals receive `OMP_IDE_PORT` automatically; existing terminals use workspace
lockfile discovery.

## Use

- Talk normally: OMP receives the current editor context before each turn.
- Select code and run **OMP: Mention Selection to Chat**.
- Run `/ide` in OMP to inspect or change the active IDE connection.
- Connected agents can inspect diagnostics, open files, save documents, and open
  reviewable diffs.

## Security and privacy

The extension listens only on `127.0.0.1`, authenticates every connection with a
per-window random token, and limits incoming messages to 16 MiB. It implements no
telemetry or external network requests. Selected text and diagnostics reach the
local OMP process and may then be sent to the model provider configured in OMP.

Full documentation: [English](https://github.com/502y/omp-ide-bridge#readme) ·
[简体中文](https://github.com/502y/omp-ide-bridge/blob/main/README.zh-CN.md) ·
[Security policy](https://github.com/502y/omp-ide-bridge/blob/main/SECURITY.md) ·
[JetBrains Marketplace](https://plugins.jetbrains.com/plugin/33610)

This project is not affiliated with or endorsed by the Oh My Pi maintainers.
