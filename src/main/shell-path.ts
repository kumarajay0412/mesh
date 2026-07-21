// A Finder-launched macOS app inherits a bare PATH (/usr/bin:/bin), so every
// tool the user installed via Homebrew, the gcloud SDK installer, nvm, asdf,
// pyenv … silently vanishes in the packaged build. Hardcoding a few well-known
// directories only covers the common cases: the gcloud SDK, for instance,
// installs to ~/google-cloud-sdk/bin by default and would be missed.
//
// Asking the user's own login shell for its PATH covers all of it, and matters
// for correctness beyond convenience: the Connections card reports which CLIs
// exist, so a PATH narrower than the user's real one makes Mesh claim a tool
// is missing when it isn't.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { log } from './log'

const exec = promisify(execFile)
const l = log('shell-path')

/** Fallback locations, used alongside whatever the login shell reports. */
function staticExtras(): string[] {
  const home = process.env.HOME ?? ''
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local/bin'),
    join(home, 'google-cloud-sdk/bin'),
  ]
}

function merge(...lists: string[][]): string {
  return [...new Set(lists.flat())].filter(Boolean).join(':')
}

/** Ask the login shell for its PATH. `-ilc` so rc files and profile both run.
 *  Never throws; a shell that hangs or errors just yields nothing. */
async function loginShellPath(): Promise<string[]> {
  const shell = process.env.SHELL
  if (!shell) return []
  try {
    // `echo` is a builtin in every POSIX shell, so this needs nothing on PATH.
    const { stdout } = await exec(shell, ['-ilc', 'echo "$PATH"'], { timeout: 4_000 })
    return stdout.trim().split(':')
  } catch {
    return []
  }
}

/** Widen process.env.PATH to what the user's shell would see. Idempotent, and
 *  safe to await before anything that spawns a CLI. */
export async function resolveShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const current = (process.env.PATH ?? '').split(':')
  const fromShell = await loginShellPath()
  process.env.PATH = merge(current, fromShell, staticExtras())
  l.info(`PATH resolved: ${fromShell.length} entries from ${process.env.SHELL ?? 'login shell'}`)
}

/** Synchronous best-effort widening, applied at import time so nothing that
 *  spawns before resolveShellPath() resolves is left with a bare PATH. */
export function applyStaticPathExtras(): void {
  if (process.platform === 'win32') return
  process.env.PATH = merge((process.env.PATH ?? '').split(':'), staticExtras())
}
