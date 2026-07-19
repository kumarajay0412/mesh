// Main-side client for the embed worker: spawn, RPC, ready-state tracking,
// and the pending-embedding backfill drain (Section 7.1 — un-embedded rows are the
// queue; we drain whenever the model is ready or new rows arrive).
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'

// ESM main bundle — no CJS __dirname; derive it (embed-worker.js sits beside main.js)
const __dirname = dirname(fileURLToPath(import.meta.url))
import type { ModelStatus } from '../../shared/types'
import { memoryRepo } from '../db/repos/memory'
import { learningsRepo } from '../db/repos/learnings'
import { EMBEDDING_DIMS } from '../db'
import { log } from '../log'

const l = log('embeddings')

interface Pending {
  resolve: (vectors: number[][]) => void
  reject: (e: Error) => void
}

export class Embeddings {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private status: ModelStatus = { state: 'idle' }
  private draining = false
  // Supervised respawn: a native ORT crash used to permanently kill semantic
  // search until app restart. We restart with capped backoff, and a circuit
  // breaker (too many crashes in a short window) so we don't hot-loop.
  private intentionalStop = false
  private crashTimes: number[] = []
  private respawnTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private db: Database,
    private vecAvailable: boolean,
    private onStatus: (s: ModelStatus) => void,
  ) {}

  start(): void {
    if (!this.vecAvailable) {
      this.setStatus({ state: 'unavailable', message: 'sqlite-vec not loaded — lexical search only' })
      return
    }
    try {
      this.worker = utilityProcess.fork(join(__dirname, 'embed-worker.js'), [], {
        serviceName: 'mesh-embeddings',
        env: { ...process.env, MESH_MODEL_CACHE: join(app.getPath('userData'), 'models') },
      })
    } catch (e) {
      l.error('failed to fork embed worker:', (e as Error).message)
      this.setStatus({ state: 'error', message: (e as Error).message })
      return
    }

    this.worker.on('message', (msg: { id?: number; ok?: boolean; vectors?: number[][]; error?: string; type?: string; state?: ModelStatus['state']; progress?: number; message?: string }) => {
      if (msg.type === 'status' && msg.state) {
        this.setStatus({ state: msg.state, progress: msg.progress, message: msg.message })
        if (msg.state === 'ready') void this.drainPending()
        return
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok && msg.vectors) p.resolve(msg.vectors)
        else p.reject(new Error(msg.error ?? 'embed failed'))
      }
    })

    this.worker.on('exit', (code) => {
      l.warn(`embed worker exited (${code})`)
      for (const p of this.pending.values()) p.reject(new Error('worker exited'))
      this.pending.clear()
      this.worker = null
      if (this.intentionalStop) return // stop() — don't resurrect

      // Circuit breaker: >3 crashes in 5 min → give up (a persistent native
      // fault, not a transient one). Otherwise respawn with capped backoff;
      // the 'ready' handler above then re-drains the pending queue automatically.
      const now = Date.now()
      this.crashTimes = this.crashTimes.filter((t) => now - t < 5 * 60_000)
      this.crashTimes.push(now)
      if (this.crashTimes.length > 3) {
        this.setStatus({ state: 'error', message: 'embedding worker crashed repeatedly — semantic search disabled until restart' })
        return
      }
      const backoff = Math.min(30_000, 1000 * 2 ** (this.crashTimes.length - 1))
      this.setStatus({ state: 'idle', message: `embedding worker crashed — restarting in ${Math.round(backoff / 1000)}s` })
      this.respawnTimer = setTimeout(() => this.start(), backoff)
    })
  }

  stop(): void {
    this.intentionalStop = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.worker?.kill()
    this.worker = null
  }

  get ready(): boolean {
    return this.status.state === 'ready' && !!this.worker
  }

  get currentStatus(): ModelStatus {
    return this.status
  }

  private setStatus(s: ModelStatus): void {
    this.status = s
    this.onStatus(s)
  }

  embed(texts: string[]): Promise<number[][]> {
    if (!this.worker) return Promise.reject(new Error('embed worker not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, type: 'embed', texts })
    })
  }

  /** Embed one query string → Float32Array for the vec KNN. */
  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embed([text])
    return Float32Array.from(v)
  }

  /** Drain memory rows AND accepted learnings with embedded=0, batched. */
  async drainPending(): Promise<void> {
    if (this.draining || !this.ready) return
    this.draining = true
    const memory = memoryRepo(this.db)
    const learnings = learningsRepo(this.db)
    try {
      for (;;) {
        const rows = memory.pendingEmbedding(32)
        if (rows.length === 0) break
        const vectors = await this.embed(rows.map((r) => (r.symptoms || r.title).slice(0, 2000)))
        // vec0 virtual tables don't implement conflict resolution — no
        // INSERT OR REPLACE / upsert. Re-embedded rows (sync re-upserts set
        // embedded=0) must be deleted before re-insert.
        const del = this.db.prepare('DELETE FROM memory_vec WHERE memory_rowid = ?')
        const insert = this.db.prepare('INSERT INTO memory_vec (memory_rowid, embedding) VALUES (?, ?)')
        const tx = this.db.transaction(() => {
          rows.forEach((r, i) => {
            const v = Float32Array.from(vectors[i])
            if (v.length !== EMBEDDING_DIMS) throw new Error(`bad dims ${v.length}`)
            del.run(BigInt(r.rowid))
            insert.run(BigInt(r.rowid), Buffer.from(v.buffer))
            memory.markEmbedded(r.rowid)
          })
        })
        tx()
        l.info(`embedded ${rows.length} memory rows`)
      }

      for (;;) {
        const rows = learnings.pendingEmbedding(32)
        if (rows.length === 0) break
        const vectors = await this.embed(rows.map((r) => r.text.slice(0, 2000)))
        const del = this.db.prepare('DELETE FROM learnings_vec WHERE learning_id = ?')
        const insert = this.db.prepare('INSERT INTO learnings_vec (learning_id, embedding) VALUES (?, ?)')
        const tx = this.db.transaction(() => {
          rows.forEach((r, i) => {
            const v = Float32Array.from(vectors[i])
            if (v.length !== EMBEDDING_DIMS) throw new Error(`bad dims ${v.length}`)
            del.run(BigInt(r.id))
            insert.run(BigInt(r.id), Buffer.from(v.buffer))
            learnings.markEmbedded(r.id)
          })
        })
        tx()
        l.info(`embedded ${rows.length} learnings`)
      }
    } catch (e) {
      l.error('drain failed:', (e as Error).message)
    } finally {
      this.draining = false
    }
  }
}
