# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch. This project is pre-1.0; users should update to the newest available release rather than expect backports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose local source code, authentication tokens, or arbitrary files. Use the repository host's private vulnerability-reporting feature. If private reporting is unavailable, contact the maintainers through a non-public channel listed on their profile.

Include the affected component, reproduction steps, impact, operating system, IDE and OMP versions, and whether the issue is reachable by another local user or process. Do not include real credentials or proprietary source code.

## Security model

- IDE servers bind only to `127.0.0.1` and accept a per-window random bearer token from `~/.omp/ide/<port>.lock`.
- POSIX lock directories and files use modes `0700` and `0600`. Windows uses the current user's profile ACL because POSIX modes are not meaningful there.
- Any process running as the same OS user may be able to read that token and control the IDE bridge. The token is not a sandbox boundary against same-user malware.
- Messages are capped at 16 MiB. The bridge intentionally does not expose arbitrary code execution.
- Editor selections, file paths, open tabs, and diagnostics can be injected into OMP context. The configured model provider may receive that context according to OMP's own configuration and privacy policy.
- No telemetry or external network requests are implemented by this repository.
