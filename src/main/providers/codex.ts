// Codex adapter — `codex exec --json` subprocess behind the same Provider
// shape. v1 constraints (Section 10, by construction): exec mode has no approval
// callback, so the sandbox is strictly read-only and capabilities.approvals
// is false — mutating actions are simply unavailable under Codex. Steering
// mid-flight is likewise unsupported in exec mode.
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AgentEvent } from '../../shared/types'
import type { Provider, Session, StartOptions } from './types'

export function codexProvider(): Provider {
  return {
    id: 'codex',
    capabilities: { approvals: false, steering: false },

    start(opts: StartOptions): Session {
      const emit = (e: AgentEvent) => opts.onEvent(e)
      let child: ChildProcess | null = null

      const finished = (async () => {
        emit({ kind: 'status', text: 'session started · codex · read-only sandbox', ts: Date.now() })
        try {
          const args = ['exec', '--json', '--sandbox', 'read-only', '--cd', opts.cwd]
          if (opts.model) args.push('-m', opts.model)
          if (opts.effort) args.push('-c', `model_reasoning_effort=${opts.effort === 'xhigh' || opts.effort === 'max' ? 'high' : opts.effort}`)
          args.push(fullPrompt(opts))
          child = spawn('codex', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (e) {
          emit({ kind: 'error', text: `codex spawn failed: ${(e as Error).message}`, ts: Date.now() })
          emit({ kind: 'done', ts: Date.now() })
          return
        }

        const rl = createInterface({ input: child.stdout! })
        rl.on('line', (line) => {
          if (!line.trim()) return
          try {
            mapCodexEvent(JSON.parse(line) as Record<string, unknown>, emit)
          } catch {
            emit({ kind: 'reasoning', text: line.slice(0, 400), ts: Date.now() })
          }
        })

        let stderrTail = ''
        child.stderr?.on('data', (d: Buffer) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000)
        })

        await new Promise<void>((resolve) => {
          child!.on('exit', (code) => {
            if (code !== 0) {
              emit({
                kind: 'error',
                text: `codex exited ${code}${stderrTail ? ` — ${stderrTail.split('\n').filter(Boolean).pop()}` : ''}`,
                ts: Date.now(),
              })
            }
            resolve()
          })
          child!.on('error', (e) => {
            emit({ kind: 'error', text: `codex not available: ${e.message} (is the Codex CLI installed + logged in?)`, ts: Date.now() })
            resolve()
          })
        })
        emit({ kind: 'done', ts: Date.now() })
      })()

      return {
        sessionId: null, // exec mode: no resumable session id surfaced
        usage: null, // exec mode: no usage accounting surfaced
        send() {
          emit({ kind: 'status', text: 'steering unavailable under Codex exec — restart with added context instead', ts: Date.now() })
        },
        interrupt() {
          child?.kill('SIGTERM')
        },
        finished,
      }
    },

    async oneShot(system: string, prompt: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn('codex', ['exec', '--sandbox', 'read-only', `${system}\n\n${prompt}`], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', (d: Buffer) => (out += d.toString()))
        child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`codex exited ${code}`))))
        child.on('error', reject)
      })
    },
  }
}

function fullPrompt(opts: StartOptions): string {
  return `${opts.systemPrompt}\n\n---\n\n${opts.initialPrompt}`
}

/** Defensive mapping over codex --json event lines (shapes vary by version). */
function mapCodexEvent(e: Record<string, unknown>, emit: (ev: AgentEvent) => void): void {
  const ts = Date.now()
  const type = String(e.type ?? e.event ?? '')
  const item = (e.item ?? e) as Record<string, unknown>

  if (type.includes('command') || item.command) {
    const cmd = String(item.command ?? '')
    const id = String(item.id ?? cmd.slice(0, 24) ?? 'cmd')
    if (type.includes('started') || type.includes('begin')) {
      emit({ kind: 'tool_call', id, tool: 'shell', title: cmd.slice(0, 120), args: { command: cmd }, ts })
    } else {
      const output = String(item.aggregated_output ?? item.output ?? '')
      emit({ kind: 'tool_result', id, ok: (item.exit_code ?? 0) === 0, summary: output.split('\n')[0]?.slice(0, 160) ?? '', detail: output.slice(0, 4000), ts })
    }
    return
  }

  const text = item.text ?? e.text ?? (item.message as string | undefined)
  if (typeof text === 'string' && text.trim()) {
    emit({ kind: 'reasoning', text: text.slice(0, 2000), ts })
  }
}
