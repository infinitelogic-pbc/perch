//! The object tools. The MCP server exposes them one to one; the CLI reuses
//! them for `describe`, `call`, `fetch`, `test` and `import`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::engine::exec_sql;
use crate::host::{Event, Host, Outcome};
use crate::store::{Files, Manifest, Mode, PUBLIC_DIR, Store};

pub struct Tools {
    pub path: PathBuf,
    live: Option<Host>,
    preview: Option<Host>,
    /// Which of the two was created last. V8 isolates on one thread must be
    /// dropped newest first, so the pair is always dropped together, in order.
    preview_is_newer: bool,
}

#[derive(Deserialize, Default)]
pub struct ProposeArgs {
    /// path -> new contents (text, or { base64 } for binary), or null to delete the file
    #[serde(default)]
    pub files: BTreeMap<String, Option<FileValue>>,
    /// exact-string replacements in existing text files, applied after `files`
    #[serde(default)]
    pub edits: Vec<EditArg>,
    /// Start from the files of this earlier check-in instead of the live ones
    /// (a rollback that goes through the preview and the tests).
    #[serde(default)]
    pub from_checkin: Option<String>,
    /// Not accepted: schema lives in the object's code.
    #[serde(default)]
    pub migrations: Option<Value>,
    pub message: String,
}

