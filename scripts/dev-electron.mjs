// Dev orchestrator for the Electron side (renderer HMR is plain Vite):
//  1. esbuild watch over main / worker / preload entries
//  2. wait for the Vite dev server (tcp:5173)
//  3. spawn `electron .`; kill + respawn it whenever the main bundle rebuilds
import * as esbuild from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { entries } from './build-main.mjs'

const VITE_PORT = 5173
let electronChild = null
let ready = false

// Dev-mode app identity: the dock hover/menu-bar name comes from the Electron
// binary's Info.plist ("Electron"), not from anything settable at runtime.
// Patch it to "Mesh" — idempotent, and self-healing across reinstalls (a fresh
// electron extract reverts it; this re-applies on every dev launch).
function brandDevBundle() {
  if (process.platform !== 'darwin') return
  const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
  if (!existsSync(plist)) return
  try {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} Mesh`, plist], { stdio: 'ignore' })
    }
    console.log('[dev-electron] dev bundle branded as "Mesh"')
  } catch {
    /* cosmetic only — never block dev on it */
  }
}
brandDevBundle()

function waitForPort(port) {
  // Vite may bind IPv6-only (::1) depending on the host's localhost resolution
  // — probe both families and resolve on the first that connects.
  return new Promise((resolve) => {
    let done = false
    const tryHost = (host) => {
      if (done) return
      const sock = createConnection({ port, host }, () => {
        sock.end()
        if (!done) {
          done = true
          resolve()
        }
      })
      sock.on('error', () => {
        sock.destroy()
        if (!done) setTimeout(() => tryHost(host), 300)
      })
    }
    tryHost('127.0.0.1')
    tryHost('::1')
  })
}

function startElectron() {
  electronChild = spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${VITE_PORT}` },
  })
  electronChild.on('exit', (code) => {
    // Window closed by the user → end the dev session cleanly.
    process.exit(code ?? 0)
  })
}

function spawnElectron() {
  // The app now holds a single-instance lock in userData; the new instance must
  // wait for the old one to EXIT (and release the lock) before starting, or it
  // sees the lock held and quits immediately — killing the hot-reload loop.
  if (electronChild) {
    const old = electronChild
    old.removeAllListeners('exit')
    old.once('exit', () => startElectron())
    old.kill()
  } else {
    startElectron()
  }
}

const contexts = await Promise.all(
  entries.map((e) =>
    esbuild.context({
      ...e,
      plugins: [
        {
          name: 'respawn-electron',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length === 0 && ready) spawnElectron()
            })
          },
        },
      ],
    }),
  ),
)

await Promise.all(contexts.map((c) => c.rebuild()))
await Promise.all(contexts.map((c) => c.watch()))

console.log('[dev-electron] main bundles built; waiting for vite on :%d ...', VITE_PORT)
await waitForPort(VITE_PORT)
ready = true
spawnElectron()
