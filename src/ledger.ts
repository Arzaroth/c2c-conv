// The ledger: what happened in a session, kept after it ends. claude cannot
// tell a bozo's message from the host's, which is the point, and it means the
// transcript cannot say who sent a turn either. This can, because the
// ringmaster already knows at the moment it happens.
//
// node:sqlite is built into node 22.13 and later. On an older node the ledger
// is off and the session runs as it always did: this is a record, never a path
// anything else waits on.

export const MAX_LEDGER_ROWS = 200_000
const PRUNE_EVERY = 500

export type LedgerKind =
  | 'f2f' | 'sent' | 'held' | 'approved' | 'denied' | 'delivered' | 'failed'
  | 'key' | 'mode' | 'trust' | 'join' | 'leave' | 'whiteface' | 'kick' | 'rotate' | 'start'

export interface LedgerEvent {
  kind: LedgerKind
  who?: string | null
  bozo?: string | null
  ref?: string | null
  text?: string | null
}

export interface LedgerRow extends Required<LedgerEvent> {
  id: number
  at: number
}

interface Statement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

type Opener = new (path: string, options?: { readOnly?: boolean }) => Database

async function opener(): Promise<Opener | null> {
  try {
    return (await import('node:sqlite')).DatabaseSync as unknown as Opener
  } catch {
    return null
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    who TEXT,
    bozo TEXT,
    ref TEXT,
    text TEXT
  );
  CREATE INDEX IF NOT EXISTS events_kind ON events(kind, id);
`

export class Ledger {
  #db: Database
  #insert: Statement
  #prune: Statement
  #sinceprune = 0
  #cap: number

  private constructor(db: Database, cap: number) {
    this.#db = db
    this.#cap = cap
    this.#insert = db.prepare('INSERT INTO events (at, kind, who, bozo, ref, text) VALUES (?, ?, ?, ?, ?, ?)')
    this.#prune = db.prepare('DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - ?')
  }

  static async open(path: string, { cap = MAX_LEDGER_ROWS }: { cap?: number } = {}): Promise<Ledger | null> {
    const Sqlite = await opener()
    if (!Sqlite) return null
    const db = new Sqlite(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)
    return new Ledger(db, cap)
  }

  // Never throws: a full disk or a locked file costs the record, not the session.
  record({ kind, who = null, bozo = null, ref = null, text = null }: LedgerEvent, at = Date.now()): void {
    try {
      this.#insert.run(at, kind, who, bozo, ref, text)
      if (++this.#sinceprune >= PRUNE_EVERY) {
        this.#sinceprune = 0
        this.#prune.run(this.#cap)
      }
    } catch (err) {
      console.error(`[ledger] ${(err as Error).message}`)
    }
  }

  close(): void {
    try {
      this.#db.close()
    } catch {}
  }
}

export interface LedgerQuery {
  kinds?: LedgerKind[]
  grep?: string
  limit?: number
}

// Read straight from the file, so it works with no ringmaster running and after
// the session has been stopped.
export async function readLedger(path: string, { kinds, grep, limit = 100 }: LedgerQuery = {}): Promise<LedgerRow[] | null> {
  const Sqlite = await opener()
  if (!Sqlite) return null
  const db = new Sqlite(path, { readOnly: true })
  try {
    const where: string[] = []
    const params: unknown[] = []
    if (kinds?.length) {
      where.push(`kind IN (${kinds.map(() => '?').join(', ')})`)
      params.push(...kinds)
    }
    if (grep) {
      where.push(`(text LIKE ? ESCAPE '\\' OR who LIKE ? ESCAPE '\\')`)
      const like = `%${grep.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      params.push(like, like)
    }
    const sql = `SELECT * FROM (SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?) ORDER BY id`
    return db.prepare(sql).all(...params, limit) as LedgerRow[]
  } finally {
    db.close()
  }
}