#[derive(Deserialize, Clone)]
pub struct EditArg {
    pub path: String,
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub replace_all: bool,
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
    // Keep responses proportionate: the full listing inlines only small text
    // files; one file asked for by path comes back whole up to 512 KiB.
    const LIST_MAX: usize = 32 * 1024;
    const ONE_MAX: usize = 512 * 1024;
    match std::str::from_utf8(bytes) {
        Ok(_) if !full && bytes.len() > LIST_MAX => json!({ "text": true, "bytes": bytes.len(), "note": "large file: pass path to read it" }),
        Ok(s) if s.len() > ONE_MAX => {
            let mut end = ONE_MAX;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            json!({ "text": &s[..end], "truncated": true, "bytes": bytes.len() })
        }
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
    /// Set by read_object, never by MCP input: allow GET/HEAD.
    #[serde(skip)]
    pub allow_safe: bool,
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

/// Write a file list as a new check-in and make it live in `store`, in one
/// transaction.
fn commit_checkin(
    store: &Store,
    parent: Option<&str>,
    build: impl FnOnce(&Store) -> Result<Manifest>,
    message: &str,
) -> Result<String> {
    store.with_mode(Mode::Privileged, |c| c.execute_batch("BEGIN IMMEDIATE"))?;
    let r = (|| {
        // `build` stores any new blobs and returns the check-in's file list.
        let manifest = build(store)?;
        let id = store.insert_checkin(parent, &manifest, message)?;
        store.set_meta("live_checkin", &id)?;
        Ok::<_, anyhow::Error>(id)
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
        Ok(Tools { path, live: None, preview: None, preview_is_newer: false })
    }

    /// Stop both running objects, newest first. They restart on next use.
    fn drop_hosts(&mut self) {
        if self.preview_is_newer {
            self.preview = None;
            self.live = None;
        } else {
            self.live = None;
            self.preview = None;
        }
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
        // Code files are listed one by one. Static files can number in the tens
        // of thousands, so they are summarised: count, total size, a sample.
        let mut files: Vec<Value> = vec![];
        let (mut public_n, mut public_bytes, mut public_sample) = (0usize, 0u64, Vec::<&String>::new());
        for (p, h) in &ck.manifest {
            let size = s.blob_size(h)?;
            if p.starts_with(PUBLIC_DIR) {
                public_n += 1;
                public_bytes += size;
                if public_sample.len() < 20 {
                    public_sample.push(p);
                }
            } else {
                files.push(json!({ "path": p, "bytes": size }));
            }
        }
        let alarm = s.alarm()?;
        let kv_keys: i64 = s.with_mode(Mode::Privileged, |c| {
            c.query_row("SELECT count(*) FROM _perch_kv", [], |r| r.get(0))
        })?;
        let file_bytes = std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0);
        // The code history, newest first. An earlier check-in can be read with
        // read_code and restored with propose_change from_checkin.
        let all = s.checkins()?;
        let history: Vec<Value> = all
            .iter()
            .take(10)
            .map(|c| json!({ "id": c.id, "message": c.message, "at": iso(c.created_at), "live": c.id == live }))
            .collect();
        Ok(json!({
            "name": s.meta_req("name")?,
            "class": s.meta_req("class")?,
            "format_version": s.meta("format_version")?,
            "target": if is_preview { "preview" } else { "live" },
            "file": s.path.display().to_string(),
            "file_bytes": file_bytes,
            "live_checkin": { "id": ck.id, "message": ck.message, "at": iso(ck.created_at) },
            "checkins": { "total": all.len(), "recent": history },
            "tables": tables,
            "kv_keys": kv_keys,
            "files": files,
            "public": { "files": public_n, "bytes": public_bytes, "first": public_sample },
            "next_alarm": alarm_json(alarm),
            "preview": if is_preview {
                json!({ "base": s.meta("preview_base")?, "built": s.meta("preview_built")?.as_deref() == Some(live.as_str()) })
            } else {
                self.preview_state(&live)?
            },
        }))
    }

    pub fn read_code(&self, checkin: Option<&str>, path: Option<&str>) -> Result<Value> {
        let s = self.store()?;
        let preview;
        let (src, id): (&Store, String) = match checkin {
            Some("preview") => {
                preview = self.preview_store()?.ok_or_else(|| anyhow!("there is no preview copy; propose_change creates one"))?;
                let head = preview.live_checkin()?;
                (&preview, head)
            }
            Some(c) => (&s, s.resolve_checkin(c)?),
            None => (&s, s.live_checkin()?),
        };
        let manifest = src.manifest_at(&id)?;
        // Text comes back as a string. Binary comes back as { base64 } when asked
        // for by path, and as a stub in the full listing so it stays small.
        if let Some(p) = path {
            let h = manifest.get(p).ok_or_else(|| anyhow!("no file {p} at check-in {}", &id[..12]))?;
            return Ok(json!({ "checkin": id, "files": { p: file_json(&src.blob(h)?, true) } }));
        }
        // The full listing reads code files only. Static files under public/
        // are summarised, never loaded: there may be tens of thousands.
        let mut out: BTreeMap<String, Value> = BTreeMap::new();
        let (mut public_n, mut public_bytes) = (0usize, 0u64);
        for (p, h) in &manifest {
            if p.starts_with(PUBLIC_DIR) {
                public_n += 1;
                public_bytes += src.blob_size(h)?;
            } else if src.blob_size(h)? > 32 * 1024 {
                out.insert(p.clone(), json!({ "text": true, "bytes": src.blob_size(h)?, "note": "large file: pass path to read it" }));
            } else {
                out.insert(p.clone(), file_json(&src.blob(h)?, false));
            }
        }
        Ok(json!({
            "checkin": id,
            "files": out,
            "public": { "files": public_n, "bytes": public_bytes, "note": "static files are not listed here; pass path to read one" },
        }))
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
        if a.migrations.is_some() {
            bail!("propose_change takes no migrations: schema lives in the object's code. Put each step in migrations/NNNN_name.sql, import it as text, and run the pending ones in the constructor (see the server instructions).");
        }
        let live = self.store()?;
        let live_ck = live.live_checkin()?;
        let from = match a.from_checkin.as_deref() {
            Some("live") => Some(live_ck.clone()),
            Some(c) => Some(live.resolve_checkin(c)?),
            None => None,
        };
        let ppath = preview_path(&self.path);
        self.drop_hosts();
        // One pending change at a time. Its files carry over from the last
        // proposal; its data never does: every proposal starts from a fresh
        // copy of the live file, so the constructor (and any schema step) runs
        // against live's data as it is now. Nothing is replaced until the new
        // proposal has been checked, so a refused edit loses nothing.
        let mut source: Option<(Store, Manifest, String)> = None;
        let mut discarded_stale = false;
        if let Some(old) = self.preview_store()? {
            let base = old.meta("preview_base")?;
            let head = old.live_checkin()?;
            let pending = base.as_deref() != Some(head.as_str());
            if base.as_deref() != Some(live_ck.as_str()) {
                discarded_stale = pending;
            } else if pending && from.is_none() {
                let ck = old.checkin(&head)?;
                source = Some((old, ck.manifest, ck.message));
            }
        }
        let head_manifest = live.manifest_at(&live_ck)?;
        let continues = source.is_some();
        let mut manifest = match (&from, &source) {
            (Some(id), _) => live.manifest_at(id)?,
            (None, Some((_, m, _))) => m.clone(),
            (None, None) => head_manifest.clone(),
        };
        let read = |hash: &str| -> Result<Vec<u8>> {
            match &source {
                Some((old, _, _)) => old.blob(hash),
                None => live.blob(hash),
            }
        };
        let mut pending: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut changed = vec![];
        if from.is_some() {
            for path in head_manifest.keys().chain(manifest.keys()).collect::<std::collections::BTreeSet<_>>() {
                if !path.starts_with(PUBLIC_DIR) && head_manifest.get(path) != manifest.get(path) {
                    changed.push(if manifest.contains_key(path) { path.clone() } else { format!("{path} (deleted)") });
                }
            }
        }
        for (path, content) in &a.files {
            match content {
                Some(v) => {
                    let c = v.bytes().map_err(|e| anyhow!("{path}: {e}"))?;
                    let hash = crate::store::sha256_hex(&c);
                    if manifest.get(path) != Some(&hash) {
                        changed.push(path.clone());
                    }
                    manifest.insert(path.clone(), hash);
                    pending.insert(path.clone(), c);
                }
                None => {
                    pending.remove(path);
                    if manifest.remove(path).is_some() {
                        changed.push(format!("{path} (deleted)"));
                    }
                }
            }
        }
        for e in &a.edits {
            let cur = match pending.get(&e.path) {
                Some(c) => c.clone(),
                None => read(
                    manifest
                        .get(&e.path)
                        .ok_or_else(|| anyhow!("edit: no file {} (send new files whole in `files`)", e.path))?,
                )?,
            };
            let text = std::str::from_utf8(&cur).map_err(|_| anyhow!("edit: {} is not a text file", e.path))?;
            let n = text.matches(e.old.as_str()).count();
            if e.old.is_empty() || n == 0 {
                bail!("edit: `old` was not found in {}; it must match the file exactly, whitespace included (read_code shows the current text)", e.path);
            }
            if n > 1 && !e.replace_all {
                bail!("edit: `old` occurs {n} times in {}; add surrounding lines to make it unique, or set replace_all", e.path);
            }
            let next = if e.replace_all { text.replace(e.old.as_str(), &e.new) } else { text.replacen(e.old.as_str(), &e.new, 1) };
            if !changed.contains(&e.path) {
                changed.push(e.path.clone());
            }
            let next = next.into_bytes();
            manifest.insert(e.path.clone(), crate::store::sha256_hex(&next));
            pending.insert(e.path.clone(), next);
        }
        for (path, bytes) in &pending {
            crate::store::validate_path(path)?;
            if bytes.len() > crate::store::MAX_FILE_BYTES {
                bail!("{path} is {} bytes; files are limited to 25 MiB (Cloudflare's per-asset limit)", bytes.len());
            }
        }
        let has_tests = manifest.keys().any(|k| is_test_file(k));
        // Files the pending change brought earlier, which live does not hold.
        let mut carry = vec![];
        if let Some((old, _, _)) = &source {
            for hash in manifest.values() {
                if !live.has_blob(hash)? && old.has_blob(hash)? {
                    carry.push(old.blob(hash)?);
                }
            }
        }
        let earlier = source.map(|(_, _, message)| message);
        remove_db(&ppath);
        if manifest == head_manifest {
            // Nothing differs from live: there is no pending change to keep.
            return Ok(json!({
                "pending": false,
                "base": live_ck,
                "note": "the files are the same as live, so there is no pending change and no preview",
            }));
        }
        live.clone_to(&ppath)?;
        let p = Store::open(&ppath)?;
        p.set_meta("preview_base", &live_ck)?;
        for b in &carry {
            p.put_blob(b)?;
        }
        let build = |st: &Store| -> Result<Manifest> {
            for bytes in pending.values() {
                st.put_blob(bytes)?;
            }
            Ok(manifest.clone())
        };
        let message = match earlier {
            Some(e) => format!("{e}; {}", a.message),
            None => a.message.clone(),
        };
        let id = commit_checkin(&p, Some(&live_ck), build, &message)?;
        drop(p);
        // Build: load the module graph and run the constructor on the preview,
        // which is where the code creates or changes its tables.
        let built = match Host::open(&ppath, false) {
            Ok(mut h) => {
                let r = h.ensure().await;
                if r.is_ok() {
                    self.preview = Some(h);
                    self.preview_is_newer = true;
                }
                r
            }
            Err(e) => Err(e),
        };
        let ps = Store::open(&ppath)?;
        let schema = ps.schema()?;
        match &built {
            Ok(()) => ps.set_meta("preview_built", &id)?,
            Err(_) => ps.delete_meta("preview_built")?,
        }
        drop(ps);
        // Stored tests run on every proposal that builds.
        let tests = if built.is_ok() && has_tests {
            Some(self.run_tests(Some("preview")).await?)
        } else {
            None
        };
        let tests_ok = tests.as_ref().is_none_or(|t| t["ok"] == json!(true));
        Ok(json!({
            "tests": tests,
            "checkin": id,
            "base": live_ck,
            "pending": true,
            "message": message,
            "continues_pending_change": continues,
            "discarded_stale_change": discarded_stale,
            "from_checkin": from,
            "files_changed": changed,
            "schema": schema,
            "build": match &built { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "error": e.to_string() }) },
            "next": if built.is_err() { "fix the build error with another propose_change" } else if !tests_ok { "fix the failing tests with another propose_change; release_change is refused while they fail" } else { "try it with read_object and call_object (target preview), then release_change" },
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
                let method = c
                    .http_method
                    .clone()
                    .unwrap_or_else(|| if c.allow_safe && body.is_empty() { "GET".into() } else { "POST".into() })
                    .to_uppercase();
                // Reads and writes are separate tools: the write tools never take GET or HEAD.
                if !c.allow_safe && matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
                    bail!("{method} is a read: use read_object (target \"live\" or \"preview\"). This tool takes POST, PUT, PATCH and DELETE.");
                }
                Event::Fetch {
                    method,
                    url: format!("http://{name}.perch.local{path}"),
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

    /// A read of the object: GET/HEAD to fetch(), or a method call, with every
    /// write refused by the runtime and the transaction rolled back.
    pub async fn read_object(&mut self, mut c: CallArgs, target: Option<&str>) -> Result<Value> {
        let preview = match target {
            Some("preview") => true,
            None | Some("live") => false,
            Some(t) => bail!("target must be live or preview (got {t:?})"),
        };
        match c.kind.as_str() {
            "fetch" => {
                let m = c.http_method.clone().unwrap_or_else(|| "GET".into()).to_uppercase();
                if m != "GET" && m != "HEAD" {
                    bail!("read_object takes GET or HEAD; {m} changes data, so use call_object");
                }
                if !matches!(c.body, None | Some(Value::Null)) {
                    bail!("read_object requests have no body");
                }
                c.http_method = Some(m);
            }
            "rpc" => {}
            k => bail!("kind must be fetch or rpc (got {k:?})"),
        }
        c.allow_safe = true;
        let name = self.host(preview)?.store.meta_req("name")?;
        let ev = self.event_for(&c, &name)?;
        let o = self.host(preview)?.read_event(ev).await?;
        let mut v = outcome_json(&o);
        v["target"] = json!(if preview { "preview" } else { "live" });
        v["read_only"] = json!(true);
        Ok(v)
    }

    /// The running object for a target, opened on first use.
    fn host(&mut self, preview: bool) -> Result<&mut Host> {
        if preview {
            let ppath = preview_path(&self.path);
            if !ppath.exists() {
                bail!("there is no preview copy; propose_change creates one");
            }
            if self.preview.is_none() {
                self.preview = Some(Host::open(&ppath, false)?);
                self.preview_is_newer = true;
            }
            Ok(self.preview.as_mut().unwrap())
        } else {
            if self.live.is_none() {
                self.live = Some(Host::open(&self.path, false)?);
                self.preview_is_newer = false;
            }
            Ok(self.live.as_mut().unwrap())
        }
    }

    /// A write call: an unsafe HTTP method to fetch(), a public method, or (on
    /// the preview) the alarm handler.
    pub async fn call_object(&mut self, c: CallArgs, target: Option<&str>) -> Result<Value> {
        let preview = match target {
            Some("preview") => true,
            None | Some("live") => false,
            Some(t) => bail!("target must be live or preview (got {t:?})"),
        };
        // Validate the call shape (including "GET is a read") before anything else.
        self.event_for(&c, "check")?;
        if c.kind == "alarm" && !preview {
            bail!("alarms on the live object fire on schedule (perch run); to run alarm() by hand, use target \"preview\"");
        }
        let name = self.host(preview)?.store.meta_req("name")?;
        let ev = self.event_for(&c, &name)?;
        let h = self.host(preview)?;
        let o = h.event(ev).await?;
        let mut v = outcome_json(&o);
        v["target"] = json!(if preview { "preview" } else { "live" });
        if c.kind == "alarm" && (o.ok || o.alarm_missing) && !o.alarm_touched {
            // An alarm run by hand clears the pending alarm the way a fired one
            // does: only if the handler did not set or delete it itself.
            h.store.with_mode(Mode::Privileged, |c| c.execute("DELETE FROM _perch_alarms", []))?;
        }
        v["next_alarm"] = alarm_json(h.store.alarm()?);
        Ok(v)
    }

    pub async fn release_change(&mut self, message: Option<String>) -> Result<Value> {
        let live = self.store()?;
        let live_ck = live.live_checkin()?;
        let p = self.preview_store()?.ok_or_else(|| anyhow!("there is nothing to release; propose_change first"))?;
        let base = p.meta("preview_base")?;
        if base.as_deref() != Some(live_ck.as_str()) {
            bail!("the live check-in moved since this preview was made; propose the change again");
        }
        let head = p.live_checkin()?;
        if head == live_ck {
            bail!("the preview has no changes to release");
        }
        if p.meta("preview_built")?.as_deref() != Some(head.as_str()) {
            bail!("the preview head did not build; fix it with propose_change before releasing");
        }
        // Stored tests gate the release. There is no override: fix the code or
        // change the test, and either way it shows in the history.
        if p.manifest_at(&head)?.keys().any(|k| is_test_file(k))
            && p.meta("preview_tested")?.as_deref() != Some(head.as_str())
        {
            let t = self.run_tests(Some("preview")).await?;
            if t["ok"] != json!(true) {
                let failing: Vec<String> = t["results"]
                    .as_array()
                    .map(|r| r.iter().filter(|x| x["ok"] != json!(true)).map(|x| format!("{} > {}", x["file"].as_str().unwrap_or(""), x["name"].as_str().unwrap_or(""))).collect())
                    .unwrap_or_default();
                bail!(
                    "refusing to release: {} of {} stored tests fail ({}){}. Fix them with propose_change; the errors are in propose_change's result.",
                    t["failed"], t["total"], failing.join("; "),
                    t["error"].as_str().map(|e| format!(": {e}")).unwrap_or_default()
                );
            }
        }
        // The preview holds one pending check-in on top of live.
        let ck = p.checkin(&head)?;
        if ck.parent.as_deref() != Some(live_ck.as_str()) {
            bail!("the preview is not based on the live check-in; propose the change again");
        }
        let manifest = ck.manifest;
        let live_manifest = live.manifest_at(&live_ck)?;
        let msg = message.unwrap_or(ck.message);
        // Copy across only the files live does not already have, by hash.
        let build = |st: &Store| -> Result<Manifest> {
            for (path, hash) in &manifest {
                if live_manifest.get(path) != Some(hash) {
                    st.put_blob(&p.blob(hash)?)?;
                }
            }
            Ok(manifest.clone())
        };
        let id = commit_checkin(&live, Some(&live_ck), build, &msg)?;
        // Start the new code on the live data now: its constructor is where the
        // schema changes. If it throws, its writes are rolled back, and the
        // release is undone by pointing live back at the code it had.
        self.drop_hosts();
        let started = match Host::open(&self.path, false) {
            Ok(mut h) => {
                let r = h.ensure().await;
                if r.is_ok() {
                    self.live = Some(h);
                    self.preview_is_newer = false;
                }
                r
            }
            Err(e) => Err(e),
        };
        if let Err(e) = started {
            live.set_meta("live_checkin", &live_ck)?;
            live.with_mode(Mode::Privileged, |c| c.execute("DELETE FROM _perch_checkins WHERE id=?", [&id]))?;
            bail!("release undone; live is unchanged. The new code did not start on the live data (it did on the preview's copy, so live data has changed since): {e:#}\nPropose the change again: the preview is rebuilt from live each time.");
        }
        drop(p);
        self.preview = None;
        remove_db(&preview_path(&self.path));
        Ok(json!({
            "released": id,
            "previous": live_ck,
            "message": msg,
            "schema": live.schema()?,
        }))
    }

    // ------------------------------------------------------------ stored tests

    /// Run the object's `test/` files. Every test gets its own fresh, empty
    /// copy of the object (same code, no data; its constructor builds the tables), so
    /// tests are deterministic and never see live or preview data.
    pub async fn run_tests(&mut self, target: Option<&str>) -> Result<Value> {
        let use_preview = match target {
            Some("live") => false,
            Some("preview") => true,
            _ => preview_path(&self.path).exists(),
        };
        let s = if use_preview {
            self.preview_store()?.ok_or_else(|| anyhow!("there is no preview copy; propose_change creates one"))?
        } else {
            self.store()?
        };
        let head = s.live_checkin()?;
        // Tests drive the class, not public/, so scratch copies carry code only.
        let files = s.code_files_at(&head)?;
        let test_files: Vec<String> = files.keys().filter(|p| is_test_file(p)).cloned().collect();
        let which = if use_preview { "preview" } else { "live" };
        if test_files.is_empty() {
            return Ok(json!({ "ok": true, "target": which, "total": 0, "passed": 0, "failed": 0, "results": [], "note": "no test files; add test/*.ts that import { test, expect } from \"perch:test\"" }));
        }
        let (name, class) = (s.meta_req("name")?, s.meta_req("class")?);
        let dir = std::env::temp_dir().join(format!("perch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        let r = async {
            // One empty template, copied per test.
            let template = dir.join("template.perch");
            drop(Store::create(&template, &name, &class, &files, "test")?);
            let fresh = |i: usize| -> Result<PathBuf> {
                let p = dir.join(format!("t{i}.perch"));
                std::fs::copy(&template, &p)?;
                Ok(p)
            };
            let mut lister = Host::open_for_tests(&fresh(0)?, test_files.clone())?;
            let listed = match lister.event(Event::TestList).await {
                Ok(o) if o.ok => o.result.unwrap_or(json!([])),
                Ok(o) => return Ok(json!({ "ok": false, "target": which, "total": 0, "passed": 0, "failed": 0, "results": [], "error": o.error })),
                Err(e) => return Ok(json!({ "ok": false, "target": which, "total": 0, "passed": 0, "failed": 0, "results": [], "error": format!("the tests did not load: {e:#}") })),
            };
            drop(lister);
            let mut results = vec![];
            let (mut passed, mut failed) = (0, 0);
            for (i, t) in listed.as_array().cloned().unwrap_or_default().into_iter().enumerate() {
                let file = t["file"].as_str().unwrap_or("").to_string();
                let tname = t["name"].as_str().unwrap_or("").to_string();
                let started = std::time::Instant::now();
                let mut h = Host::open_for_tests(&fresh(i + 1)?, vec![file.clone()])?;
                let out = h.event(Event::TestRun { file: file.clone(), name: tname.clone() }).await;
                let ms = started.elapsed().as_millis() as u64;
                let entry = match out {
                    Ok(o) if o.ok => {
                        passed += 1;
                        json!({ "file": file, "name": tname, "ok": true, "ms": ms })
                    }
                    Ok(o) => {
                        failed += 1;
                        json!({ "file": file, "name": tname, "ok": false, "ms": ms, "error": o.error, "logs": o.logs })
                    }
                    Err(e) => {
                        failed += 1;
                        json!({ "file": file, "name": tname, "ok": false, "ms": ms, "error": format!("{e:#}") })
                    }
                };
                results.push(entry);
            }
            Ok::<_, anyhow::Error>(json!({
                "ok": failed == 0,
                "target": which,
                "checkin": head,
                "total": passed + failed,
                "passed": passed,
                "failed": failed,
                "results": results,
            }))
        }
        .await;
        let _ = std::fs::remove_dir_all(&dir);
        let v = r?;
        if use_preview {
            if v["ok"] == json!(true) {
                s.set_meta("preview_tested", &head)?;
            } else {
                s.delete_meta("preview_tested")?;
            }
        }
        Ok(v)
    }

    // ------------------------------------------------------------ bulk import

    /// Import a directory of static files from disk into the live object's
    /// `public/` tree, as one check-in. Files stream from disk into the blob
    /// table one at a time, so the size of the directory does not matter, and
    /// nothing passes through the caller. Static files cannot change what the
    /// class does, so this goes straight to live without a preview.
    pub fn import_files(
        &mut self,
        dir: &Path,
        into: Option<&str>,
        message: Option<String>,
        prune: bool,
        progress: &mut dyn FnMut(usize),
    ) -> Result<Value> {
        let mut into = into.unwrap_or(PUBLIC_DIR).trim_start_matches('/').to_string();
        if !into.ends_with('/') {
            into.push('/');
        }
        if !into.starts_with(PUBLIC_DIR) {
            bail!("import goes under public/ (got {into:?}); code and tests change through propose_change");
        }
        if !dir.is_dir() {
            bail!("{} is not a directory", dir.display());
        }
        let live = self.store()?;
        let live_ck = live.live_checkin()?;
        if let Some(p) = self.preview_store()? {
            if p.meta("preview_base")?.as_deref() == Some(live_ck.as_str()) {
                bail!("there is an unreleased preview; release it (or discard it with propose_change from_checkin: \"live\") before importing, because an import moves the live check-in");
            }
        }
        let base = live.manifest_at(&live_ck)?;
        let msg = message.unwrap_or_else(|| format!("import {} into {into}", dir.display()));
        let mut stats = crate::store::ImportStats::default();
        let build = |st: &Store| -> Result<Manifest> {
            let mut m = base.clone();
            stats = st.import_dir(dir, &into, &mut m, prune, progress)?;
            if stats.added + stats.replaced + stats.removed == 0 {
                bail!("{NOTHING_TO_IMPORT}");
            }
            Ok(m)
        };
        let done = commit_checkin(&live, Some(&live_ck), build, &msg);
        let total = |ck: &str| -> Result<usize> { Ok(live.manifest_at(ck)?.keys().filter(|k| k.starts_with(PUBLIC_DIR)).count()) };
        match done {
            Ok(id) => {
                self.drop_hosts();
                Ok(json!({
                    "imported": true,
                    "checkin": id,
                    "into": into,
                    "added": stats.added,
                    "replaced": stats.replaced,
                    "unchanged": stats.unchanged,
                    "removed": stats.removed,
                    "bytes_read": stats.bytes,
                    "public_files": total(&id)?,
                }))
            }
            Err(e) if e.to_string() == NOTHING_TO_IMPORT => Ok(json!({
                "imported": false,
                "into": into,
                "unchanged": stats.unchanged,
                "public_files": total(&live_ck)?,
                "note": "every file is already in the object with the same contents; nothing was changed",
            })),
            Err(e) => Err(e),
        }
    }

}

const NOTHING_TO_IMPORT: &str = "nothing to import";

/// Directories `perch new --from` reads object files from.
pub const CODE_DIRS: &[&str] = &["src", "test", "migrations"];

pub fn is_test_file(path: &str) -> bool {
    path.starts_with("test/") && (path.ends_with(".ts") || path.ends_with(".js"))
}

pub fn read_dir_bytes(root: &Path, dir: &Path, out: &mut Files) -> Result<()> {
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        if p.is_dir() {
            read_dir_bytes(root, &p, out)?;
        } else if p.file_name().is_some_and(|n| n != ".DS_Store") {
            let rel = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            out.insert(rel, std::fs::read(&p)?);
        }
    }
    Ok(())
}
