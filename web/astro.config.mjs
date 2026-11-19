import { defineConfig } from 'astro/config';

// Where the site is served. Only canonical URLs and /llms.txt read it, so a
// fork sets PERCH_SITE (and the route in wrangler.jsonc) and nothing else.
const site = process.env.PERCH_SITE ?? 'https://perch.proc.io';

export default defineConfig({
  output: 'static',
  site,
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: {
    // The browser runtime imports perch's own js/bootstrap.js from the crate.
    server: { fs: { allow: ['..'] } },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  },
});
