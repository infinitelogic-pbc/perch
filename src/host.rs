//! The object host: owns one object file and one engine, and runs events one
//! at a time. Every event is one SQLite transaction with a session attached;
//! its changeset is recorded in `_obj_changes` before commit.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use rusqlite::session::{ChangesetIter, Session};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::engine::{Dispatched, Engine, LogLine};
use crate::store::{DEFAULT_MAIN, Mode, Store, now_ms};

pub enum Event {
    Fetch {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    Rpc {
        method: String,
        args: Vec<Value>,
    },
    Alarm {
        retry_count: i64,
    },
}

#[derive(Serialize, Default, Debug, Clone)]
pub struct TableChanges {
    pub inserts: u64,
    pub updates: u64,
    pub deletes: u64,
}

#[derive(Serialize, Debug)]
pub struct Outcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<(String, String)>,
    #[serde(skip)]
    pub body: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub logs: Vec<LogLine>,
    pub changes: BTreeMap<String, TableChanges>,
    pub checkin: String,
    #[serde(skip)]
    pub alarm_missing: bool,
    /// The handler called setAlarm/deleteAlarm, so the runtime leaves the alarm alone.
    #[serde(skip)]
    pub alarm_touched: bool,
}

pub struct Host {
    pub store: Store,
    engine: Option<Engine>,
    loaded: Option<String>,
    echo_logs: bool,
    /// Logs from a constructor run, carried into the next outcome.
    pending_logs: Vec<LogLine>,
}

/// Count rows touched per table in a changeset.
pub fn summarize_changeset(bytes: &[u8]) -> BTreeMap<String, TableChanges> {
    use fallible_streaming_iterator::FallibleStreamingIterator;
    let mut out: BTreeMap<String, TableChanges> = BTreeMap::new();
    if bytes.is_empty() {
        return out;
    }
    let mut reader: &[u8] = bytes;
    let input: &mut dyn Read = &mut reader;
    let Ok(mut it) = ChangesetIter::start_strm(&input) else {
        return out;
    };
    while let Ok(Some(item)) = it.next() {
        if let Ok(op) = item.op() {
            let e = out.entry(op.table_name().to_string()).or_default();
            match op.code() {
                rusqlite::hooks::Action::SQLITE_INSERT => e.inserts += 1,
                rusqlite::hooks::Action::SQLITE_UPDATE => e.updates += 1,
                rusqlite::hooks::Action::SQLITE_DELETE => e.deletes += 1,
                _ => {}
            }
        }
    }
    out
}

impl Host {
    pub fn open(path: &Path, echo_logs: bool) -> Result<Host> {
        Ok(Host {
            store: Store::open(path)?,
            engine: None,
            loaded: None,
            echo_logs,
            pending_logs: vec![],
        })
    }

    /// Make sure the engine runs the live check-in, rebuilding it (and running
    /// the constructor) when the live check-in moved since the last event.
    pub async fn ensure(&mut self) -> Result<()> {
        let live = self.store.live_checkin()?;
        if self.engine.is_some() && self.loaded.as_deref() == Some(live.as_str()) {
            return Ok(());
        }
        self.engine = None;
        self.loaded = None;
        let files = self.store.files_at(&live)?;
        let main = self.store.meta("main")?.unwrap_or_else(|| DEFAULT_MAIN.to_string());
        let class = self.store.meta_req("class")?;
        let name = self.store.meta_req("name")?;
        let engine = Engine::load(
            self.store.conn.clone(),
            self.store.mode.clone(),
            files,
            &main,
            self.echo_logs,
        )
        .await?;
        self.engine = Some(engine);
        let ev = json!({ "kind": "init", "className": class, "name": name, "env": {} });
        let (r, _cs) = self.run_in_txn("init", &live, ev, None).await?;
        let logs = self.engine.as_mut().map(|e| e.take_logs()).unwrap_or_default();
        if let Err(e) = r {
            self.engine = None;
            let tail = logs.iter().map(|l| format!("[{}] {}", l.level, l.message)).collect::<Vec<_>>().join("\n");
            return Err(anyhow!("constructor failed: {e}{}", if tail.is_empty() { String::new() } else { format!("\nlogs:\n{tail}") }));
        }
        self.pending_logs = logs;
        self.loaded = Some(live);
        Ok(())
    }

    async fn run_in_txn(
        &mut self,
        label: &str,
        checkin: &str,
        ev: Value,
        body: Option<Vec<u8>>,
    ) -> Result<(std::result::Result<Dispatched, String>, Vec<u8>)> {
        let conn = self.store.conn.clone();
        let mode = self.store.mode.clone();
        let engine = self.engine.as_mut().ok_or_else(|| anyhow!("engine not loaded"))?;
        mode.set(Mode::Privileged);
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = async {
            let mut session = Session::new(&conn)?;
            session.table_filter(Some(|t: &str| !t.starts_with("_obj_") || t == "_obj_kv"));
            session.attach::<&str>(None)?;
            mode.set(Mode::Sandbox);
            let r = engine.dispatch(ev, body).await;
            mode.set(Mode::Privileged);
            let mut cs = Vec::new();
            session.changeset_strm(&mut cs)?;
            drop(session);
            let r = r?;
            if !cs.is_empty() {
                conn.execute(
                    "INSERT INTO _obj_changes(at, event, checkin, changeset) VALUES (?, ?, ?, ?)",
                    rusqlite::params![now_ms(), label, checkin, cs],
                )?;
            }
            Ok::<_, anyhow::Error>((r, cs))
        }
        .await;
        mode.set(Mode::Privileged);
        match result {
            Ok(v) => {
                conn.execute_batch("COMMIT")?;
                // Fold the WAL into the main file so a plain copy of the .obj is complete.
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                // A runtime-level failure leaves the isolate in an unknown state.
                self.engine = None;
                self.loaded = None;
                Err(e)
            }
        }
    }

