// Team hand-off packs: everything Mesh has learned, in one offline file.
//
// A .meshpack is gzipped JSON: distilled memory WITH its embedding vectors
// (so import is useful with zero network — no model download, no re-embed),
// investigations + timelines + session costs, learnings, the knowledge map,
// the service registry, and sync cursors. Machine-specific state never
// travels: repo paths (rebuilt by the recipient's own sync), Claude session
// resume ids (nulled — they belong to the exporter's login).
//
// SECRETS. safeStorage blobs are keyed to the exporting machine's OS keychain
// and are useless anywhere else, so tokens can only travel decrypted — which
// this module refuses to do in the clear. Tokens ride ONLY when the exporter
// sets a passphrase: scrypt-derived key, AES-256-GCM, and the importer needs
// the same passphrase, after which values are re-encrypted into the
// recipient's own keychain. No passphrase → no tokens in the file, ever.
//
// Import is a MERGE, biased toward not clobbering the recipient:
//   replace  — memory, investigations (+ events/sessions wholesale per
//              investigation), map nodes, slack thread cache, sync cursors
//   keep     — map edge decisions, settings, existing secrets, manual
//              service entries (inferred never overwrites manual)
//   dedup    — learnings (by investigation + text)
// Importing the same pack twice is a no-op.
import { gzipSync, gunzipSync } from 'node:zlib'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export const PACK_VERSION = 1

export interface SealedSecrets {
  kdf: 'scrypt'
  salt: string
  nonce: string
  tag: string
  data: string
}

export interface MeshPack {
  version: number
  exportedAt: number
  app: 'mesh'
  data: Record<string, Record<string, unknown>[]>
  memoryVectors?: { id: string; b64: string }[]
  secrets?: SealedSecrets
}

export interface ImportReport {
  counts: Record<string, { applied: number; skipped: number }>
  vectors: { applied: number; skipped: number }
  secrets: { applied: number; skipped: number }
  warnings: string[]
}

/* ------------------------------------------------------------- secrets -- */

const SCRYPT = { N: 16384, r: 8, p: 1 }

export function sealSecrets(values: Record<string, string>, passphrase: string): SealedSecrets {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()])
  return {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export function openSecrets(sealed: SealedSecrets, passphrase: string): Record<string, string> {
  const key = scryptSync(passphrase, Buffer.from(sealed.salt, 'base64'), 32, SCRYPT)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    // GCM auth failure — wrong passphrase or a tampered file; same answer.
    throw new Error('wrong passphrase (or corrupted pack)')
  }
}

/* -------------------------------------------------------------- export -- */

/** Only source configuration travels; machine paths and personal prefs stay. */
const SETTINGS_WHITELIST = ['grafana.instances', 'githubOrg', 'slack.corpus']

/** Plain content tables exported verbatim (events/sessions/vectors are special-cased). */
const CONTENT_TABLES = ['memory', 'investigations', 'learnings', 'links', 'slack_threads', 'map_nodes', 'map_edges', 'services', 'sync_state'] as const

const all = (db: Database, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Record<string, unknown>[]

export function buildPack(db: Database, opts: { secretValues?: Record<string, string>; passphrase?: string; vecAvailable?: boolean } = {}): MeshPack {
  const data: MeshPack['data'] = {}
  for (const t of CONTENT_TABLES) data[t] = all(db, `SELECT * FROM ${t}`)

  // sessions: cost/turn stats travel; the provider resume id is login-bound.
  data.sessions = all(db, 'SELECT * FROM sessions').map((s) => ({ ...s, native_session_id: null }))
  data.events = all(db, 'SELECT * FROM events')

  data.settings = all(
    db,
    `SELECT key, value_json FROM settings WHERE key IN (${SETTINGS_WHITELIST.map(() => '?').join(',')})`,
    ...SETTINGS_WHITELIST,
  )

  const pack: MeshPack = { version: PACK_VERSION, exportedAt: Date.now(), app: 'mesh', data }

  if (opts.vecAvailable) {
    pack.memoryVectors = (
      all(db, 'SELECT m.id AS id, v.embedding AS embedding FROM memory_vec v JOIN memory m ON m.rowid = v.memory_rowid') as unknown as {
        id: string
        embedding: Buffer
      }[]
    ).map((r) => ({ id: r.id, b64: Buffer.from(r.embedding).toString('base64') }))
  }

  if (opts.passphrase && opts.secretValues && Object.keys(opts.secretValues).length > 0) {
    pack.secrets = sealSecrets(opts.secretValues, opts.passphrase)
  }
  return pack
}

export const encodePack = (pack: MeshPack): Buffer => gzipSync(Buffer.from(JSON.stringify(pack), 'utf8'), { level: 6 })

export function decodePack(buf: Buffer): MeshPack {
  const pack = JSON.parse(gunzipSync(buf).toString('utf8')) as MeshPack
  if (pack.app !== 'mesh' || typeof pack.version !== 'number') throw new Error('not a meshpack file')
  if (pack.version > PACK_VERSION) throw new Error(`pack version ${pack.version} is newer than this Mesh understands — update Mesh first`)
  return pack
}

/* -------------------------------------------------------------- import -- */

const columnsOf = (db: Database, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))

