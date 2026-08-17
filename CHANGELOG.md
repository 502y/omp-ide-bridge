# Changelog

All notable changes to this project are documented here. The project follows semantic versioning after the first stable release; pre-1.0 releases may change integration details.

## 0.1.0 - Unreleased

### Added

- OMP extension with live editor context, diagnostics, IDE tools, and `/ide` discovery.
- VS Code-compatible extension with authenticated loopback JSON-RPC and native diff review.
- JetBrains plugin with editor context, diagnostics, file operations, and mention actions.
- Protocol v1 documentation, Windows/macOS/Linux CI, security policy, and contribution guide.

### Security

- Loopback-only WebSocket servers with per-window bearer tokens.
- Protocol-version and initialization-order validation.
- 16 MiB incoming-message limit.

### Fixed

- Windows drive, UNC, Unicode, and path-boundary handling.
- Automatic reconnection after abrupt WebSocket closure.
- Refused document saves no longer report success.

### Changed

- The project is explicitly branded as an unofficial community integration.
- OMP can install the extension from the repository root.
- Dependency locks use public registries; generated artifacts and local caches are excluded.
