//! The nine object tools. The MCP server exposes them one to one; the CLI
//! reuses them for `describe`, `checkins`, `call` and `fetch`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow, bail};
use rusqlite::session::Session;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::engine::exec_sql;
use crate::host::{Event, Host, Outcome};
use crate::store::{Files, Migration, Mode, PUBLIC_DIR, Store, now_ms, schema_fits};

pub struct Tools {
    pub path: PathBuf,
    live: Option<Host>,
    preview: Option<Host>,
}

#[derive(Deserialize, Default)]
pub struct ProposeArgs {
    /// path -> new contents (text, or { base64 } for binary), or null to delete the file
    #[serde(default)]
    pub files: BTreeMap<String, Option<FileValue>>,
    #[serde(default)]
    pub migrations: Vec<Migration>,
    pub message: String,
    #[serde(default)]
    pub restart: bool,
}

#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum FileValue {
    Text(String),
    Binary { base64: String },
}

impl FileValue {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        use base64::Engine;
        match self {
            FileValue::Text(s) => Ok(s.clone().into_bytes()),
            FileValue::Binary { base64 } => base64::engine::general_purpose::STANDARD
                .decode(base64.trim())
                .map_err(|e| anyhow!("invalid base64: {e}")),
        }
    }
}

fn file_json(bytes: &[u8], full: bool) -> Value {
    use base64::Engine;
    match std::str::from_utf8(bytes) {
        Ok(s) => Value::String(s.to_string()),
        Err(_) if full => json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }),
        Err(_) => json!({ "binary": true, "bytes": bytes.len(), "sha256": crate::store::sha256_hex(bytes) }),
    }
}

#[derive(Deserialize, Default, Clone)]
pub struct CallArgs {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub http_method: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub args: Vec<Value>,
}

pub fn preview_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.preview", path.display()))
}

fn remove_db(path: &Path) {
    for ext in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), ext));
    }
}

