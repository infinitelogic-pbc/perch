//! Static files: everything under `public/` in the live check-in is served at
//! the matching URL path, before fetch() and without waking the object. The
//! rules copy Cloudflare Workers Static Assets' defaults (html_handling
//! "auto-trailing-slash", not_found_handling "none", worker not first) so a
//! page behaves the same under `pdo run` and after `pdo export`.

use crate::store::{Manifest, PUBLIC_DIR};

#[derive(Debug, PartialEq)]
pub enum Resolved {
    /// Serve this manifest path.
    File(String),
    /// 307 to this URL path (query string is appended by the caller).
    Redirect(String),
    /// No file matches; the request goes to fetch().
    Miss,
}

/// Map a decoded URL path (starting with `/`) to a file, a redirect, or a miss.
pub fn resolve(manifest: &Manifest, path: &str) -> Resolved {
    let has = |rel: &str| manifest.contains_key(&format!("{PUBLIC_DIR}{rel}"));
    let file = |rel: &str| Resolved::File(format!("{PUBLIC_DIR}{rel}"));
    let Some(rel) = path.strip_prefix('/') else {
        return Resolved::Miss;
    };
    if rel.split('/').any(|s| s == ".." || s == ".") {
        return Resolved::Miss;
    }

    if rel.ends_with(".html") {
        // /index.html -> /, /docs/index.html -> /docs/, /about.html -> /about
        if (rel == "index.html" || rel.ends_with("/index.html")) && has(rel) {
            return Resolved::Redirect(format!("/{}", &rel[..rel.len() - "index.html".len()]));
        }
        if has(rel) {
            return Resolved::Redirect(format!("/{}", &rel[..rel.len() - ".html".len()]));
        }
        return Resolved::Miss;
    }

    if rel.is_empty() || rel.ends_with('/') {
        // /docs/ -> docs/index.html; /about/ with only about.html -> /about
        if has(&format!("{rel}index.html")) {
            return file(&format!("{rel}index.html"));
        }
        let trimmed = rel.trim_end_matches('/');
        if !trimmed.is_empty() && has(&format!("{trimmed}.html")) {
            return Resolved::Redirect(format!("/{trimmed}"));
        }
        return Resolved::Miss;
    }

    if has(rel) {
        return file(rel);
    }
    if has(&format!("{rel}.html")) {
        return file(&format!("{rel}.html"));
    }
    if has(&format!("{rel}/index.html")) {
        return Resolved::Redirect(format!("/{rel}/"));
    }
    Resolved::Miss
}

pub fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Cloudflare's default for assets: cache, but revalidate every time.
pub const CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

/// Percent-decode a URL path.
pub fn decode_path(p: &str) -> String {
    let b = p.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&p[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(paths: &[&str]) -> Manifest {
        paths.iter().map(|p| (format!("public/{p}"), "h".to_string())).collect()
    }

    #[test]
    fn clean_urls() {
        let man = m(&["index.html", "about.html", "docs/index.html", "css/site.css", "logo.png", "both.html", "both/index.html", "raw"]);
        use Resolved::*;
        assert_eq!(resolve(&man, "/"), File("public/index.html".into()));
        assert_eq!(resolve(&man, "/index.html"), Redirect("/".into()));
        assert_eq!(resolve(&man, "/about"), File("public/about.html".into()));
        assert_eq!(resolve(&man, "/about.html"), Redirect("/about".into()));
        assert_eq!(resolve(&man, "/about/"), Redirect("/about".into()));
        assert_eq!(resolve(&man, "/docs"), Redirect("/docs/".into()));
        assert_eq!(resolve(&man, "/docs/"), File("public/docs/index.html".into()));
        assert_eq!(resolve(&man, "/docs/index.html"), Redirect("/docs/".into()));
        assert_eq!(resolve(&man, "/css/site.css"), File("public/css/site.css".into()));
        assert_eq!(resolve(&man, "/both"), File("public/both.html".into()));
        assert_eq!(resolve(&man, "/both/"), File("public/both/index.html".into()));
        assert_eq!(resolve(&man, "/raw"), File("public/raw".into()));
        assert_eq!(resolve(&man, "/todos"), Miss);
        assert_eq!(resolve(&man, "/missing.html"), Miss);
        assert_eq!(resolve(&man, "/../src/index.ts"), Miss);
    }

    #[test]
    fn decoding() {
        assert_eq!(decode_path("/a%20b/c%2Fd"), "/a b/c/d");
        assert_eq!(decode_path("/100%"), "/100%");
    }
}
