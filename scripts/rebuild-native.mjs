// Dual-ABI native setup for better-sqlite3:
//   1. fetch the NODE prebuild   → stash at build/Release/node/better_sqlite3.node   (vitest / dev-node)
//   2. fetch the ELECTRON prebuild → default build/Release/better_sqlite3.node       (the app)
// The app loads the default; tests pass `nativeBinding` to the stashed Node copy
// (src/main/__tests__/helpers.ts). Preferred over @electron/rebuild: no local
// toolchain (Xcode/Python) needed, and @electron/rebuild's CLI is currently
// broken under Node 26 (yargs ESM issue).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'

const require = createRequire(import.meta.url)

let electronVersion = null
try {
  electronVersion = require('electron/package.json').version
} catch {
  console.log('[rebuild-native] electron not installed — will only ensure the Node build')
}

const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const prebuildBin = join(dirname(require.resolve('prebuild-install/package.json')), 'bin.js')
const releaseDir = join(pkgDir, 'build', 'Release')
const defaultBinding = join(releaseDir, 'better_sqlite3.node')
const nodeStash = join(releaseDir, 'node', 'better_sqlite3.node')

function fetch(runtimeArgs, label) {
  const r = spawnSync(process.execPath, [prebuildBin, ...runtimeArgs, '--platform', process.platform, '--arch', process.arch], {
    cwd: pkgDir,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`[rebuild-native] prebuild-install failed for ${label}`)
    process.exit(r.status ?? 1)
  }
}

// 1 — Node ABI (for vitest); lands at the default path, stash it aside
console.log(`[rebuild-native] fetching Node prebuild (node ${process.versions.node})`)
fetch([], 'node')
mkdirSync(dirname(nodeStash), { recursive: true })
copyFileSync(defaultBinding, nodeStash)

// 2 — Electron ABI (for the app); overwrites the default path
if (electronVersion) {
  console.log(`[rebuild-native] fetching Electron prebuild (electron ${electronVersion})`)
  fetch(['--runtime', 'electron', '--target', electronVersion], 'electron')
}

// 3 — node-pty ships its own prebuilt binaries (N-API, so one build serves both
// Node and Electron — no ABI split needed). But on macOS it spawns through a
// `spawn-helper` executable, and the +x bit normally comes from node-pty's
// postinstall, which this repo intentionally does not run. Without it every
// pty.spawn dies with "posix_spawnp failed".
function fixPtySpawnHelper() {
  let ptyDir
  try {
    ptyDir = dirname(require.resolve('node-pty/package.json'))
  } catch {
    return // node-pty not installed — nothing to do
  }
  const prebuilds = join(ptyDir, 'prebuilds')
  const targets = []
  if (existsSync(prebuilds)) {
    for (const d of readdirSync(prebuilds)) {
      const helper = join(prebuilds, d, 'spawn-helper')
      if (existsSync(helper)) targets.push(helper)
    }
  }
  const built = join(ptyDir, 'build', 'Release', 'spawn-helper')
  if (existsSync(built)) targets.push(built)
  for (const t of targets) chmodSync(t, 0o755)
  console.log(`[rebuild-native] node-pty spawn-helper: ${targets.length ? `+x on ${targets.length}` : 'none found'}`)
}
fixPtySpawnHelper()

console.log(`[rebuild-native] done — app: ${existsSync(defaultBinding) ? 'ok' : 'MISSING'} · tests: ${existsSync(nodeStash) ? 'ok' : 'MISSING'}`)
