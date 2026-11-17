// Static files: the same rules as perch/src/assets.rs (Cloudflare Workers Static
// Assets defaults), so a page behaves the same in the browser runtime, under
// `perch run`, and after `perch export`.

export const PUBLIC_DIR = "public/";

export type Resolved = { file: string } | { redirect: string } | null;

export function resolve(has: (path: string) => boolean, path: string): Resolved {
  const h = (rel: string) => has(PUBLIC_DIR + rel);
  if (!path.startsWith("/")) return null;
  const rel = path.slice(1);
  if (rel.split("/").some((s) => s === ".." || s === ".")) return null;

  if (rel.endsWith(".html")) {
    if ((rel === "index.html" || rel.endsWith("/index.html")) && h(rel)) {
      return { redirect: "/" + rel.slice(0, rel.length - "index.html".length) };
    }
    if (h(rel)) return { redirect: "/" + rel.slice(0, rel.length - ".html".length) };
    return null;
  }
  if (rel === "" || rel.endsWith("/")) {
    if (h(rel + "index.html")) return { file: PUBLIC_DIR + rel + "index.html" };
    const trimmed = rel.replace(/\/+$/, "");
    if (trimmed && h(trimmed + ".html")) return { redirect: "/" + trimmed };
    return null;
  }
  if (h(rel)) return { file: PUBLIC_DIR + rel };
  if (h(rel + ".html")) return { file: PUBLIC_DIR + rel + ".html" };
  if (h(rel + "/index.html")) return { redirect: "/" + rel + "/" };
  return null;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon", pdf: "application/pdf",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm", mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm",
};

export function contentType(path: string): string {
  const i = path.lastIndexOf(".");
  return TYPES[i < 0 ? "" : path.slice(i + 1).toLowerCase()] ?? "application/octet-stream";
}

export const CACHE_CONTROL = "public, max-age=0, must-revalidate";

export function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
