// pdo browser runtime: route the running object's requests to it.
//
// The /run page shows the object's app in an iframe. Every request that comes
// from inside an iframe on this origin (page loads, links, form posts, fetch,
// images, CSS) is handed to the /run page, which passes it to the Web Worker
// holding the object. Requests from the site's own top-level pages are left
// alone and go to the network as usual.

const TIMEOUT_MS = 35000;

// The object's pages may load from this origin (the object itself), inline
// code and data/blob URLs, and nothing else: an object you were sent cannot
// call out to another site from its pages.
const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'self'";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A navigation inside an iframe is always the object's.
  if (req.mode === "navigate") {
    if (req.destination === "iframe") event.respondWith(toObject(req));
    return;
  }
  // Subresources and fetch(): the object's only when the requesting page is in an iframe.
  if (!event.clientId) return;
  event.respondWith(
    self.clients.get(event.clientId).then((client) =>
      client && client.frameType === "nested" ? toObject(req) : fetch(req),
    ),
  );
});

async function runner() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => c.frameType === "top-level" && /^\/run(\.html)?\/?$/.test(new URL(c.url).pathname));
}

function page(status, title, detail) {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#5a5f66"><h1 style="font-size:1.1rem;color:#17191c">${title}</h1><p>${detail}</p>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function toObject(req) {
  const client = await runner();
  if (!client) return page(503, "No object is open", "Open a .obj file on the run page to see it here.");
  const body = req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(await req.arrayBuffer());
  const message = {
    type: "pdo-fetch",
    req: { method: req.method, url: req.url, headers: [...req.headers], body },
  };
  const res = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    client.postMessage(message, [channel.port2]);
  });
  if (!res) return page(504, "The object did not answer", "The request timed out.");
  if (res.error) return page(503, "No object is open", res.error);
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", CSP);
  const nullBody = [101, 204, 205, 304].includes(res.status) || req.method === "HEAD";
  return new Response(nullBody ? null : res.body, { status: res.status, headers });
}
