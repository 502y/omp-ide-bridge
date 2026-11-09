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

## Publishing updates

VS Code uses `@vscode/vsce`; JetBrains uses the IntelliJ Platform Gradle
`publishPlugin` task. VS Code releases use GitHub Actions OIDC:

- In Marketplace publisher `502y`, create a Trusted Publishing policy for owner
  `502y`, repository `omp-ide-bridge`, workflow `publish-vscode.yml`, and leave
  Environment empty. No PAT is needed.
- Run `.github/workflows/publish-vscode.yml` from `main` with `publish=false` to
  check/build/smoke/package only; run with `publish=true` to upload that run's
  verified VSIX. Only the upload job has `id-token: write`.
- The workflow is manual-only and rejects non-main branches. It never publishes
  on pull requests or falls back to saved PAT credentials.

JetBrains authentication remains outside the repository:
- JetBrains: set `intellijPlatformPublishingToken` in the user-level
  `~/.gradle/gradle.properties`, or provide
  `ORG_GRADLE_PROJECT_intellijPlatformPublishingToken` in the publishing process.
  Never commit tokens or include them in command-line arguments.

Update the OMP root/package versions, handshake client version, IDE package
versions and lock metadata, JetBrains descriptor, and release notes as applicable.
The OMP and IDE plugin version numbers can differ. Run the checks above, then:

```sh
cd packages/vscode-extension
npx --yes @vscode/vsce package --no-dependencies
# Marketplace upload: dispatch publish-vscode.yml on main with publish=true.

cd ../jetbrains-plugin
./gradlew publishPlugin
```

The VS Code build bundles its runtime dependencies; `--no-dependencies` avoids
shipping `node_modules`. On Windows use `gradlew.bat` with `JAVA_HOME` set.
Publish the verified source commit and both archives in the GitHub release as
well: OMP installs from GitHub, so an IDE-only release does not update OMP code.
Verify the marketplace version after upload; JetBrains moderation may leave an
uploaded version pending approval rather than publicly available.

## Security

Follow `SECURITY.md`. Do not disclose vulnerabilities involving source-code exposure or local authentication tokens in a public issue.
