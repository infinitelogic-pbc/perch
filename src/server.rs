//! `perch run`: serve one object over HTTP. Static files first, then every
//! request goes to the class's fetch(). Methods are not reachable over HTTP:
//! as on Cloudflare, only what fetch() routes is public.

use std::net::SocketAddr;

use anyhow::Result;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::host::{Event, HostHandle};

const MAX_BODY: usize = 32 * 1024 * 1024;

async fn fetch(State(h): State<HostHandle>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b.to_vec(),
        Err(e) => return (StatusCode::PAYLOAD_TOO_LARGE, e.to_string()).into_response(),
    };
    let host = parts
        .headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let headers = parts
        .headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();
    let ev = Event::Fetch {
        method: parts.method.as_str().to_string(),
        url: format!("http://{host}{pq}"),
        headers,
        body: bytes,
    };
    match h.send(ev).await {
        Ok(o) if o.ok => {
            let mut res = Response::new(Body::from(o.body));
            *res.status_mut() = StatusCode::from_u16(o.status.unwrap_or(200)).unwrap_or(StatusCode::OK);
            for (k, v) in o.headers {
                if let (Ok(k), Ok(v)) = (HeaderName::try_from(k), HeaderValue::try_from(v)) {
                    res.headers_mut().append(k, v);
                }
            }
            res
        }
        Ok(o) => (StatusCode::INTERNAL_SERVER_ERROR, format!("object threw: {}\n", o.error.unwrap_or_default())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}\n")).into_response(),
    }
}

pub async fn serve(h: HostHandle, addr: SocketAddr) -> Result<()> {
    let app = Router::new()
        .fallback(fetch)
        .with_state(h);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("perch: serving on http://{}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
