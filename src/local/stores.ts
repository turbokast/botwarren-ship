/**
 * Two physically separate SQLite databases:
 *  - private.db: journal of canonical events, outbox, quarantine, settings, audit. Opened ONLY by the agent's local service.
 *  - public.db:  published public events + publication meta. The replicator opens it read-only: it is the only thing that is ever sent.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CanonicalEvent, PublicEvent, type PublicEventDraft } from '../vendor/core/contract.ts';

function open(path: string, readOnly = false): DatabaseSync {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout=5000;'); // first, so startup waits for a previous process to release locks
  if (!readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  return db;
}

export interface OutboxRow { identity: string; draft: PublicEventDraft; classifiedAt: string; releaseAt: string }

export class PrivateStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = open(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal (event_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, ingested_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_observed ON journal(observed_at);
      CREATE TABLE IF NOT EXISTS outbox_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, draft TEXT NOT NULL, classified_at TEXT NOT NULL, release_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_v2_release ON outbox_v2(release_at);
      CREATE INDEX IF NOT EXISTS outbox_v2_identity ON outbox_v2(identity);
      DROP TABLE IF EXISTS outbox;
      CREATE TABLE IF NOT EXISTS quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, reason TEXT NOT NULL, event_id TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
    `);
    if (!this.getSetting('pseudonym_salt')) this.setSetting('pseudonym_salt', randomBytes(32).toString('hex'));
  }

  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return r?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  /** Inserts if new. Returns false for duplicates (idempotent ingest). */
  append(e: CanonicalEvent, now: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO journal(event_id, observed_at, type, body, ingested_at) VALUES (?,?,?,?,?)')
      .run(e.eventId, e.observedAt, e.type, JSON.stringify(e), now);
    return r.changes > 0;
  }

  *allEvents(): Generator<CanonicalEvent> {
    for (const row of this.db.prepare('SELECT body FROM journal ORDER BY observed_at, event_id').iterate() as Iterable<{ body: string }>) {
      yield CanonicalEvent.parse(JSON.parse(row.body));
    }
  }

  recentEvents(limit: number): CanonicalEvent[] {
    return (this.db.prepare('SELECT body FROM journal ORDER BY observed_at DESC LIMIT ?').all(limit) as { body: string }[])
      .map((r) => CanonicalEvent.parse(JSON.parse(r.body)));
  }

  /**
   * Versioned enqueue: every state version waits its OWN full delay (no early release).
   * Coalescing happens at publish time: of the versions that are due, only the newest is published.
   */
  enqueue(identity: string, draft: PublicEventDraft, classifiedAt: string, releaseAt: string): void {
    this.db.prepare('INSERT INTO outbox_v2(identity, draft, classified_at, release_at) VALUES (?,?,?,?)').run(identity, JSON.stringify(draft), classifiedAt, releaseAt);
  }

  /** Newest due version per identity; older due versions of the same identity are superseded. */
  due(now: string): (OutboxRow & { id: number })[] {
    const rows = (this.db.prepare('SELECT * FROM outbox_v2 WHERE release_at <= ? ORDER BY identity, id').all(now) as Record<string, string | number>[]);
    const latest = new Map<string, Record<string, string | number>>();
    for (const r of rows) latest.set(String(r.identity), r);
    return [...latest.values()].sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => ({ id: Number(r.id), identity: String(r.identity), draft: JSON.parse(String(r.draft)) as PublicEventDraft, classifiedAt: String(r.classified_at), releaseAt: String(r.release_at) }));
  }
  pending(): OutboxRow[] {
    return (this.db.prepare('SELECT * FROM outbox_v2 ORDER BY id').all() as Record<string, string>[])
      .map((r) => ({ identity: r.identity!, draft: JSON.parse(r.draft!) as PublicEventDraft, classifiedAt: r.classified_at!, releaseAt: r.release_at! }));
  }
  /** Removes the given version and every older version of the same identity. */
  consumeThrough(identity: string, id: number): void { this.db.prepare('DELETE FROM outbox_v2 WHERE identity=? AND id<=?').run(identity, id); }
  /** Revocation: drop all pending versions of an identity. */
  removeOutbox(identity: string): void { this.db.prepare('DELETE FROM outbox_v2 WHERE identity=?').run(identity); }
  /** Code map switched off: nothing about areas may wait in the outbox any longer. */
  removeAreaOutbox(): number { return Number(this.db.prepare("DELETE FROM outbox_v2 WHERE identity LIKE 'area:%' OR identity LIKE 'areas:%'").run().changes); }
  clearOutbox(): number { return Number(this.db.prepare('DELETE FROM outbox_v2').run().changes); }

  quarantine(reason: string, eventId: string | null, detail: string, now: string): void {
    this.db.prepare('INSERT INTO quarantine(at, reason, event_id, detail) VALUES (?,?,?,?)').run(now, reason, eventId, detail.slice(0, 500));
  }
  quarantined(limit = 100): unknown[] { return this.db.prepare('SELECT * FROM quarantine ORDER BY id DESC LIMIT ?').all(limit); }
  quarantineCounts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT reason, count(*) n FROM quarantine GROUP BY reason').all() as { reason: string; n: number }[]).map((r) => [r.reason, r.n]));
  }

  audit(actor: string, action: string, detail: string, now: string): void {
    this.db.prepare('INSERT INTO audit(at, actor, action, detail) VALUES (?,?,?,?)').run(now, actor, action, detail);
  }
  audits(limit = 50): unknown[] { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit); }
  journalCount(): number { return (this.db.prepare('SELECT count(*) n FROM journal').get() as { n: number }).n; }
}

