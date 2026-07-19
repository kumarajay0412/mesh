// Numbered migrations, applied in order via PRAGMA user_version (see migrate.ts).
// Template strings, not files on disk — nothing to copy at build time.
// memory_vec (the sqlite-vec virtual table) is intentionally NOT here: it is
// created at runtime only when the extension loads (db/index.ts feature-detect).

export const MIGRATIONS: string[] = [
  // v1 — the Section 8 schema
  `
  CREATE TABLE services (
    name                 TEXT PRIMARY KEY,
    repo                 TEXT,
    namespace            TEXT,
    source               TEXT NOT NULL DEFAULT 'inferred',
    aliases_json         TEXT NOT NULL DEFAULT '[]',
    does                 TEXT,
    serving              TEXT,
    ids_json             TEXT NOT NULL DEFAULT '{}',
    known_solutions_json TEXT NOT NULL DEFAULT '[]',
    updated_at           INTEGER NOT NULL
  );

  CREATE TABLE repos (
    name            TEXT PRIMARY KEY,
    path            TEXT,
    remote_url      TEXT,
    last_fetched_at INTEGER
  );

  CREATE TABLE investigations (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    service      TEXT,
    status       TEXT NOT NULL,
    stage        TEXT NOT NULL,
    confidence   TEXT,
    source       TEXT NOT NULL,
    ticket_ref   TEXT,
    similar_json TEXT NOT NULL DEFAULT '[]',
    report_json  TEXT,
    session_id   TEXT,
    created_at   INTEGER NOT NULL,
    closed_at    INTEGER
  );

  CREATE TABLE events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id TEXT NOT NULL,
    ts               INTEGER NOT NULL,
    type             TEXT NOT NULL,
    payload_json     TEXT NOT NULL
  );
  CREATE INDEX idx_events_inv ON events(investigation_id, id);

  CREATE TABLE memory (
    id                    TEXT PRIMARY KEY,
    source                TEXT NOT NULL,
    ticket_id             TEXT,
    identifier            TEXT,
    slack_url             TEXT,
    title                 TEXT NOT NULL,
    symptoms              TEXT NOT NULL DEFAULT '',
    root_cause            TEXT,
    resolution            TEXT,
    investigation_summary TEXT,
    resolution_steps_json TEXT NOT NULL DEFAULT '[]',
    error_signature       TEXT,
    raw_comments_json     TEXT,
    labels_json           TEXT NOT NULL DEFAULT '[]',
    priority              TEXT,
    reported_at           INTEGER,
    resolved_at           INTEGER,
    updated_at            INTEGER NOT NULL,
    embedded              INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX idx_memory_ticket    ON memory(source, ticket_id) WHERE ticket_id IS NOT NULL;
  CREATE INDEX        idx_memory_signature ON memory(error_signature)   WHERE error_signature IS NOT NULL;

  CREATE TABLE sync_state (
    source      TEXT PRIMARY KEY,
    cursor      TEXT,
    last_run_at INTEGER,
    status      TEXT NOT NULL DEFAULT 'idle',
    message     TEXT
  );

  CREATE TABLE links (
    investigation_id TEXT NOT NULL,
    related_id       TEXT NOT NULL,
    relation         TEXT NOT NULL,
    PRIMARY KEY (investigation_id, related_id, relation)
  );

  CREATE TABLE secrets (
    id         TEXT PRIMARY KEY,
    blob       BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE memory_fts USING fts5(
    symptoms, title, root_cause,
    content='memory', content_rowid='rowid',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, symptoms, title, root_cause)
    VALUES (new.rowid, new.symptoms, new.title, coalesce(new.root_cause, ''));
  END;
  CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, symptoms, title, root_cause)
    VALUES ('delete', old.rowid, old.symptoms, old.title, coalesce(old.root_cause, ''));
  END;
  CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, symptoms, title, root_cause)
    VALUES ('delete', old.rowid, old.symptoms, old.title, coalesce(old.root_cause, ''));
    INSERT INTO memory_fts(rowid, symptoms, title, root_cause)
    VALUES (new.rowid, new.symptoms, new.title, coalesce(new.root_cause, ''));
  END;
  `,

  // v2 — the session ledger: one row per provider session, every step (event)
  // tagged with the session it belongs to. Nothing about a run is ephemeral.
  `
  CREATE TABLE sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id  TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT,
    effort            TEXT,
    permission_mode   TEXT,
    native_session_id TEXT,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    outcome           TEXT
  );
  CREATE INDEX idx_sessions_inv ON sessions(investigation_id, id);

  ALTER TABLE events ADD COLUMN session_id INTEGER;
  `,

  // v3 — learned context: operational knowledge distilled per investigation,
  // user-approved before it enters future prompts ("where to look" knowledge).
  `
  CREATE TABLE learnings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    investigation_id TEXT,
    text             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted | rejected
    created_at       INTEGER NOT NULL,
    decided_at       INTEGER
  );
  CREATE INDEX idx_learnings_status ON learnings(status, id);
  `,

  // v4 — learnings scale past prompt size: embed accepted learnings and
  // retrieve by RELEVANCE at intake instead of injecting newest-N.
  `
  ALTER TABLE learnings ADD COLUMN embedded INTEGER NOT NULL DEFAULT 0;
  `,

  // v5 — the system knowledge map: how repos/services actually connect.
  // Seeded from the org's architecture docs; investigations propose deltas.
  `
  CREATE TABLE map_nodes (
    id      TEXT PRIMARY KEY,
    label   TEXT NOT NULL,
    kind    TEXT NOT NULL,
    repo    TEXT,
    grafana TEXT,
    notes   TEXT
  );
  CREATE TABLE map_edges (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id   TEXT NOT NULL,
    label   TEXT,
    kind    TEXT NOT NULL DEFAULT 'other',
    status  TEXT NOT NULL DEFAULT 'accepted',
    UNIQUE (from_id, to_id, label)
  );
  `,

  // v6 — token accounting: the SDK's result message reports usage per session;
  // persist it so cost-per-investigation is measured, not guessed.
  `
  ALTER TABLE sessions ADD COLUMN input_tokens      INTEGER;
  ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER;
  ALTER TABLE sessions ADD COLUMN cache_read_tokens  INTEGER;
  ALTER TABLE sessions ADD COLUMN output_tokens      INTEGER;
  ALTER TABLE sessions ADD COLUMN cost_usd           REAL;
  ALTER TABLE sessions ADD COLUMN num_turns          INTEGER;
  `,

  // v7 — Slack thread activity tracking. A thread's HEAD timestamp never
  // changes when replies arrive, so the old skip-unchanged check (keyed on
  // head ts) froze every thread at its first-sync snapshot — the diagnosis in
  // later replies never re-entered memory. We now track reply_count per thread
  // so the trailing re-scan only re-fetches replies (and re-distills) when a
  // thread has actually gained replies.
  `
  CREATE TABLE slack_threads (
    ts          TEXT PRIMARY KEY,
    reply_count INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,

  // v8 — cross-source linking. A Linear ticket and the Slack thread about the
  // same outage were walked by separate sync passes, so the linker never saw
  // both sides and each became its own divergent memory row. We now cross-link
  // them against the DB on ingest (by permalink / identifier) and collapse the
  // linked sibling at search time so one outage surfaces once.
  `
  ALTER TABLE memory ADD COLUMN linked_id TEXT;
  `,
]
