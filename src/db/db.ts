import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

// Ordered list of migrations. Index + 1 is the schema version stored in PRAGMA user_version.
const migrations: string[] = ["schema.sql", "002_outcomes.sql"].map((f) => readFileSync(join(here, f), "utf8"));

export function openDb(path = ":memory:"): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
