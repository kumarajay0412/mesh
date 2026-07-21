import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mesh's read-only guarantee rests on providers/readonly.ts allowlisting every
// command and the approval broker gating every mutation. A PTY honours neither:
// it is raw execution, and the broker cannot inspect keystrokes.
//
// That is acceptable ONLY while the terminal is a human-driven surface. These
// tests pin that boundary. If one fails, the read-only story is broken — fix
// the code, don't relax the test.
const SRC = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('pty isolation from the agent', () => {
  it('exposes no SDK tool that spawns or writes to a terminal', () => {
    // The agent's tools are defined in the provider layer; none may reach pty.
    for (const f of ['main/providers/claude.ts', 'main/providers/codex.ts', 'main/providers/index.ts']) {
      const src = read(f)
      expect(src, `${f} must not import the pty host`).not.toMatch(/terminal\/pty|createPtyHost|ptyHost/)
      expect(src, `${f} must not reference pty IPC channels`).not.toMatch(/['"`]pty:/)
    }
  })

  it('keeps the engine free of any terminal handle', () => {
    const src = read('main/engine/engine.ts')
    expect(src).not.toMatch(/terminal\/pty|createPtyHost|ptyHost|['"`]pty:/)
  })

  it('does not expose the terminal through the agent-facing memory tools', () => {
    // memory-tools is the in-process MCP surface handed to the model.
    const src = read('main/engine/memory-tools.ts')
    expect(src).not.toMatch(/terminal\/pty|createPtyHost|['"`]pty:/)
  })

  it('reaches the pty only through ipc/register (a renderer-driven seam)', () => {
    // Exactly one main-process module may construct the host.
    const register = read('main/ipc/register.ts')
    expect(register).toMatch(/createPtyHost/)
  })

  it('documents the invariant where the host is defined', () => {
    // The warning must survive refactors — it is the only thing telling the
    // next author why no tool may wrap this.
    expect(read('main/terminal/pty.ts')).toMatch(/SECURITY/)
  })
})
