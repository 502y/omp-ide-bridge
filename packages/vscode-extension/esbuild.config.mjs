import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18', // VS Code 1.85 embeds Node 18
  format: 'cjs',
  sourcemap: true,
  minify: false,
};

// Extension host bundle: `vscode` is provided by the host at runtime.
await esbuild.build({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

// Standalone protocol-core bundle for the smoke test (dist/server.js):
// adapter injected by the test, no vscode imports inside.
await esbuild.build({
  ...shared,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
});

console.log('built dist/extension.js and dist/server.js');
