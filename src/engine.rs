//! The JavaScript side: one V8 isolate (deno_core) running the object's class,
//! with `ctx.storage` backed by ops over the object file.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::task::Poll;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use deno_core::error::ModuleLoaderError;
use deno_core::{
    JsBuffer, JsRuntime, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, OpState, PollEventLoopOptions,
    ResolutionKind, RuntimeOptions, ToJsBuffer, op2,
};
use deno_error::JsErrorBox;
use rusqlite::Connection;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::store::{Files, Mode, ModeCell, now_ms};

/// Imported as a string (default export), as wrangler does for its Text rules.
pub const TEXT_MODULE_EXTS: &[&str] = &["html", "txt", "sql", "css", "md", "svg"];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LogLine {
    pub level: String,
    pub message: String,
}

pub struct EngineState {
    pub conn: Rc<Connection>,
    pub mode: ModeCell,
    pub logs: Vec<LogLine>,
    pub results: HashMap<u32, std::result::Result<(Value, Vec<u8>), String>>,
    pub bodies: HashMap<u32, Vec<u8>>,
    pub savepoint: u32,
    /// Did this event call setAlarm or deleteAlarm?
    pub alarm_touched: bool,
    /// Echo log lines to stderr as they happen (pdo run).
    pub echo_logs: bool,
}

fn st(state: &mut OpState) -> &mut EngineState {
    state.borrow_mut::<EngineState>()
}

fn err(e: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(e.to_string())
}

/// Run `f` against the connection with the authorizer temporarily privileged
/// (for runtime-owned tables like `_obj_kv`), then restore sandbox mode.
fn privileged<T>(
    state: &mut OpState,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, JsErrorBox> {
    let s = st(state);
    let old = s.mode.set(Mode::Privileged);
    let r = f(&s.conn);
    s.mode.set(old);
    r.map_err(err)
}

// ---------------------------------------------------------------- SQL

fn json_to_sql(v: &Value) -> Result<SqlValue, JsErrorBox> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
                    SqlValue::Integer(f as i64)
                } else {
                    SqlValue::Real(f)
                }
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) if o.contains_key("$b") => {
            let arr = o["$b"].as_array().ok_or_else(|| err("bad blob binding"))?;
            SqlValue::Blob(arr.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect())
        }
        other => {
            return Err(JsErrorBox::type_error(format!(
                "unsupported SQL binding {other}; bind strings, numbers, null, booleans or ArrayBuffers"
            )));
        }
    })
}

fn sql_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$b": b }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlResult {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    rows_read: u64,
    rows_written: u64,
}

/// Execute SQL in whatever mode is current (sandbox for object code).
pub fn exec_sql(conn: &Connection, query: &str, params: &[Value]) -> Result<(Vec<String>, Vec<Vec<Value>>, u64), JsErrorBox> {
    let bound: Vec<SqlValue> = params.iter().map(json_to_sql).collect::<Result<_, _>>()?;
    let before = conn.total_changes();
    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(rusqlite::Error::MultipleStatement) if bound.is_empty() => {
            conn.execute_batch(query).map_err(err)?;
            let written = conn.total_changes() - before;
            return Ok((vec![], vec![], written));
        }
        Err(e) => return Err(err(e)),
    };
    let columns: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let n = columns.len();
    let mut rows = Vec::new();
    {
        let mut q = stmt
            .query(rusqlite::params_from_iter(bound.iter()))
            .map_err(err)?;
        while let Some(row) = q.next().map_err(err)? {
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                out.push(sql_to_json(row.get_ref(i).map_err(err)?));
            }
            rows.push(out);
        }
    }
    let written = conn.total_changes() - before;
    Ok((columns, rows, written))
}

#[op2]
#[serde]
fn op_sql_exec(
    state: &mut OpState,
    #[string] query: String,
    #[serde] params: Vec<Value>,
) -> Result<SqlResult, JsErrorBox> {
    let s = st(state);
    let (columns, rows, written) = exec_sql(&s.conn, &query, &params)?;
    Ok(SqlResult {
        rows_read: rows.len() as u64,
        columns,
        rows,
        rows_written: written,
    })
}

