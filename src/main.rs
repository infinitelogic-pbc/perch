//! perch: portable durable objects. One SQLite file holds a Durable Object's
//! code and data; this binary creates, runs and edits them.

mod assets;
mod engine;
mod export;
mod host;
mod mcp;
mod server;
mod store;
mod tools;

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

use crate::store::{Migration, Store};
use crate::tools::{CallArgs, Tools};

#[derive(Parser)]
#[command(name = "perch", version, about = "Portable Durable Objects: one SQLite file holding a Durable Object's code and data")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a new object file (an empty class, or code from a directory)
    New {
        file: PathBuf,
        /// Class name exported by src/index.ts
        #[arg(long)]
        class: Option<String>,
        /// Object name (defaults to the file name)
        #[arg(long)]
        name: Option<String>,
        /// Directory with src/**, optional public/** (static files) and migrations/*.sql
        #[arg(long)]
        from: Option<PathBuf>,
        /// Another object file to copy without its data: the same code, static
        /// files, tests and schema, with empty tables. For sharing an app.
        #[arg(long, conflicts_with = "from")]
        like: Option<PathBuf>,
    },
    /// Serve an object over HTTP and fire its alarms
    Run {
        file: PathBuf,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Do not fire alarms
        #[arg(long)]
        no_alarms: bool,
    },
    /// Expose the MCP wrapper over stdio
    Mcp { file: PathBuf },
    /// Print the object's description as JSON
    Describe { file: PathBuf },
    /// Print the code history
    Checkins {
        file: PathBuf,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        diffs: bool,
    },
    /// Call an RPC method on the live object
    Call {
        file: PathBuf,
        method: String,
        /// JSON array of arguments
        #[arg(default_value = "[]")]
        args: String,
    },
    /// Send one HTTP request to the live object's fetch()
    Fetch {
        file: PathBuf,
        path: String,
        #[arg(short = 'X', long, default_value = "GET")]
        method: String,
        #[arg(short = 'd', long)]
        data: Option<String>,
    },
    /// Write the live code as a Wrangler project for Cloudflare
    Export {
        file: PathBuf,
        out: PathBuf,
        /// Worker name (default perch-<object name>)
        #[arg(long)]
        worker_name: Option<String>,
    },
    /// Run the object's stored tests (test/*.ts), each on a fresh empty copy
    Test { file: PathBuf },
    /// Import a directory of static files into the object's public/ tree
    Import {
        file: PathBuf,
        /// Directory to read (recursively)
        dir: PathBuf,
        /// Where the files go, e.g. public/img/ (default public/)
        #[arg(long)]
        into: Option<String>,
        /// Also remove files under --into that the directory does not have
        #[arg(long)]
        prune: bool,
        #[arg(short, long)]
        message: Option<String>,
    },
}

fn pascal(s: &str) -> String {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
        })
        .collect()
}

fn starter(class: &str) -> String {
    format!(
        r#"import {{ DurableObject }} from "cloudflare:workers";

export class {class} extends DurableObject {{}}
"#
    )
}

