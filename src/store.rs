//! The object file: one SQLite database holding a Durable Object's code,
//! history, runtime state and data.
//!
//! Reserved tables all start with `_perch_`. Everything else is the object's
//! own data, created only by migrations. The authorizer installed in
//! [`Store::open`] enforces that boundary according to the current [`Mode`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FORMAT_VERSION: i64 = 2;
pub const API_VERSION: &str = "perch-v0";
pub const DEFAULT_MAIN: &str = "src/index.ts";

/// Who is running SQL right now. The authorizer reads this on every statement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Mode {
    /// The runtime or MCP wrapper itself: anything goes.
    Privileged = 0,
    /// Object code via `ctx.storage.sql`: data tables only, no DDL, no transactions.
    Sandbox = 1,
    /// `query_data`: reads of data tables only.
    ReadOnly = 2,
    /// A migration: DDL and DML on data tables, never on reserved ones.
    Migration = 3,
}

#[derive(Clone)]
pub struct ModeCell(Arc<AtomicU8>);

impl ModeCell {
    pub fn get(&self) -> Mode {
        match self.0.load(Ordering::SeqCst) {
            1 => Mode::Sandbox,
            2 => Mode::ReadOnly,
            3 => Mode::Migration,
            _ => Mode::Privileged,
        }
    }
    pub fn set(&self, m: Mode) -> Mode {
        let old = self.get();
        self.0.store(m as u8, Ordering::SeqCst);
        old
    }
}

fn reserved(name: &str) -> bool {
    name.starts_with("_perch_")
}

fn internal(name: &str) -> bool {
    name.starts_with("sqlite_")
}