#[op2(fast)]
fn op_db_size(state: &mut OpState) -> Result<f64, JsErrorBox> {
    privileged(state, |c| {
        c.query_row(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .map(|n| n as f64)
}

#[op2(fast)]
fn op_txn(state: &mut OpState, #[string] action: String) -> Result<(), JsErrorBox> {
    let s = st(state);
    let sql = match action.as_str() {
        "begin" => {
            s.savepoint += 1;
            format!("SAVEPOINT pdo_tx_{}", s.savepoint)
        }
        "commit" => {
            let q = format!("RELEASE pdo_tx_{}", s.savepoint);
            s.savepoint -= 1;
            q
        }
        "rollback" => {
            let n = s.savepoint;
            s.savepoint -= 1;
            format!("ROLLBACK TO pdo_tx_{n}; RELEASE pdo_tx_{n}")
        }
        _ => return Err(err("bad txn action")),
    };
    privileged(state, |c| c.execute_batch(&sql))
}

// ---------------------------------------------------------------- KV

#[op2]
#[serde]
fn op_kv_get(state: &mut OpState, #[string] key: String) -> Result<Option<ToJsBuffer>, JsErrorBox> {
    use rusqlite::OptionalExtension;
    let v: Option<Vec<u8>> = privileged(state, |c| {
        c.query_row("SELECT value FROM _obj_kv WHERE key=?", [&key], |r| r.get(0))
            .optional()
    })?;
    Ok(v.map(ToJsBuffer::from))
}

#[op2]
fn op_kv_put(state: &mut OpState, #[string] key: String, #[buffer] value: JsBuffer) -> Result<(), JsErrorBox> {
    let bytes: &[u8] = &value;
    privileged(state, |c| {
        c.execute(
            "INSERT INTO _obj_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, bytes],
        )
    })?;
    Ok(())
}

#[op2(fast)]
fn op_kv_delete(state: &mut OpState, #[string] key: String) -> Result<bool, JsErrorBox> {
    privileged(state, |c| c.execute("DELETE FROM _obj_kv WHERE key=?", [&key])).map(|n| n > 0)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListOpts {
    start: Option<String>,
    start_after: Option<String>,
    end: Option<String>,
    prefix: Option<String>,
    reverse: Option<bool>,
    limit: Option<i64>,
}

#[op2]
#[serde]
fn op_kv_list(state: &mut OpState, #[serde] o: ListOpts) -> Result<Vec<(String, ToJsBuffer)>, JsErrorBox> {
    let mut sql = String::from("SELECT key, value FROM _obj_kv WHERE 1=1");
    let mut args: Vec<String> = vec![];
    if let Some(s) = o.start {
        sql.push_str(" AND key >= ?");
        args.push(s);
    }
    if let Some(s) = o.start_after {
        sql.push_str(" AND key > ?");
        args.push(s);
    }
    if let Some(s) = o.end {
        sql.push_str(" AND key < ?");
        args.push(s);
    }
    if let Some(p) = o.prefix {
        sql.push_str(" AND substr(key, 1, length(?)) = ?");
        args.push(p.clone());
        args.push(p);
    }
    sql.push_str(if o.reverse.unwrap_or(false) { " ORDER BY key DESC" } else { " ORDER BY key" });
    if let Some(l) = o.limit {
        sql.push_str(&format!(" LIMIT {}", l.max(0)));
    }
    let rows: Vec<(String, Vec<u8>)> = privileged(state, |c| {
        let mut st = c.prepare(&sql)?;
        let v = st
            .query_map(rusqlite::params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>();
        v
    })?;
    Ok(rows.into_iter().map(|(k, v)| (k, ToJsBuffer::from(v))).collect())
}

#[op2(fast)]
fn op_kv_delete_all(state: &mut OpState) -> Result<(), JsErrorBox> {
    privileged(state, |c| c.execute_batch("DELETE FROM _obj_kv; DELETE FROM _obj_alarms;"))
}

// ---------------------------------------------------------------- alarms

#[op2(fast)]
fn op_alarm_get(state: &mut OpState) -> Result<f64, JsErrorBox> {
    use rusqlite::OptionalExtension;
    let v: Option<i64> = privileged(state, |c| {
        c.query_row("SELECT scheduled_at FROM _obj_alarms WHERE id=1", [], |r| r.get(0))
            .optional()
    })?;
    Ok(v.map(|x| x as f64).unwrap_or(-1.0))
}

#[op2(fast)]
fn op_alarm_set(state: &mut OpState, at: f64) -> Result<(), JsErrorBox> {
    st(state).alarm_touched = true;
    let at = at as i64;
    privileged(state, |c| {
        c.execute(
            "INSERT INTO _obj_alarms(id, scheduled_at, retry_count) VALUES (1, ?, 0)
             ON CONFLICT(id) DO UPDATE SET scheduled_at=excluded.scheduled_at, retry_count=0",
            [at],
        )
    })?;
    Ok(())
}

#[op2(fast)]
fn op_alarm_delete(state: &mut OpState) -> Result<(), JsErrorBox> {
    st(state).alarm_touched = true;
    privileged(state, |c| c.execute("DELETE FROM _obj_alarms", []))?;
    Ok(())
}

// ---------------------------------------------------------------- misc

#[op2(fast)]
fn op_log(state: &mut OpState, #[string] level: String, #[string] message: String) {
    let s = st(state);
    if s.echo_logs {
        eprintln!("[{level}] {message}");
    }
    if s.logs.len() < 1000 {
        s.logs.push(LogLine { level, message });
    }
}

#[op2]
#[string]
fn op_url_parse(#[string] href: String, #[string] base: Option<String>) -> Result<String, JsErrorBox> {
    let u = match base {
        Some(b) => url::Url::parse(&b).and_then(|b| b.join(&href)),
        None => url::Url::parse(&href),
    }
    .map_err(|e| JsErrorBox::type_error(format!("Invalid URL: {href} ({e})")))?;
    Ok(url_parts(&u).to_string())
}

#[op2]
#[string]
fn op_url_set(#[string] href: String, #[string] part: String, #[string] value: String) -> Result<String, JsErrorBox> {
    let mut u = url::Url::parse(&href).map_err(err)?;
    let strip = |v: &str, c: char| v.strip_prefix(c).unwrap_or(v).to_string();
    match part.as_str() {
        "pathname" => u.set_path(&value),
        "search" => {
            let v = strip(&value, '?');
            u.set_query(if v.is_empty() { None } else { Some(&v) })
        }
        "hash" => {
            let v = strip(&value, '#');
            u.set_fragment(if v.is_empty() { None } else { Some(&v) })
        }
        "host" => u.set_host(Some(&value)).map_err(err)?,
        "hostname" => u.set_host(Some(&value)).map_err(err)?,
        "port" => u.set_port(value.parse().ok()).map_err(|_| err("bad port"))?,
        "protocol" => u.set_scheme(value.trim_end_matches(':')).map_err(|_| err("bad protocol"))?,
        "username" => u.set_username(&value).map_err(|_| err("bad username"))?,
        "password" => u.set_password(Some(&value)).map_err(|_| err("bad password"))?,
        "href" => u = url::Url::parse(&value).map_err(err)?,
        _ => return Err(err("unknown URL part")),
    }
    Ok(url_parts(&u).to_string())
}

fn url_parts(u: &url::Url) -> Value {
    json!({
        "href": u.as_str(),
        "protocol": format!("{}:", u.scheme()),
        "username": u.username(),
        "password": u.password().unwrap_or(""),
        "host": match (u.host_str(), u.port()) { (Some(h), Some(p)) => format!("{h}:{p}"), (Some(h), None) => h.to_string(), _ => String::new() },
        "hostname": u.host_str().unwrap_or(""),
        "port": u.port().map(|p| p.to_string()).unwrap_or_default(),
        "pathname": u.path(),
        "search": u.query().map(|q| format!("?{q}")).filter(|q| q.len() > 1).unwrap_or_default(),
        "hash": u.fragment().map(|f| format!("#{f}")).filter(|f| f.len() > 1).unwrap_or_default(),
        "origin": u.origin().ascii_serialization(),
    })
}

#[op2]
#[serde]
fn op_random_bytes(#[smi] n: u32) -> ToJsBuffer {
    let mut v = Vec::with_capacity(n as usize);
    while v.len() < n as usize {
        v.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    v.truncate(n as usize);
    ToJsBuffer::from(v)
}

#[op2]
#[string]
fn op_uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[op2]
#[string]
fn op_uuid_v7() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[op2]
#[serde]
fn op_take_body(state: &mut OpState, #[smi] id: u32) -> Option<ToJsBuffer> {
    st(state).bodies.remove(&id).map(ToJsBuffer::from)
}

#[op2]
fn op_event_done(state: &mut OpState, #[smi] id: u32, #[string] meta: String, #[buffer] body: JsBuffer) {
    let v: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
    st(state).results.insert(id, Ok((v, body.to_vec())));
}

#[op2(fast)]
fn op_event_error(state: &mut OpState, #[smi] id: u32, #[string] message: String) {
    st(state).results.insert(id, Err(message));
}

deno_core::extension!(
    pdo_ext,
    ops = [
        op_sql_exec,
        op_db_size,
        op_txn,
        op_kv_get,
        op_kv_put,
        op_kv_delete,
        op_kv_list,
        op_kv_delete_all,
        op_alarm_get,
        op_alarm_set,
        op_alarm_delete,
        op_log,
        op_url_parse,
        op_url_set,
        op_random_bytes,
        op_uuid_v4,
        op_uuid_v7,
        op_take_body,
        op_event_done,
        op_event_error,
    ],
);

// ---------------------------------------------------------------- modules

const PDO_TEST: &str = r#"
export const test = globalThis.__pdo.testApi.test;
export const it = test;
export const expect = globalThis.__pdo.testApi.expect;
export const describe = (_name, fn) => fn();
"#;

const CLOUDFLARE_WORKERS: &str = r#"
export const DurableObject = globalThis.__pdo.DurableObject;
export const WorkerEntrypoint = globalThis.__pdo.WorkerEntrypoint;
export const RpcTarget = globalThis.__pdo.RpcTarget;
export const env = globalThis.__pdo.env;
export default { DurableObject, WorkerEntrypoint, RpcTarget, env };
"#;

/// Strip TypeScript types. Returns (javascript, source map).
pub fn transpile(path: &str, code: &str) -> Result<(String, Option<Vec<u8>>)> {
    use deno_ast::{MediaType, ParseParams, SourceMapOption};
    let spec = ModuleSpecifier::parse(&format!("pdo:///{path}"))?;
    let media_type = MediaType::from_specifier(&spec);
    let needs = matches!(
        media_type,
        MediaType::TypeScript | MediaType::Mts | MediaType::Tsx | MediaType::Jsx
    );
    if !needs {
        return Ok((code.to_string(), None));
    }
    let parsed = deno_ast::parse_module(ParseParams {
        specifier: spec,
        text: code.into(),
        media_type,
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })
    .map_err(|e| anyhow!("{path}: {e}"))?;
    let res = parsed
        .transpile(
            &deno_ast::TranspileOptions {
                imports_not_used_as_values: deno_ast::ImportsNotUsedAsValues::Remove,
                decorators: deno_ast::DecoratorsTranspileOption::Ecma,
                ..Default::default()
            },
            &deno_ast::TranspileModuleOptions { module_kind: None },
            &deno_ast::EmitOptions {
                source_map: SourceMapOption::Separate,
                inline_sources: true,
                ..Default::default()
            },
        )
        .map_err(|e| anyhow!("{path}: {e}"))?
        .into_source();
    Ok((res.text, res.source_map.map(|s| s.into_bytes())))
}

struct ObjectLoader {
    files: Files,
    /// Test files may import "pdo:test"; object code may not.
    test_mode: bool,
    source_maps: RefCell<HashMap<String, Vec<u8>>>,
}

impl ObjectLoader {
    fn find(&self, path: &str) -> Option<(String, &Vec<u8>)> {
        let candidates = [
            path.to_string(),
            format!("{path}.ts"),
            format!("{path}.js"),
            format!("{path}/index.ts"),
            format!("{path}/index.js"),
        ];
        // `import "./x.js"` written for TS resolves to x.ts, as in tsc/wrangler.
        let swapped = path.strip_suffix(".js").map(|p| format!("{p}.ts"));
        candidates
            .into_iter()
            .chain(swapped)
            .find_map(|c| self.files.get(&c).map(|v| (c, v)))
    }
}

impl ModuleLoader for ObjectLoader {
    fn resolve(&self, specifier: &str, referrer: &str, _kind: ResolutionKind) -> Result<ModuleSpecifier, ModuleLoaderError> {
        if specifier.starts_with("cloudflare:") {
            return ModuleSpecifier::parse(specifier).map_err(JsErrorBox::from_err);
        }
        if specifier == "pdo:test" {
            if !self.test_mode || !referrer.starts_with("pdo:///test/") {
                return Err(JsErrorBox::generic("pdo:test can only be imported by files under test/, when tests run"));
            }
            return ModuleSpecifier::parse(specifier).map_err(JsErrorBox::from_err);
        }
        if !(specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with("pdo:")) {
            return Err(JsErrorBox::generic(format!(
                "cannot import {specifier:?}: pdo v0 loads only files inside the object (relative imports) and cloudflare:workers; vendor the package into the object"
            )));
        }
        deno_core::resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(&self, spec: &ModuleSpecifier, _r: Option<&ModuleLoadReferrer>, _o: ModuleLoadOptions) -> ModuleLoadResponse {
        let r = (|| -> Result<ModuleSource, ModuleLoaderError> {
            let code = if spec.as_str() == "pdo:test" {
                PDO_TEST.to_string()
            } else if spec.scheme() == "cloudflare" {
                if spec.path() != "workers" {
                    return Err(JsErrorBox::generic(format!("{spec} is not available in pdo v0")));
                }
                CLOUDFLARE_WORKERS.to_string()
            } else {
                let path = spec.path().trim_start_matches('/');
                let (found, bytes) = self
                    .find(path)
                    .ok_or_else(|| JsErrorBox::generic(format!("module not found in object: {path}")))?;
                let src = &String::from_utf8(bytes.clone())
                    .map_err(|_| JsErrorBox::generic(format!("{found} is not UTF-8 text, so it cannot be imported")))?;
                // Text modules: the file's contents as the default export, the way
                // wrangler treats .html/.txt/.sql (pdo export adds rules for the rest).
                let ext = found.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
                if TEXT_MODULE_EXTS.contains(&ext) {
                    let code = format!("export default {};\n", serde_json::to_string(src).unwrap());
                    return Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), spec, None));
                }
                if found.ends_with(".json") {
                    return Ok(ModuleSource::new(
                        ModuleType::Json,
                        ModuleSourceCode::String(src.clone().into()),
                        spec,
                        None,
                    ));
                }
                let (js, map) = transpile(&found, src).map_err(|e| JsErrorBox::generic(e.to_string()))?;
                if let Some(m) = map {
                    self.source_maps.borrow_mut().insert(spec.to_string(), m);
                }
                js
            };
            Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), spec, None))
        })();
        ModuleLoadResponse::Sync(r)
    }

    fn get_source_map(&self, specifier: &str) -> Option<Cow<'_, [u8]>> {
        self.source_maps.borrow().get(specifier).map(|v| Cow::Owned(v.clone()))
    }
}