    pub async fn event(&mut self, ev: Event) -> Result<Outcome> {
        self.ensure().await?;
        let checkin = self.loaded.clone().unwrap_or_default();
        let (label, json, body) = match ev {
            Event::Fetch { method, url, headers, body } => (
                "fetch",
                json!({ "kind": "fetch", "method": method, "url": url, "headers": headers }),
                Some(body),
            ),
            Event::Rpc { method, args } => (
                "rpc",
                json!({ "kind": "rpc", "method": method, "args": args }),
                None,
            ),
            Event::Alarm { retry_count } => (
                "alarm",
                json!({ "kind": "alarm", "retryCount": retry_count }),
                None,
            ),
        };
        let (r, cs) = self.run_in_txn(label, &checkin, json, body).await?;
        let mut logs = std::mem::take(&mut self.pending_logs);
        if let Some(e) = self.engine.as_mut() {
            logs.extend(e.take_logs());
        }
        let changes = summarize_changeset(&cs);
        let alarm_touched = self.engine.as_mut().map(|e| e.alarm_touched()).unwrap_or(false);
        Ok(match r {
            Ok(d) => {
                let status = d.meta.get("status").and_then(|s| s.as_u64()).map(|s| s as u16);
                let headers = d
                    .meta
                    .get("headers")
                    .and_then(|h| serde_json::from_value::<Vec<(String, String)>>(h.clone()).ok())
                    .unwrap_or_default();
                Outcome {
                    ok: true,
                    error: None,
                    status,
                    headers,
                    body: d.body,
                    result: d.meta.get("result").cloned(),
                    logs,
                    changes,
                    checkin,
                    alarm_missing: d.meta.get("missing").and_then(|m| m.as_bool()).unwrap_or(false),
                    alarm_touched,
                }
            }
            Err(e) => Outcome {
                ok: false,
                error: Some(e),
                status: None,
                headers: vec![],
                body: vec![],
                result: None,
                logs,
                changes,
                checkin,
                alarm_missing: false,
                alarm_touched,
            },
        })
    }

    /// Fire the alarm if it is due. Retries a failing alarm with exponential
    /// backoff (1s, 2s, 4s, ...) up to six times, like Cloudflare.
    pub async fn fire_due_alarm(&mut self) -> Result<Option<Outcome>> {
        let Some((at, retry)) = self.store.alarm()? else {
            return Ok(None);
        };
        if at > now_ms() {
            return Ok(None);
        }
        let out = match self.event(Event::Alarm { retry_count: retry }).await {
            Ok(o) => o,
            Err(e) => Outcome {
                ok: false,
                error: Some(e.to_string()),
                status: None,
                headers: vec![],
                body: vec![],
                result: None,
                logs: vec![],
                changes: BTreeMap::new(),
                checkin: String::new(),
                alarm_missing: false,
                alarm_touched: false,
            },
        };
        // If the handler rescheduled or deleted the alarm itself, leave it.
        if let Some((at2, _)) = self.store.alarm()? {
            if !out.alarm_touched && at2 == at {
                self.store.with_mode(Mode::Privileged, |c| {
                    if out.ok || out.alarm_missing || retry >= 6 {
                        c.execute("DELETE FROM _obj_alarms WHERE id=1 AND scheduled_at=?", [at])
                    } else {
                        c.execute(
                            "UPDATE _obj_alarms SET scheduled_at=?, retry_count=? WHERE id=1",
                            [now_ms() + 1000 * (1i64 << retry), retry + 1],
                        )
                    }
                })?;
            }
        }
        Ok(Some(out))
    }
}

// ---------------------------------------------------------------- threaded handle

type Cmd = (Event, oneshot::Sender<Result<Outcome>>);

/// A host running on its own thread (V8 isolates are single-threaded), fed
/// events over a channel. Used by `pdo run`.
#[derive(Clone)]
pub struct HostHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl HostHandle {
    pub async fn send(&self, ev: Event) -> Result<Outcome> {
        let (tx, rx) = oneshot::channel();
        self.tx.send((ev, tx)).map_err(|_| anyhow!("object host stopped"))?;
        rx.await.map_err(|_| anyhow!("object host stopped"))?
    }
}

pub fn spawn(path: PathBuf, fire_alarms: bool, echo_logs: bool) -> Result<HostHandle> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();
    std::thread::Builder::new().name("pdo-object".into()).spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async move {
            let mut host = match Host::open(&path, echo_logs) {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            if let Err(e) = host.ensure().await {
                let _ = ready_tx.send(Err(e));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        None => break,
                        Some((ev, reply)) => { let _ = reply.send(host.event(ev).await); }
                    },
                    _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                        if fire_alarms {
                            match host.fire_due_alarm().await {
                                Ok(Some(o)) if echo_logs => {
                                    if o.ok { eprintln!("alarm fired: {}", serde_json::to_string(&o.changes).unwrap_or_default()); }
                                    else { eprintln!("alarm failed: {}", o.error.unwrap_or_default()); }
                                }
                                Err(e) => eprintln!("alarm error: {e}"),
                                _ => {}
                            }
                        }
                    }
                }
            }
        });
    })?;
    ready_rx.recv().map_err(|_| anyhow!("object host thread died"))??;
    Ok(HostHandle { tx })
}