export class PublicStoreWriter {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = open(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, published_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_published ON events(published_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- kept for compatibility with stores written by earlier versions
      CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, world TEXT NOT NULL);
    `);
  }
  /** Publishes after strict re-validation. Returns the stored event. */
  publish(draft: PublicEventDraft, now: string): PublicEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last = (this.db.prepare("SELECT max(coalesce((SELECT max(seq) FROM events),0), coalesce((SELECT CAST(value AS INTEGER) FROM meta WHERE key='seq_high'),0)) s").get() as { s: number }).s;
      const ev = PublicEvent.parse({ ...draft, seq: last + 1, publishedAt: now });
      this.setMeta('seq_high', String(ev.seq));
      this.db.prepare('INSERT INTO events(seq, body, published_at) VALUES (?,?,?)').run(ev.seq, JSON.stringify(ev), now);
      this.db.exec('COMMIT');
      return ev;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  /** Highest sequence number ever stored (retired events included, so seq never goes backwards after retention). */
  maxSeq(): number { return Math.max((this.db.prepare('SELECT coalesce(max(seq),0) s FROM events').get() as { s: number }).s, this.snapshotSeq()); }
  snapshotSeq(): number { return (this.db.prepare('SELECT coalesce(max(seq),0) s FROM snapshot').get() as { s: number }).s; }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  /** Emergency purge: removes all public history (caches/third-party copies cannot be recalled). */
  purge(): void {
    this.db.exec('DELETE FROM events; DELETE FROM snapshot;');
    this.setMeta('epoch', String(Number(this.db.prepare("SELECT value FROM meta WHERE key='epoch'").get()?.value ?? 0) + 1));
  }
}

export class PublicStoreReader {
  readonly db: DatabaseSync;
  constructor(path: string) { this.db = open(path, true); }
  after(seq: number, limit = 500): PublicEvent[] {
    return (this.db.prepare('SELECT body FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as { body: string }[])
      .map((r) => PublicEvent.parse(JSON.parse(r.body)));
  }
  maxSeq(): number { return (this.db.prepare('SELECT coalesce(max(seq),0) s FROM events').get() as { s: number }).s; }
  minSeq(): number { return (this.db.prepare('SELECT coalesce(min(seq),0) s FROM events').get() as { s: number }).s; }
  meta(): Record<string, string> {
    return Object.fromEntries((this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  }
}