// ---------------------------------------------------------------- engine

pub struct Engine {
    rt: JsRuntime,
    next_id: u32,
}

pub struct Dispatched {
    pub meta: Value,
    pub body: Vec<u8>,
}

/// Wall-clock limit for one event.
pub const EVENT_TIMEOUT: Duration = Duration::from_secs(30);

impl Engine {
    /// Load the module graph for `files` and evaluate it. The class is
    /// constructed by the first `init` event, which the host runs inside a
    /// transaction like any other event.
    pub async fn load(
        conn: Rc<Connection>,
        mode: ModeCell,
        files: Files,
        main: &str,
        echo_logs: bool,
        tests: &[String],
    ) -> Result<Engine> {
        if !files.contains_key(main) {
            bail!("entry file {main} is not in this check-in");
        }
        let loader = ObjectLoader {
            files,
            test_mode: !tests.is_empty(),
            source_maps: RefCell::new(HashMap::new()),
        };
        let mut rt = JsRuntime::new(RuntimeOptions {
            module_loader: Some(Rc::new(loader)),
            extensions: vec![pdo_ext::init()],
            ..Default::default()
        });
        rt.op_state().borrow_mut().put(EngineState {
            conn,
            mode: mode.clone(),
            logs: vec![],
            results: HashMap::new(),
            bodies: HashMap::new(),
            savepoint: 0,
            alarm_touched: false,
            echo_logs,
        });
        rt.execute_script("pdo:bootstrap.js", include_str!("../js/bootstrap.js"))
            .map_err(|e| anyhow!("bootstrap: {e}"))?;
        let main_spec = ModuleSpecifier::parse("pdo:///__pdo_main__.js")?;
        let mut code = format!(
            "import * as mod from \"pdo:///{main}\";\nglobalThis.__pdo.setModule(mod);\n"
        );
        for t in tests {
            let t = serde_json::to_string(t)?;
            code.push_str(&format!("globalThis.__pdo.beginTestFile({t});\nawait import(\"pdo:///\" + {t});\n"));
        }
        // Top-level module code runs sandboxed too.
        let old = mode.set(Mode::Sandbox);
        let r = async {
            let id = rt.load_main_es_module_from_code(&main_spec, code).await?;
            let eval = rt.mod_evaluate(id);
            rt.run_event_loop(PollEventLoopOptions::default()).await?;
            eval.await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        mode.set(old);
        r.map_err(|e| anyhow!("loading module: {e}"))?;
        Ok(Engine { rt, next_id: 1 })
    }

    pub fn alarm_touched(&mut self) -> bool {
        self.rt.op_state().borrow_mut().borrow_mut::<EngineState>().alarm_touched
    }

    pub fn take_logs(&mut self) -> Vec<LogLine> {
        std::mem::take(&mut self.rt.op_state().borrow_mut().borrow_mut::<EngineState>().logs)
    }

    /// Dispatch one event into JS and drive the event loop until the handler
    /// reports back. The caller has already set sandbox mode and opened the
    /// transaction.
    pub async fn dispatch(&mut self, event: Value, body: Option<Vec<u8>>) -> Result<std::result::Result<Dispatched, String>> {
        let id = self.next_id;
        self.next_id += 1;
        {
            let state = self.rt.op_state();
            let mut s = state.borrow_mut();
            let es = s.borrow_mut::<EngineState>();
            es.savepoint = 0;
            es.alarm_touched = false;
            if let Some(b) = body {
                es.bodies.insert(id, b);
            }
        }
        let script = format!("globalThis.__pdo.dispatch({id}, {});", serde_json::to_string(&event)?);
        self.rt
            .execute_script("pdo:dispatch.js", script)
            .map_err(|e| anyhow!("dispatch: {e}"))?;
        let take = |rt: &mut JsRuntime| {
            let state = rt.op_state();
            let mut s = state.borrow_mut();
            s.borrow_mut::<EngineState>().results.remove(&id)
        };
        let fut = std::future::poll_fn(|cx| {
            if let Some(r) = take(&mut self.rt) {
                return Poll::Ready(Ok(r));
            }
            let p = self.rt.poll_event_loop(cx, PollEventLoopOptions::default());
            if let Some(r) = take(&mut self.rt) {
                return Poll::Ready(Ok(r));
            }
            match p {
                Poll::Ready(Err(e)) => Poll::Ready(Err(anyhow!("{e}"))),
                Poll::Ready(Ok(())) => Poll::Ready(Ok(Err(
                    "the handler never settled (it awaited a promise nothing will resolve)".to_string(),
                ))),
                Poll::Pending => Poll::Pending,
            }
        });
        let started = now_ms();
        let r = match tokio::time::timeout(EVENT_TIMEOUT, fut).await {
            Ok(r) => r?,
            Err(_) => Err(format!("event exceeded {}s wall clock", EVENT_TIMEOUT.as_secs())),
        };
        let _ = started;
        // Close any savepoint object code left open (an exception mid-transactionSync).
        let state = self.rt.op_state();
        let mut s = state.borrow_mut();
        let es = s.borrow_mut::<EngineState>();
        while es.savepoint > 0 {
            let n = es.savepoint;
            let old = es.mode.set(Mode::Privileged);
            let _ = es.conn.execute_batch(&format!("ROLLBACK TO pdo_tx_{n}; RELEASE pdo_tx_{n}"));
            es.mode.set(old);
            es.savepoint -= 1;
        }
        Ok(r.map(|(meta, body)| Dispatched { meta, body }))
    }
}