fn authorize(mode: Mode, ctx: AuthContext<'_>) -> Authorization {
    use AuthAction::*;
    if mode == Mode::Privileged {
        return Authorization::Allow;
    }
    if let Some(db) = ctx.database_name {
        if db == "temp" && mode != Mode::Migration {
            return Authorization::Deny;
        }
    }
    let table_ok = |t: &str| !reserved(t);
    match ctx.action {
        Select | Recursive | Function { .. } => Authorization::Allow,
        Read { table_name, .. } => {
            if table_ok(table_name) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        Insert { table_name } | Delete { table_name } | Update { table_name, .. } => {
            // DDL in a migration writes sqlite_master itself; let it.
            if mode == Mode::Migration && internal(table_name) {
                Authorization::Allow
            } else if mode == Mode::ReadOnly || !table_ok(table_name) || internal(table_name) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }
        Pragma { pragma_name, .. } => {
            // Read-only introspection pragmas only.
            const OK: &[&str] = &[
                "table_info",
                "table_xinfo",
                "table_list",
                "index_list",
                "index_info",
                "index_xinfo",
                "foreign_key_list",
            ];
            if OK.contains(&pragma_name.to_ascii_lowercase().as_str()) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        CreateTable { table_name } | DropTable { table_name } | AlterTable { table_name, .. } => {
            if mode == Mode::Migration && table_ok(table_name) && !internal(table_name) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        CreateIndex { table_name, .. }
        | DropIndex { table_name, .. }
        | CreateTrigger { table_name, .. }
        | DropTrigger { table_name, .. } => {
            if mode == Mode::Migration && table_ok(table_name) {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        CreateView { .. } | DropView { .. } | Reindex { .. } | Analyze { .. } => {
            if mode == Mode::Migration {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }
        // BEGIN/COMMIT/SAVEPOINT, ATTACH, temp objects, virtual tables: never from
        // object code or migrations. The runtime owns transactions.
        _ => Authorization::Deny,
    }
}

const SCHEMA: &str = r#"
CREATE TABLE _perch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE _perch_blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE _perch_checkins (
  id TEXT PRIMARY KEY,
  parent TEXT,
  manifest TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  schema TEXT
);
CREATE TABLE _perch_migrations (
  seq INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  checkin TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE _perch_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE _perch_alarms (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  scheduled_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE _perch_changes (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  checkin TEXT,
  changeset BLOB NOT NULL
);
"#;

pub type Manifest = BTreeMap<String, String>;
/// Path -> file contents.
pub type Files = BTreeMap<String, Vec<u8>>;
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
/// Files under this prefix are served as-is at the matching URL path.
pub const PUBLIC_DIR: &str = "public/";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Checkin {
    pub id: String,
    pub parent: Option<String>,
    pub manifest: Manifest,
    pub message: String,
    pub created_at: i64,
    pub schema: Option<Schema>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub notnull: bool,
    pub default: Option<String>,
    pub pk: i64,
}

/// Table name to columns, for every data table.
pub type Schema = BTreeMap<String, Vec<Column>>;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Migration {
    pub name: String,
    pub sql: String,
}

/// What a directory import did.
#[derive(Serialize, Default, Debug, Clone)]
pub struct ImportStats {
    pub added: usize,
    pub replaced: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub bytes: u64,
}

pub struct Store {
    pub conn: Rc<Connection>,
    pub mode: ModeCell,
    pub path: PathBuf,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

impl Store {
    /// Open an existing object file.
    pub fn open(path: &Path) -> Result<Store> {
        if !path.exists() {
            bail!("no object file at {}", path.display());
        }
        let s = Self::open_raw(path)?;
        let v: Option<String> = s.meta("format_version")?;
        match v.as_deref() {
            Some("2") => Ok(s),
            Some(other) => bail!("this file is format version {other}; this perch reads only version {FORMAT_VERSION} (the format is still moving, and older files are not converted)"),
            None => bail!("{} is not a portable object file", path.display()),
        }
    }

    fn open_raw(path: &Path) -> Result<Store> {
        let mut conn = Connection::open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mode = ModeCell(Arc::new(AtomicU8::new(Mode::Privileged as u8)));
        let m = mode.clone();
        conn.authorizer(Some(move |ctx: AuthContext<'_>| authorize(m.get(), ctx)))?;
        Ok(Store {
            conn: Rc::new(conn),
            mode,
            path: path.to_path_buf(),
        })
    }

    /// Create a new object file with an initial check-in.
    pub fn create(
        path: &Path,
        name: &str,
        class: &str,
        files: &Files,
        migrations: &[Migration],
        message: &str,
    ) -> Result<Store> {
        Self::create_with(path, name, class, files, migrations, message, |_, _| Ok(()))
    }

    /// As [`create`](Self::create), with `extra` adding more files to the first
    /// check-in inside the same transaction (a streamed `public/` directory).
    pub fn create_with(
        path: &Path,
        name: &str,
        class: &str,
        files: &Files,
        migrations: &[Migration],
        message: &str,
        extra: impl FnOnce(&Store, &mut Manifest) -> Result<()>,
    ) -> Result<Store> {
        if path.exists() {
            bail!("{} already exists", path.display());
        }
        let s = Self::open_raw(path)?;
        s.conn.execute_batch(SCHEMA)?;
        s.set_meta("format_version", &FORMAT_VERSION.to_string())?;
        s.set_meta("api_version", API_VERSION)?;
        s.set_meta("name", name)?;
        s.set_meta("class", class)?;
        s.set_meta("main", DEFAULT_MAIN)?;
        s.set_meta("created_at", &now_ms().to_string())?;
        s.conn.execute_batch("BEGIN IMMEDIATE")?;
        let r = (|| {
            let mut manifest = s.put_files(files)?;
            extra(&s, &mut manifest)?;
            let id = s.insert_checkin(None, &manifest, message)?;
            s.apply_migrations(migrations, &id)?;
            s.snapshot_schema(&id)?;
            s.set_meta("live_checkin", &id)?;
            Ok::<_, anyhow::Error>(())
        })();
        match r {
            Ok(()) => s.conn.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = s.conn.execute_batch("ROLLBACK");
                drop(s);
                let _ = std::fs::remove_file(path);
                return Err(e);
            }
        }
        Ok(s)
    }

    /// Run `f` with the authorizer in `mode`, restoring the previous mode after.
    pub fn with_mode<T>(&self, mode: Mode, f: impl FnOnce(&Connection) -> T) -> T {
        let old = self.mode.set(mode);
        let r = f(&self.conn);
        self.mode.set(old);
        r
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        self.with_mode(Mode::Privileged, |c| {
            // _perch_meta may not exist when probing a foreign file.
            let exists: bool = c
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_perch_meta'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|n| n > 0)?;
            if !exists {
                return Ok(None);
            }
            Ok(c.query_row("SELECT value FROM _perch_meta WHERE key=?", [key], |r| r.get(0))
                .optional()?)
        })
    }

    pub fn meta_req(&self, key: &str) -> Result<String> {
        self.meta(key)?.ok_or_else(|| anyhow!("object file is missing meta {key}"))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.with_mode(Mode::Privileged, |c| {
            c.execute(
                "INSERT INTO _perch_meta(key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [key, value],
            )
        })?;
        Ok(())
    }

    pub fn delete_meta(&self, key: &str) -> Result<()> {
        self.with_mode(Mode::Privileged, |c| {
            c.execute("DELETE FROM _perch_meta WHERE key=?", [key])
        })?;
        Ok(())
    }

    pub fn put_blob(&self, data: &[u8]) -> Result<String> {
        let hash = sha256_hex(data);
        self.with_mode(Mode::Privileged, |c| {
            c.execute(
                "INSERT OR IGNORE INTO _perch_blobs(hash, size, data) VALUES (?, ?, ?)",
                params![hash, data.len() as i64, data],
            )
        })?;
        Ok(hash)
    }

    pub fn blob(&self, hash: &str) -> Result<Vec<u8>> {
        self.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT data FROM _perch_blobs WHERE hash=?", [hash], |r| r.get(0))
                .optional()
        })?
        .ok_or_else(|| anyhow!("missing blob {hash}"))
    }

    pub fn put_files(&self, files: &Files) -> Result<Manifest> {
        let mut m = Manifest::new();
        for (path, content) in files {
            validate_path(path)?;
            if content.len() > MAX_FILE_BYTES {
                bail!("{path} is {} bytes; files are limited to 25 MiB (Cloudflare's per-asset limit)", content.len());
            }
            m.insert(path.clone(), self.put_blob(content)?);
        }
        Ok(m)
    }

    pub fn insert_checkin(
        &self,
        parent: Option<&str>,
        manifest: &Manifest,
        message: &str,
    ) -> Result<String> {
        let created_at = now_ms();
        let manifest_json = serde_json::to_string(manifest)?;
        let id = sha256_hex(
            serde_json::json!({
                "parent": parent, "manifest": manifest, "message": message, "created_at": created_at
            })
            .to_string()
            .as_bytes(),
        );
        self.with_mode(Mode::Privileged, |c| {
            c.execute(
                "INSERT INTO _perch_checkins(id, parent, manifest, message, created_at) VALUES (?, ?, ?, ?, ?)",
                params![id, parent, manifest_json, message, created_at],
            )
        })?;
        Ok(id)
    }

    pub fn checkin(&self, id: &str) -> Result<Checkin> {
        let id = self.resolve_checkin(id)?;
        self.with_mode(Mode::Privileged, |c| {
            c.query_row(
                "SELECT id, parent, manifest, message, created_at, schema FROM _perch_checkins WHERE id=?",
                [&id],
                row_to_checkin,
            )
        })
        .map_err(|e| anyhow!("check-in {id}: {e}"))
    }

    /// Accept a full id or a unique prefix (at least 4 characters).
    pub fn resolve_checkin(&self, id: &str) -> Result<String> {
        if id.len() < 4 {
            bail!("check-in id {id:?} is too short");
        }
        let ids: Vec<String> = self.with_mode(Mode::Privileged, |c| {
            let mut st = c.prepare("SELECT id FROM _perch_checkins WHERE id LIKE ? || '%'")?;
            let v = st
                .query_map([id], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>();
            v
        })?;
        match ids.len() {
            1 => Ok(ids.into_iter().next().unwrap()),
            0 => bail!("no check-in {id}"),
            _ => bail!("check-in prefix {id} is ambiguous"),
        }
    }

    pub fn checkins(&self) -> Result<Vec<Checkin>> {
        self.with_mode(Mode::Privileged, |c| {
            let mut st = c.prepare(
                "SELECT id, parent, manifest, message, created_at, schema FROM _perch_checkins ORDER BY created_at DESC",
            )?;
            let v = st
                .query_map([], row_to_checkin)?
                .collect::<rusqlite::Result<Vec<_>>>();
            v
        })
        .map_err(Into::into)
    }

    pub fn live_checkin(&self) -> Result<String> {
        self.meta_req("live_checkin")
    }

    /// The file list at a check-in (path -> blob hash). Never loads contents.
    pub fn manifest_at(&self, checkin: &str) -> Result<Manifest> {
        Ok(self.checkin(checkin)?.manifest)
    }

    /// The files code can import or test at a check-in: everything except
    /// `public/`. Static files are never loaded to run code; an object may
    /// hold tens of thousands of them.
    pub fn code_files_at(&self, checkin: &str) -> Result<Files> {
        let mut out = BTreeMap::new();
        for (path, hash) in self.checkin(checkin)?.manifest {
            if !path.starts_with(PUBLIC_DIR) {
                out.insert(path, self.blob(&hash)?);
            }
        }
        Ok(out)
    }

    /// A blob's size in bytes, without reading it.
    pub fn blob_size(&self, hash: &str) -> Result<u64> {
        let n: Option<i64> = self.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT size FROM _perch_blobs WHERE hash=?", [hash], |r| r.get(0)).optional()
        })?;
        Ok(n.unwrap_or(0) as u64)
    }

    /// Stream a directory tree into the blob table and `manifest`, one file in
    /// memory at a time. `into` is the manifest prefix (ending in `/`). With
    /// `prune`, manifest entries under `into` that the directory lacks are
    /// removed. The caller owns the transaction and the check-in.
    pub fn import_dir(
        &self,
        dir: &Path,
        into: &str,
        manifest: &mut Manifest,
        prune: bool,
        progress: &mut dyn FnMut(usize),
    ) -> Result<ImportStats> {
        let mut stats = ImportStats::default();
        let mut seen = std::collections::HashSet::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&d)
                .with_context(|| format!("reading {}", d.display()))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .collect();
            entries.sort();
            for p in entries {
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if name.starts_with('.') {
                    continue; // .DS_Store, dotfiles
                }
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let rel = p.strip_prefix(dir)?.to_string_lossy().replace('\\', "/");
                let path = format!("{into}{rel}");
                validate_path(&path)?;
                let bytes = std::fs::read(&p).with_context(|| format!("reading {}", p.display()))?;
                if bytes.len() > MAX_FILE_BYTES {
                    bail!("{} is {} bytes; files are limited to 25 MiB (Cloudflare's per-asset limit)", p.display(), bytes.len());
                }
                let hash = self.put_blob(&bytes)?;
                stats.bytes += bytes.len() as u64;
                match manifest.insert(path.clone(), hash.clone()) {
                    None => stats.added += 1,
                    Some(old) if old == hash => stats.unchanged += 1,
                    Some(_) => stats.replaced += 1,
                }
                seen.insert(path);
                progress(seen.len());
            }
        }
        if prune {
            let gone: Vec<String> = manifest.keys().filter(|k| k.starts_with(into) && !seen.contains(*k)).cloned().collect();
            for k in gone {
                manifest.remove(&k);
                stats.removed += 1;
            }
        }
        Ok(stats)
    }

    pub fn migrations(&self) -> Result<Vec<(i64, String, String, String, i64)>> {
        self.with_mode(Mode::Privileged, |c| {
            let mut st = c.prepare(
                "SELECT seq, name, sql, checkin, applied_at FROM _perch_migrations ORDER BY seq",
            )?;
            let v = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<Vec<_>>>();
            v
        })
        .map_err(Into::into)
    }

    /// Run migrations under the migration authorizer and record them. The
    /// caller owns the surrounding transaction.
    pub fn apply_migrations(&self, migrations: &[Migration], checkin: &str) -> Result<Vec<String>> {
        let mut warnings = Vec::new();
        for m in migrations {
            if m.name.trim().is_empty() {
                bail!("every migration needs a name");
            }
            if m.sql.to_ascii_lowercase().contains("autoincrement") {
                bail!("migration {:?}: AUTOINCREMENT is not allowed in data tables; use UUIDv7 TEXT primary keys", m.name);
            }
            self.with_mode(Mode::Migration, |c| c.execute_batch(&m.sql))
                .map_err(|e| anyhow!("migration {:?} failed: {e}", m.name))?;
            self.with_mode(Mode::Privileged, |c| {
                c.execute(
                    "INSERT INTO _perch_migrations(name, sql, checkin, applied_at) VALUES (?, ?, ?, ?)",
                    params![m.name, m.sql, checkin, now_ms()],
                )
            })?;
        }
        // Data-key rules: declared primary keys, no AUTOINCREMENT.
        let schema = self.schema()?;
        for (table, cols) in &schema {
            let pk: Vec<&Column> = cols.iter().filter(|c| c.pk > 0).collect();
            if pk.is_empty() {
                bail!(
                    "table {table} has no declared PRIMARY KEY; data tables need one (UUIDv7 text recommended) so changesets from two copies never collide"
                );
            }
            if pk.len() == 1 && pk[0].ty.eq_ignore_ascii_case("INTEGER") {
                warnings.push(format!(
                    "table {table}: INTEGER PRIMARY KEY auto-assigns rowids; two copies will collide. Prefer UUIDv7 TEXT keys."
                ));
            }
        }
        let has_seq: i64 = self.with_mode(Mode::Privileged, |c| {
            c.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence'",
                [],
                |r| r.get(0),
            )
        })?;
        if has_seq > 0 {
            bail!("AUTOINCREMENT is not allowed in data tables; use UUIDv7 TEXT primary keys");
        }
        Ok(warnings)
    }

    /// The current shape of every data table.
    pub fn schema(&self) -> Result<Schema> {
        self.with_mode(Mode::Privileged, |c| {
            let mut tables = c.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_perch\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
            )?;
            let names = tables
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut out = Schema::new();
            for t in names {
                let mut st = c.prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?)")?;
                let cols = st
                    .query_map([&t], |r| {
                        Ok(Column {
                            name: r.get(0)?,
                            ty: r.get(1)?,
                            notnull: r.get::<_, i64>(2)? != 0,
                            default: r.get(3)?,
                            pk: r.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                out.insert(t, cols);
            }
            Ok(out)
        })
    }

    pub fn snapshot_schema(&self, checkin: &str) -> Result<()> {
        let s = serde_json::to_string(&self.schema()?)?;
        self.with_mode(Mode::Privileged, |c| {
            c.execute("UPDATE _perch_checkins SET schema=? WHERE id=?", [&s, checkin])
        })?;
        Ok(())
    }

    pub fn row_counts(&self) -> Result<BTreeMap<String, i64>> {
        let schema = self.schema()?;
        let mut out = BTreeMap::new();
        for t in schema.keys() {
            let n: i64 = self.with_mode(Mode::Privileged, |c| {
                c.query_row(&format!("SELECT count(*) FROM \"{}\"", t.replace('"', "\"\"")), [], |r| r.get(0))
            })?;
            out.insert(t.clone(), n);
        }
        Ok(out)
    }

    pub fn alarm(&self) -> Result<Option<(i64, i64)>> {
        Ok(self.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT scheduled_at, retry_count FROM _perch_alarms WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
        })?)
    }

    /// Copy the whole file (data included) to `dest` with SQLite's backup API.
    pub fn backup_to(&self, dest: &Path) -> Result<()> {
        for ext in ["", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{}", dest.display(), ext));
            if p.exists() {
                std::fs::remove_file(&p)?;
            }
        }
        self.with_mode(Mode::Privileged, |c| {
            c.backup(rusqlite::MAIN_DB, dest, None::<fn(rusqlite::backup::Progress)>)
        })?;
        Ok(())
    }
}

fn row_to_checkin(r: &rusqlite::Row<'_>) -> rusqlite::Result<Checkin> {
    let manifest: String = r.get(2)?;
    let schema: Option<String> = r.get(5)?;
    Ok(Checkin {
        id: r.get(0)?,
        parent: r.get(1)?,
        manifest: serde_json::from_str(&manifest).unwrap_or_default(),
        message: r.get(3)?,
        created_at: r.get(4)?,
        schema: schema.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

pub fn validate_path(p: &str) -> Result<()> {
    if p.is_empty()
        || p.starts_with('/')
        || p.contains('\\')
        || p.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        bail!("invalid file path {p:?}: use relative paths like src/index.ts");
    }
    Ok(())
}

/// Does code written against `old` still fit the database shape `now`?
/// Every table and column `old` knew must still exist, and no column added
/// since may be NOT NULL without a default (old code's inserts would fail).
pub fn schema_fits(old: &Schema, now: &Schema) -> std::result::Result<(), Vec<String>> {
    let mut problems = Vec::new();
    for (table, cols) in old {
        let Some(now_cols) = now.get(table) else {
            problems.push(format!("table {table} no longer exists"));
            continue;
        };
        for c in cols {
            if !now_cols.iter().any(|n| n.name == c.name) {
                problems.push(format!("column {table}.{} no longer exists", c.name));
            }
        }
        for n in now_cols {
            if !cols.iter().any(|c| c.name == n.name) && n.notnull && n.default.is_none() && n.pk == 0 {
                problems.push(format!(
                    "column {table}.{} was added NOT NULL without a default; older code cannot insert",
                    n.name
                ));
            }
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}
