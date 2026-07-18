// Builds the Electron main process, the embeddings utility-process worker,
// and the preload script.
//
// HARD RULE — packages: 'external'.
// We bundle ONLY our own src/main + src/shared code. Every bare-specifier
// import (better-sqlite3, @anthropic-ai/claude-agent-sdk, @huggingface/
// transformers, ...) stays a real runtime import resolved from node_modules:
//  - native .node loaders must never pass through a bundler
//  - the Agent SDK and transformers.js are ESM-only; bundling them into CJS
//    would break their internal import() usage under Electron's Node (no
//    require(esm)). Main is therefore emitted as ESM.
// Preload is the one CJS output (.cjs): it only needs `electron` + shared
// types, and CJS preloads keep working even with sandboxed renderers.
import * as esbuild from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
}

export const entries = [
  { ...common, format: 'esm', entryPoints: ['src/main/index.ts'], outfile: 'dist-electron/main.js' },
  { ...common, format: 'esm', entryPoints: ['src/main/memory/embed-worker.ts'], outfile: 'dist-electron/embed-worker.js' },
  { ...common, format: 'cjs', entryPoints: ['src/preload/index.ts'], outfile: 'dist-electron/preload.cjs' },
  // headless one-shot sync (npm run sync:once) — dev/ops tool, not shipped UI
  { ...common, format: 'esm', entryPoints: ['src/main/sync-once.ts'], outfile: 'dist-electron/sync-once.js' },
]

if (import.meta.url === `file://${process.argv[1]}`) {
  await Promise.all(entries.map((e) => esbuild.build(e)))
}
