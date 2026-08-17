# Contributing

Thank you for improving OMP IDE Bridge. This is an unofficial community project; avoid wording or artwork that implies endorsement by the Oh My Pi maintainers.

## Development setup

Requirements:

- Node.js 22 or newer
- Bun 1.3.14 or newer
- JDK 17

Run the checks for the area you change:

```sh
cd packages/vscode-extension
npm ci
npm run typecheck
npm run compile
npm run smoke

cd ../omp-extension
bun install --frozen-lockfile
bunx tsc --noEmit
bun test

cd ../jetbrains-plugin
./gradlew buildPlugin verifyPlugin
```

Protocol changes must update `docs/protocol.md` and every implementation affected by the wire contract. Cross-platform path changes must cover Windows drive paths, UNC paths, POSIX paths, spaces, non-ASCII characters, and path-segment boundaries.

## Pull requests

Keep changes focused. Explain the observable behavior, security implications, and exact verification performed. Do not commit dependencies, IDE state, generated archives, build directories, credentials, proprietary source code, or private registry URLs.

Use tests for new observable contracts and regressions. Runtime-only IDE behavior that cannot be automated must be recorded in the relevant development note with reproducible manual steps.

## Security

Follow `SECURITY.md`. Do not disclose vulnerabilities involving source-code exposure or local authentication tokens in a public issue.