/** INSERT one exported row, keeping only columns the local schema knows. */
function insertRow(db: Database, table: string, row: Record<string, unknown>, cols: Set<string>, mode: 'REPLACE' | 'IGNORE'): boolean {
  const keys = Object.keys(row).filter((k) => cols.has(k))
  const sql = `INSERT OR ${mode} INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  return db.prepare(sql).run(...keys.map((k) => row[k])).changes > 0
}

export function applyPack(
  db: Database,
  pack: MeshPack,
  opts: {
    vecAvailable: boolean
    passphrase?: string
    /** re-encrypt one secret into the local keychain; absent id → keep local */
    setSecret?: (id: string, value: string) => void
    hasSecret?: (id: string) => boolean
  },
): ImportReport {
  const report: ImportReport = { counts: {}, vectors: { applied: 0, skipped: 0 }, secrets: { applied: 0, skipped: 0 }, warnings: [] }
  const count = (t: string) => (report.counts[t] ??= { applied: 0, skipped: 0 })
  const d = pack.data

  const run = db.transaction(() => {
    // memory — replace by id; embedded=0 unless this pack carries its vector,
    // so a vector-less import falls back to the local re-embed queue.
    const memCols = columnsOf(db, 'memory')
    const packedVecIds = new Set((pack.memoryVectors ?? []).map((v) => v.id))
    for (const row of d.memory ?? []) {
      try {
        const ok = insertRow(db, 'memory', { ...row, embedded: opts.vecAvailable && packedVecIds.has(String(row.id)) ? 1 : 0 }, memCols, 'REPLACE')
        ok ? count('memory').applied++ : count('memory').skipped++
      } catch {
        count('memory').skipped++ // e.g. (source, ticket_id) unique clash with a differently-keyed local row
      }
    }

    if (opts.vecAvailable && pack.memoryVectors?.length) {
      const rowidOf = db.prepare('SELECT rowid FROM memory WHERE id = ?')
      const delVec = db.prepare('DELETE FROM memory_vec WHERE memory_rowid = ?')
      const insVec = db.prepare('INSERT INTO memory_vec (memory_rowid, embedding) VALUES (?, ?)')
      for (const v of pack.memoryVectors) {
        const r = rowidOf.get(v.id) as { rowid: number } | undefined
        if (!r) {
          report.vectors.skipped++
          continue
        }
        delVec.run(r.rowid)
        insVec.run(r.rowid, Buffer.from(v.b64, 'base64'))
        report.vectors.applied++
      }
    } else if (pack.memoryVectors?.length) {
      report.vectors.skipped = pack.memoryVectors.length
      report.warnings.push('vector search unavailable here — imported memories will re-embed locally in the background')
    }

    // investigations — replace wholesale: the events timeline and session
    // stats for an imported investigation are wiped and re-inserted so a
    // re-import never duplicates them. Session autoinc ids are remapped.
    const invCols = columnsOf(db, 'investigations')
    const sesCols = columnsOf(db, 'sessions')
    const evCols = columnsOf(db, 'events')
    const importedInvIds = new Set((d.investigations ?? []).map((r) => String(r.id)))
    for (const row of d.investigations ?? []) {
      insertRow(db, 'investigations', row, invCols, 'REPLACE') ? count('investigations').applied++ : count('investigations').skipped++
    }
    const sessionIdMap = new Map<number, number>()
    if (importedInvIds.size > 0) {
      const inList = [...importedInvIds]
      const ph = inList.map(() => '?').join(',')
      db.prepare(`DELETE FROM events WHERE investigation_id IN (${ph})`).run(...inList)
      db.prepare(`DELETE FROM sessions WHERE investigation_id IN (${ph})`).run(...inList)
      for (const s of d.sessions ?? []) {
        if (!importedInvIds.has(String(s.investigation_id))) continue
        const { id: oldId, ...rest } = s
        const keys = Object.keys(rest).filter((k) => sesCols.has(k))
        const res = db.prepare(`INSERT INTO sessions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => rest[k]))
        if (typeof oldId === 'number') sessionIdMap.set(oldId, Number(res.lastInsertRowid))
        count('sessions').applied++
      }
      for (const e of d.events ?? []) {
        if (!importedInvIds.has(String(e.investigation_id))) continue
        const { id: _id, session_id, ...rest } = e
        const remapped = typeof session_id === 'number' ? (sessionIdMap.get(session_id) ?? null) : null
        insertRow(db, 'events', { ...rest, session_id: remapped }, evCols, 'REPLACE')
        count('events').applied++
      }
    }

    // learnings — content-dedup; imported rows re-embed locally.
    const learnCols = columnsOf(db, 'learnings')
    const learnExists = db.prepare("SELECT 1 FROM learnings WHERE text = ? AND COALESCE(investigation_id, '') = COALESCE(?, '')")
    for (const row of d.learnings ?? []) {
      if (learnExists.get(row.text, row.investigation_id ?? null)) {
        count('learnings').skipped++
        continue
      }
      const { id: _id, ...rest } = row
      insertRow(db, 'learnings', { ...rest, embedded: 0 }, learnCols, 'IGNORE')
      count('learnings').applied++
    }

    // services — the registry's own rule: manual entries never lose to inferred.
    const svcCols = columnsOf(db, 'services')
    const svcSource = db.prepare('SELECT source FROM services WHERE name = ?')
    for (const row of d.services ?? []) {
      const existing = svcSource.get(row.name) as { source: string } | undefined
      if (existing?.source === 'manual' && row.source !== 'manual') {
        count('services').skipped++
        continue
      }
      insertRow(db, 'services', row, svcCols, 'REPLACE') ? count('services').applied++ : count('services').skipped++
    }

    // map — nodes are content (replace); edge rows keep local accept/reject
    // decisions (ignore on conflict). sync cursors replace, but never import
    // a mid-run status.
    const simple: [string, 'REPLACE' | 'IGNORE', ((r: Record<string, unknown>) => Record<string, unknown>)?][] = [
      ['map_nodes', 'REPLACE', undefined],
      ['map_edges', 'IGNORE', (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id'))],
      ['links', 'IGNORE', undefined],
      ['slack_threads', 'REPLACE', undefined],
      ['sync_state', 'REPLACE', (r) => ({ ...r, status: 'idle' })],
      ['settings', 'IGNORE', undefined],
    ]
    for (const [table, mode, transform] of simple) {
      const cols = columnsOf(db, table)
      for (const row of d[table] ?? []) {
        insertRow(db, table, transform ? transform(row) : row, cols, mode) ? count(table).applied++ : count(table).skipped++
      }
    }
  })
  run()

  // secrets — outside the tx (keychain IO): fill gaps only, never overwrite.
  if (pack.secrets) {
    if (!opts.passphrase) {
      report.warnings.push('pack contains tokens but no passphrase was given — tokens not imported')
    } else if (opts.setSecret) {
      const values = openSecrets(pack.secrets, opts.passphrase) // throws on wrong passphrase
      for (const [id, value] of Object.entries(values)) {
        if (opts.hasSecret?.(id)) {
          report.secrets.skipped++
          continue
        }
        opts.setSecret(id, value)
        report.secrets.applied++
      }
    }
  }
  return report
}