/// A progress line on stderr for long imports, every thousand files.
fn progress(label: &'static str) -> impl FnMut(usize) {
    move |n| {
        if n % 1000 == 0 {
            eprint!("\r{label}: {n} files");
        }
    }
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn local<F: std::future::Future<Output = Result<()>>>(f: F) -> Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    tokio::task::LocalSet::new().block_on(&rt, f)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::New { file, name, like: Some(source), .. } => {
            // A copy without the data. Built from the live check-in's files and
            // the source's current table definitions, so no row, key-value entry,
            // alarm or earlier version of the code is carried. Nothing is deleted
            // from a copy: the data is never written in the first place. The
            // source's migrations are not replayed, because a migration can be
            // a data load; the copy starts with one migration holding the schema.
            let src = Store::open(&source)?;
            let live = src.live_checkin()?;
            let name = name.unwrap_or(src.meta_req("name")?);
            let class = src.meta_req("class")?;
            let code = src.code_files_at(&live)?;
            let manifest_src = src.manifest_at(&live)?;
            let ddl: Vec<String> = src.with_mode(store::Mode::Privileged, |c| -> rusqlite::Result<Vec<String>> {
                // Tables first, then the indexes, triggers and views that depend on them.
                let mut st = c.prepare(
                    "SELECT sql FROM sqlite_master
                     WHERE sql IS NOT NULL
                       AND name NOT LIKE '\\_perch\\_%' ESCAPE '\\' AND tbl_name NOT LIKE '\\_perch\\_%' ESCAPE '\\'
                       AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid",
                )?;
                st.query_map([], |r| r.get(0))?.collect()
            })?;
            let migrations: Vec<Migration> = if ddl.is_empty() {
                vec![]
            } else {
                vec![Migration { name: "0001_schema".into(), sql: ddl.join(";\n") + ";\n" }]
            };
            let msg = format!("copy of {} at {}, without data", src.meta_req("name")?, &live[..12]);
            let mut statics = 0usize;
            let s = Store::create_with(&file, &name, &class, &code, &migrations, &msg, |st, manifest| {
                for (path, hash) in &manifest_src {
                    if path.starts_with(store::PUBLIC_DIR) {
                        manifest.insert(path.clone(), st.put_blob(&src.blob(hash)?)?);
                        statics += 1;
                    }
                }
                Ok(())
            })?;
            print(&json!({
                "created": file.display().to_string(),
                "like": source.display().to_string(),
                "name": name,
                "class": class,
                "checkin": s.live_checkin()?,
                "files": code.keys().collect::<Vec<_>>(),
                "public_files": statics,
                "tables": s.schema()?.keys().collect::<Vec<_>>(),
                "note": "tables are empty: no rows, key-value entries, alarm, code history or earlier migrations were copied. If the app needs reference data to work (a default list, settings), add it after copying.",
            }));
        }
        Cmd::New { file, class, name, from, .. } => {
            let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "object".into());
            let name = name.unwrap_or_else(|| stem.clone());
            let class = class.unwrap_or_else(|| {
                let p = pascal(&stem);
                if p.is_empty() || p.starts_with(|c: char| c.is_ascii_digit()) { "Obj".into() } else { p }
            });
            let mut files = BTreeMap::new();
            let mut migrations = vec![];
            let mut public_dir: Option<PathBuf> = None;
            let msg;
            if let Some(dir) = from {
                let src = dir.join("src");
                if !src.is_dir() {
                    bail!("{} has no src/ directory", dir.display());
                }
                for sub in tools::CODE_DIRS {
                    let d = dir.join(sub);
                    if d.is_dir() {
                        tools::read_dir_bytes(&dir, &d, &mut files)?;
                    }
                }
                public_dir = Some(dir.join("public")).filter(|p| p.is_dir());
                let mdir = dir.join("migrations");
                if mdir.is_dir() {
                    let mut entries: Vec<_> = std::fs::read_dir(&mdir)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "sql")).collect();
                    entries.sort();
                    for p in entries {
                        migrations.push(Migration {
                            name: p.file_stem().unwrap().to_string_lossy().to_string(),
                            sql: std::fs::read_to_string(&p)?,
                        });
                    }
                }
                msg = format!("import from {}", dir.display());
            } else {
                files.insert("src/index.ts".to_string(), starter(&class).into_bytes());
                msg = "new object".to_string();
            }
            // Static files stream from disk one at a time; only code is held in memory.
            let mut public_stats = store::ImportStats::default();
            let s = Store::create_with(&file, &name, &class, &files, &migrations, &msg, |st, manifest| {
                if let Some(p) = &public_dir {
                    public_stats = st.import_dir(p, store::PUBLIC_DIR, manifest, false, &mut progress("importing public/"))?;
                }
                Ok(())
            })?;
            print(&json!({
                "created": file.display().to_string(),
                "name": name,
                "class": class,
                "checkin": s.live_checkin()?,
                "files": files.keys().collect::<Vec<_>>(),
                "public_files": public_stats.added,
                "migrations": migrations.iter().map(|m| &m.name).collect::<Vec<_>>(),
            }));
        }
        Cmd::Run { file, port, host, no_alarms } => {
            let addr = format!("{host}:{port}").parse()?;
            let h = host::spawn(file, !no_alarms, true)?;
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            rt.block_on(server::serve(h, addr))?;
        }
        Cmd::Mcp { file } => local(mcp::serve(file))?,
        Cmd::Describe { file } => print(&Tools::new(file)?.describe(None)?),
        Cmd::Checkins { file, limit, diffs } => print(&Tools::new(file)?.list_checkins(limit, diffs)?),
        Cmd::Call { file, method, args } => local(async move {
            let args: Value = serde_json::from_str(&args).context("args must be a JSON array")?;
            let args = match args { Value::Array(a) => a, v => vec![v] };
            let mut t = Tools::new(file)?;
            let v = t.call_object(CallArgs { kind: "rpc".into(), method: Some(method), args, ..Default::default() }).await?;
            print(&v);
            Ok(())
        })?,
        Cmd::Fetch { file, path, method, data } => local(async move {
            let mut t = Tools::new(file)?;
            let body = data.map(|d| serde_json::from_str::<Value>(&d).unwrap_or(Value::String(d)));
            let v = t
                .call_object(CallArgs { kind: "fetch".into(), path: Some(path), http_method: Some(method), body, allow_safe: true, ..Default::default() })
                .await?;
            print(&v);
            Ok(())
        })?,
        Cmd::Test { file } => local(async move {
            let v = Tools::new(file)?.run_tests(Some("live")).await?;
            print(&v);
            if v["ok"] != json!(true) {
                std::process::exit(1);
            }
            Ok(())
        })?,
        Cmd::Import { file, dir, into, prune, message } => {
            let v = Tools::new(file)?.import_files(&dir, into.as_deref(), message, prune, &mut progress("importing"))?;
            eprintln!();
            print(&v);
        }
        Cmd::Export { file, out, worker_name } => {
            let warnings = export::export(&file, &out, worker_name.as_deref())?;
            print(&json!({ "exported": out.display().to_string(), "warnings": warnings, "next": format!("cd {} && bunx wrangler deploy", out.display()) }));
        }
    }
    Ok(())
}
