import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type DB = Database.Database;
const MIGRATIONS = process.env.ACC_MIGRATIONS_DIR ?? join(import.meta.dirname, "../migrations");

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB, dir = MIGRATIONS) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(f, Date.now());
    })();
  }
}

/** Id ordenável por tempo (ms em hex + aleatório). */
export const newId = (now = Date.now()) => now.toString(16).padStart(12, "0") + randomBytes(6).toString("hex");