fn iso(ms: i64) -> String {
    // Minimal RFC 3339 (UTC) without pulling in a date crate.
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Write files + migrations as a new check-in and make it live in `store`,
/// all in one transaction. Migration data changes are recorded as a changeset.
fn commit_checkin(
    store: &Store,
    parent: Option<&str>,
    files: &Files,
    migrations: &[Migration],
    message: &str,
) -> Result<(String, Vec<String>)> {
    store.with_mode(Mode::Privileged, |c| c.execute_batch("BEGIN IMMEDIATE"))?;
    let r = (|| {
        let manifest = store.put_files(files)?;
        let id = store.insert_checkin(parent, &manifest, message)?;
        let conn = store.conn.clone();
        let mut session = Session::new(&conn)?;
        session.table_filter(Some(|t: &str| !t.starts_with("_obj_") || t == "_obj_kv"));
        session.attach::<&str>(None)?;
        let warnings = store.apply_migrations(migrations, &id)?;
        let mut cs = Vec::new();
        session.changeset_strm(&mut cs)?;
        drop(session);
        if !cs.is_empty() {
            store.with_mode(Mode::Privileged, |c| {
                c.execute(
                    "INSERT INTO _obj_changes(at, event, checkin, changeset) VALUES (?, 'migration', ?, ?)",
                    rusqlite::params![now_ms(), id, cs],
                )
            })?;
        }
        store.snapshot_schema(&id)?;
        store.set_meta("live_checkin", &id)?;
        Ok::<_, anyhow::Error>((id, warnings))
    })();
    match r {
        Ok(v) => {
            store.with_mode(Mode::Privileged, |c| c.execute_batch("COMMIT"))?;
            let _ = store.with_mode(Mode::Privileged, |c| c.execute_batch("PRAGMA wal_checkpoint(PASSIVE)"));
            Ok(v)
        }
        Err(e) => {
            let _ = store.with_mode(Mode::Privileged, |c| c.execute_batch("ROLLBACK"));
            Err(e)
        }
    }
}

fn alarm_json(a: Option<(i64, i64)>) -> Value {
    a.map(|(at, retry)| json!({ "at": iso(at), "at_ms": at, "retry_count": retry }))
        .unwrap_or(Value::Null)
}

pub fn outcome_json(o: &Outcome) -> Value {
    let mut v = serde_json::to_value(o).unwrap_or(Value::Null);
    if o.status.is_some() {
        let ct = o
            .headers
            .iter()
            .find(|(k, _)| k == "content-type")
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        let text = String::from_utf8_lossy(&o.body);
        let text: String = if text.len() > 65_536 {
            format!("{}… ({} bytes)", &text[..65_536], o.body.len())
        } else {
            text.into_owned()
        };
        if ct.contains("json") {
            if let Ok(j) = serde_json::from_str::<Value>(&text) {
                v["json"] = j;
            } else {
                v["body"] = Value::String(text);
            }
        } else {
            v["body"] = Value::String(text);
        }
    }
    v
}

impl Tools {
    pub fn new(path: PathBuf) -> Result<Tools> {
        Store::open(&path)?;
        Ok(Tools { path, live: None, preview: None })
    }

    fn store(&self) -> Result<Store> {
        Store::open(&self.path)
    }

    fn preview_store(&self) -> Result<Option<Store>> {
        let p = preview_path(&self.path);
        if p.exists() { Ok(Some(Store::open(&p)?)) } else { Ok(None) }
    }

    fn preview_state(&self, live_ck: &str) -> Result<Value> {
        let Some(p) = self.preview_store()? else {
            return Ok(json!({ "exists": false }));
        };
        let base = p.meta("preview_base")?;
        let head = p.live_checkin()?;
        let built = p.meta("preview_built")?;
        Ok(json!({
            "exists": true,
            "base": base,
            "head": head,
            "built": built.as_deref() == Some(head.as_str()),
            "stale": base.as_deref() != Some(live_ck),
        }))
    }

    pub fn describe(&self, target: Option<&str>) -> Result<Value> {
        let is_preview = target == Some("preview");
        let s = if is_preview {
            self.preview_store()?
                .ok_or_else(|| anyhow!("there is no preview copy; propose_change creates one"))?
        } else {
            self.store()?
        };
        let live = s.live_checkin()?;
        let ck = s.checkin(&live)?;
        let schema = s.schema()?;
        let counts = s.row_counts()?;
        let tables: Vec<Value> = schema
            .iter()
            .map(|(t, cols)| {
                json!({
                    "name": t,
                    "rows": counts.get(t).copied().unwrap_or(0),
                    "columns": cols,
                })
            })
            .collect();
        let files: Vec<Value> = ck
            .manifest
            .iter()
            .map(|(p, h)| {
                let size = s.blob(h).map(|b| b.len()).unwrap_or(0);
                json!({ "path": p, "bytes": size })
            })
            .collect();
        let alarm = s.alarm()?;
        let kv_keys: i64 = s.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT count(*) FROM _obj_kv", [], |r| r.get(0))
        })?;
        let changes: i64 = s.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT count(*) FROM _obj_changes", [], |r| r.get(0))
        })?;
        let file_bytes = std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0);
        Ok(json!({
            "name": s.meta_req("name")?,
            "class": s.meta_req("class")?,
            "main": s.meta("main")?,
            "format_version": s.meta("format_version")?,
            "api_version": s.meta("api_version")?,
            "target": if is_preview { "preview" } else { "live" },
            "file": s.path.display().to_string(),
            "file_bytes": file_bytes,
            "live_checkin": { "id": ck.id, "message": ck.message, "at": iso(ck.created_at) },
            "tables": tables,
            "kv_keys": kv_keys,
            "files": files.iter().filter(|f| !f["path"].as_str().unwrap_or("").starts_with(PUBLIC_DIR)).collect::<Vec<_>>(),
            "public": files.iter().filter(|f| f["path"].as_str().unwrap_or("").starts_with(PUBLIC_DIR)).collect::<Vec<_>>(),
            "migrations_applied": s.migrations()?.len(),
            "next_alarm": alarm_json(alarm),
            "recorded_changesets": changes,
            "preview": if is_preview {
                json!({ "base": s.meta("preview_base")?, "built": s.meta("preview_built")?.as_deref() == Some(live.as_str()) })
            } else {
                self.preview_state(&live)?
            },
        }))
    }

    pub fn read_code(&self, checkin: Option<&str>, path: Option<&str>) -> Result<Value> {
        let s = self.store()?;
        let (id, files) = match checkin {
            Some("preview") => {
                let p = self.preview_store()?.ok_or_else(|| anyhow!("there is no preview copy; propose_change creates one"))?;
                let head = p.live_checkin()?;
                (head.clone(), p.files_at(&head)?)
            }
            Some(c) => {
                let id = s.resolve_checkin(c)?;
                (id.clone(), s.files_at(&id)?)
            }
            None => {
                let id = s.live_checkin()?;
                (id.clone(), s.files_at(&id)?)
            }
        };
        // Text comes back as a string. Binary comes back as { base64 } when asked
        // for by path, and as a stub in the full listing so it stays small.
        let out: BTreeMap<String, Value> = match path {
            Some(p) => {
                let c = files.get(p).ok_or_else(|| anyhow!("no file {p} at check-in {}", &id[..12]))?;
                BTreeMap::from([(p.to_string(), file_json(c, true))])
            }
            None => files.iter().map(|(p, c)| (p.clone(), file_json(c, false))).collect(),
        };
        Ok(json!({ "checkin": id, "files": out }))
    }

    pub fn list_checkins(&self, limit: usize, diffs: bool) -> Result<Value> {
        let s = self.store()?;
        let live = s.live_checkin()?;
        let all = s.checkins()?;
        let migs = s.migrations()?;
        let mut out = Vec::new();
        for ck in all.iter().take(limit) {
            let added: Vec<Value> = migs
                .iter()
                .filter(|m| m.3 == ck.id)
                .map(|m| json!({ "seq": m.0, "name": m.1, "sql": m.2 }))
                .collect();
            let mut entry = json!({
                "id": ck.id,
                "parent": ck.parent,
                "message": ck.message,
                "at": iso(ck.created_at),
                "live": ck.id == live,
                "files": ck.manifest.keys().collect::<Vec<_>>(),
                "migrations": added,
            });
            if diffs {
                let parent_files = match &ck.parent {
                    Some(p) => s.files_at(p).unwrap_or_default(),
                    None => BTreeMap::new(),
                };
                let files = s.files_at(&ck.id)?;
                let mut d = String::new();
                let paths: std::collections::BTreeSet<&String> = parent_files.keys().chain(files.keys()).collect();
                for p in paths {
                    let (ab, bb) = (parent_files.get(p), files.get(p));
                    if ab == bb {
                        continue;
                    }
                    let (a, b) = match (
                        ab.map(|x| std::str::from_utf8(x)).transpose(),
                        bb.map(|x| std::str::from_utf8(x)).transpose(),
                    ) {
                        (Ok(a), Ok(b)) => (a.unwrap_or(""), b.unwrap_or("")),
                        _ => {
                            d.push_str(&format!("Binary file {p} differs\n"));
                            continue;
                        }
                    };
                    let diff = similar::TextDiff::from_lines(a, b);
                    let from = if parent_files.contains_key(p) { format!("a/{p}") } else { "/dev/null".into() };
                    let to = if files.contains_key(p) { format!("b/{p}") } else { "/dev/null".into() };
                    d.push_str(&diff.unified_diff().context_radius(3).header(&from, &to).to_string());
                }
                entry["diff"] = Value::String(d);
            }
            out.push(entry);
        }
        Ok(json!({ "live": live, "checkins": out, "total": all.len() }))
    }

    pub fn query_data(&self, sql: &str, params: &[Value], target: Option<&str>) -> Result<Value> {
        let s = match target {
            Some("preview") => self.preview_store()?.ok_or_else(|| anyhow!("there is no preview copy"))?,
            _ => self.store()?,
        };
        let r = s.with_mode(Mode::ReadOnly, |c| {
            c.execute_batch("PRAGMA query_only = ON").ok();
            let r = exec_sql(c, sql, params);
            c.execute_batch("PRAGMA query_only = OFF").ok();
            r
        });
        let (columns, mut rows, _) = r.map_err(|e| anyhow!("{e}"))?;
        let truncated = rows.len() > 500;
        rows.truncate(500);
        Ok(json!({ "columns": columns, "rows": rows, "row_count": rows.len(), "truncated": truncated }))
    }

    pub async fn propose_change(&mut self, a: ProposeArgs) -> Result<Value> {
        if a.message.trim().is_empty() {
            bail!("propose_change needs a message describing the change");
        }
        let live = self.store()?;
        let live_ck = live.live_checkin()?;
        let ppath = preview_path(&self.path);
        let stack = !a.restart
            && match self.preview_store()? {
                Some(p) => p.meta("preview_base")?.as_deref() == Some(live_ck.as_str()),
                None => false,
            };
        self.preview = None;
        if !stack {
            remove_db(&ppath);
            live.backup_to(&ppath)?;
            let p = Store::open(&ppath)?;
            p.set_meta("preview_base", &live_ck)?;
            p.delete_meta("preview_built")?;
        }
        let p = Store::open(&ppath)?;
        let head = p.live_checkin()?;
        let mut files = p.files_at(&head)?;
        let mut changed = vec![];
        for (path, content) in &a.files {
            match content {
                Some(v) => {
                    let c = v.bytes().map_err(|e| anyhow!("{path}: {e}"))?;
                    if files.get(path) != Some(&c) {
                        changed.push(path.clone());
                    }
                    files.insert(path.clone(), c);
                }
                None => {
                    if files.remove(path).is_some() {
                        changed.push(format!("{path} (deleted)"));
                    }
                }
            }
        }
        let (id, warnings) = commit_checkin(&p, Some(&head), &files, &a.migrations, &a.message)
            .map_err(|e| anyhow!("{e}\n(the preview is unchanged; fix the migration or code and propose again)"))?;
        let schema = p.schema()?;
        drop(p);
        // Build: load the module graph and run the constructor on the preview.
        let built = match Host::open(&ppath, false) {
            Ok(mut h) => {
                let r = h.ensure().await;
                if r.is_ok() {
                    self.preview = Some(h);
                }
                r
            }
            Err(e) => Err(e),
        };
        let ps = Store::open(&ppath)?;
        match &built {
            Ok(()) => ps.set_meta("preview_built", &id)?,
            Err(_) => ps.delete_meta("preview_built")?,
        }
        Ok(json!({
            "checkin": id,
            "base": live_ck,
            "stacked_on_previous_preview": stack,
            "files_changed": changed,
            "migrations_applied": a.migrations.iter().map(|m| &m.name).collect::<Vec<_>>(),
            "warnings": warnings,
            "schema": schema,
            "build": match &built { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "error": e.to_string() }) },
            "next": if built.is_ok() { "test_call against the preview, then release_change" } else { "fix the build error with another propose_change" },
        }))
    }

    fn event_for(&self, c: &CallArgs, name: &str) -> Result<Event> {
        Ok(match c.kind.as_str() {
            "fetch" => {
                let path = c.path.clone().unwrap_or_else(|| "/".into());
                if !path.starts_with('/') {
                    bail!("path must start with /");
                }
                let mut headers: Vec<(String, String)> =
                    c.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
                let body = match &c.body {
                    None | Some(Value::Null) => vec![],
                    Some(Value::String(s)) => s.clone().into_bytes(),
                    Some(other) => {
                        if !headers.iter().any(|(k, _)| k == "content-type") {
                            headers.push(("content-type".into(), "application/json".into()));
                        }
                        serde_json::to_vec(other)?
                    }
                };
                Event::Fetch {
                    method: c.http_method.clone().unwrap_or_else(|| if body.is_empty() { "GET".into() } else { "POST".into() }).to_uppercase(),
                    url: format!("http://{name}.pdo.local{path}"),
                    headers,
                    body,
                }
            }
            "rpc" => Event::Rpc {
                method: c.method.clone().ok_or_else(|| anyhow!("rpc calls need method"))?,
                args: c.args.clone(),
            },
            "alarm" => Event::Alarm { retry_count: 0 },
            k => bail!("kind must be fetch, rpc or alarm (got {k:?})"),
        })
    }

    pub async fn test_call(&mut self, c: CallArgs) -> Result<Value> {
        let ppath = preview_path(&self.path);
        if !ppath.exists() {
            bail!("there is no preview copy; propose_change creates one");
        }
        if self.preview.is_none() {
            self.preview = Some(Host::open(&ppath, false)?);
        }
        let h = self.preview.as_mut().unwrap();
        let name = h.store.meta_req("name")?;
        let ev = self.event_for(&c, &name)?;
        let h = self.preview.as_mut().unwrap();
        let o = h.event(ev).await?;
        let mut v = outcome_json(&o);
        v["target"] = json!("preview");
        if c.kind == "alarm" && (o.ok || o.alarm_missing) && !o.alarm_touched {
            // An alarm run by hand clears the pending alarm the way a fired one
            // does: only if the handler did not set or delete it itself.
            h.store.with_mode(Mode::Privileged, |c| c.execute("DELETE FROM _obj_alarms", []))?;
        }
        v["next_alarm"] = alarm_json(h.store.alarm()?);
        Ok(v)
    }

    pub async fn call_object(&mut self, c: CallArgs) -> Result<Value> {
        if self.live.is_none() {
            self.live = Some(Host::open(&self.path, false)?);
        }
        let name = self.live.as_ref().unwrap().store.meta_req("name")?;
        let ev = self.event_for(&c, &name)?;
        let o = self.live.as_mut().unwrap().event(ev).await?;
        let mut v = outcome_json(&o);
        v["target"] = json!("live");
        v["next_alarm"] = alarm_json(self.live.as_ref().unwrap().store.alarm()?);
        Ok(v)
    }

    pub async fn release_change(&mut self, message: Option<String>) -> Result<Value> {
        let live = self.store()?;
        let live_ck = live.live_checkin()?;
        let p = self.preview_store()?.ok_or_else(|| anyhow!("there is nothing to release; propose_change first"))?;
        let base = p.meta("preview_base")?;
        if base.as_deref() != Some(live_ck.as_str()) {
            bail!("the live check-in moved since this preview was made; propose again with restart: true");
        }
        let head = p.live_checkin()?;
        if head == live_ck {
            bail!("the preview has no changes to release");
        }
        if p.meta("preview_built")?.as_deref() != Some(head.as_str()) {
            bail!("the preview head did not build; fix it with propose_change before releasing");
        }
        // Walk the preview chain head -> base.
        let mut chain = vec![];
        let mut cur = head.clone();
        while cur != live_ck {
            let ck = p.checkin(&cur)?;
            chain.push(ck.clone());
            cur = ck.parent.ok_or_else(|| anyhow!("preview chain does not reach the live check-in"))?;
        }
        chain.reverse();
        let ids: HashSet<&str> = chain.iter().map(|c| c.id.as_str()).collect();
        let migrations: Vec<Migration> = p
            .migrations()?
            .into_iter()
            .filter(|m| ids.contains(m.3.as_str()))
            .map(|m| Migration { name: m.1, sql: m.2 })
            .collect();
        let files = p.files_at(&head)?;
        let msg = message.unwrap_or_else(|| {
            chain.iter().map(|c| c.message.as_str()).collect::<Vec<_>>().join("; ")
        });
        drop(p);
        let (id, warnings) = commit_checkin(&live, Some(&live_ck), &files, &migrations, &msg)
            .map_err(|e| anyhow!("release failed and was rolled back; live is unchanged: {e}"))?;
        self.preview = None;
        self.live = None;
        remove_db(&preview_path(&self.path));
        Ok(json!({
            "released": id,
            "previous": live_ck,
            "message": msg,
            "migrations_applied": migrations.iter().map(|m| &m.name).collect::<Vec<_>>(),
            "squashed_preview_checkins": chain.len(),
            "warnings": warnings,
        }))
    }

    pub fn rollback_code(&mut self, checkin: &str) -> Result<Value> {
        let s = self.store()?;
        let live_ck = s.live_checkin()?;
        let target = s.checkin(checkin)?;
        if target.id == live_ck {
            bail!("{} is already live", &target.id[..12]);
        }
        let now = s.schema()?;
        let old = target.schema.clone().unwrap_or_default();
        if let Err(problems) = schema_fits(&old, &now) {
            bail!(
                "refusing: check-in {} expects a schema that no longer matches (migrations only go forward):\n- {}",
                &target.id[..12],
                problems.join("\n- ")
            );
        }
        s.set_meta("live_checkin", &target.id)?;
        self.live = None;
        Ok(json!({
            "live": target.id,
            "previous": live_ck,
            "message": target.message,
            "note": "code moved back; schema and data are unchanged",
        }))
    }
}
