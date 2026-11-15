//! pdo: portable durable objects. One SQLite file holds a Durable Object's
//! code and data; this binary creates, runs and edits them.

mod engine;
mod export;
mod host;
mod mcp;
mod server;
mod store;
mod tools;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};

use crate::store::{Migration, Store};
use crate::tools::{CallArgs, Tools};

#[derive(Parser)]
#[command(name = "pdo", version, about = "Portable Durable Objects: one SQLite file holding a Durable Object's code and data")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a new object file (a starter class, or code from a directory)
    New {
        file: PathBuf,
        /// Class name exported by src/index.ts
        #[arg(long)]
        class: Option<String>,
        /// Object name (defaults to the file name)
        #[arg(long)]
        name: Option<String>,
        /// Directory with src/** and optional migrations/*.sql
        #[arg(long)]
        from: Option<PathBuf>,
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
        /// Worker name (default pdo-<object name>)
        #[arg(long)]
        worker_name: Option<String>,
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

export class {class} extends DurableObject {{
  async fetch(request: Request): Promise<Response> {{
    const url = new URL(request.url);
    const hits = ((await this.ctx.storage.get<number>("hits")) ?? 0) + 1;
    await this.ctx.storage.put("hits", hits);
    return Response.json({{ object: this.ctx.id.name, path: url.pathname, hits }});
  }}
}}
"#
    )
}

fn read_dir_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            read_dir_files(root, &p, out)?;
        } else {
            let rel = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            out.insert(rel, std::fs::read_to_string(&p).with_context(|| format!("reading {}", p.display()))?);
        }
    }
    Ok(())
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
        Cmd::New { file, class, name, from } => {
            let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "object".into());
            let name = name.unwrap_or_else(|| stem.clone());
            let class = class.unwrap_or_else(|| {
                let p = pascal(&stem);
                if p.is_empty() || p.starts_with(|c: char| c.is_ascii_digit()) { "Obj".into() } else { p }
            });
            let mut files = BTreeMap::new();
            let mut migrations = vec![];
            let msg;
            if let Some(dir) = from {
                let src = dir.join("src");
                if !src.is_dir() {
                    bail!("{} has no src/ directory", dir.display());
                }
                read_dir_files(&dir, &src, &mut files)?;
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
                files.insert("src/index.ts".to_string(), starter(&class));
                msg = "new object".to_string();
            }
            let s = Store::create(&file, &name, &class, &files, &migrations, &msg)?;
            print(&json!({
                "created": file.display().to_string(),
                "name": name,
                "class": class,
                "checkin": s.live_checkin()?,
                "files": files.keys().collect::<Vec<_>>(),
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
                .call_object(CallArgs { kind: "fetch".into(), path: Some(path), http_method: Some(method), body, ..Default::default() })
                .await?;
            print(&v);
            Ok(())
        })?,
        Cmd::Export { file, out, worker_name } => {
            export::export(&file, &out, worker_name.as_deref())?;
            print(&json!({ "exported": out.display().to_string(), "next": format!("cd {} && bunx wrangler deploy", out.display()) }));
        }
    }
    Ok(())
}
