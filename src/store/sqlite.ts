import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrations } from './schema.ts';

export type Row = Record<string, unknown>;

/**
 * Thin synchronous SQLite wrapper (built-in node:sqlite, no native build step).
 * One daemon process owns one database; writes are serialized by the caller
 * and by BEGIN IMMEDIATE. Nested `transaction` calls join the outer one.
 */
export class Store {
  readonly path: string;
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ':memory:') {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 10000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    const current = Number(row.user_version ?? 0);
    for (let version = current; version < migrations.length; version++) {
      this.transaction(() => {
        this.db.exec(migrations[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }
  get<T extends Row = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T extends Row = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  close(): void { this.db.close(); }
}
