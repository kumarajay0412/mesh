// Is the `claude` CLI signed in? Mesh runs on the user's own Claude login (no
// API key of its own), so a logged-out CLI means every investigation fails at
// the first turn. Catching it up-front lets the UI offer a one-click re-login
// instead of surfacing an opaque SDK error mid-run.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeAuth } from '../../shared/types'
import { log } from '../log'

const exec = promisify(execFile)
const l = log('claude-auth')

/** `claude auth status --json` prints a JSON object and exits 0. */
interface AuthStatusJson {
  loggedIn?: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
}

export async function claudeAuth(): Promise<ClaudeAuth> {
  let stdout: string
  try {
    ;({ stdout } = await exec('claude', ['auth', 'status', '--json'], { timeout: 10_000 }))
  } catch (e) {
    const err = e as { code?: string | number; stdout?: string; stderr?: string }
    // ENOENT means the CLI isn't installed; anything else is a live CLI that
    // failed, which we must not report as "logged out" without evidence.
    if (err.code === 'ENOENT') {
      l.info('claude CLI not found on PATH')
      return { installed: false, loggedIn: false }
    }
    // A logged-out CLI may still exit non-zero while printing usable JSON.
    stdout = err.stdout ?? ''
    if (!stdout.trim()) {
      const error = (err.stderr || String(err.code) || 'unknown error').trim()
      l.warn(`auth status failed: ${error}`)
      return { installed: true, loggedIn: false, error }
    }
  }

  try {
    const j = JSON.parse(stdout) as AuthStatusJson
    const out: ClaudeAuth = {
      installed: true,
      loggedIn: Boolean(j.loggedIn),
      email: j.email,
      authMethod: j.authMethod,
      subscriptionType: j.subscriptionType,
    }
    l.info(`claude auth: loggedIn=${out.loggedIn}${out.email ? ` (${out.email})` : ''}`)
    return out
  } catch {
    // Unparseable output: don't guess. Claiming "logged out" here would send
    // the user through a login flow they may not need.
    return { installed: true, loggedIn: false, error: 'could not parse `claude auth status --json`' }
  }
}
