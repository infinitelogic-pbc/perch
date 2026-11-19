import s1 from "../migrations/0001_todos.sql";

/** Schema steps, in order. Add a file and an entry; never edit a released step. */
const STEPS: Record<string, string> = {
  "0001_todos": s1,
};

/** Run each step once. The same code runs on Cloudflare and in a .perch file. */
export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS schema_steps (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set(sql.exec("SELECT name FROM schema_steps").toArray().map((r) => r.name));
    for (const [name, step] of Object.entries(STEPS)) {
      if (done.has(name)) continue;
      sql.exec(step);
      sql.exec("INSERT INTO schema_steps (name, applied_at) VALUES (?, ?)", name, Date.now());
    }
  });
}
