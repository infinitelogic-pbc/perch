import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';

// The domain comes from the repo's generated stack file, never hardcoded.
// The fallback only feeds canonical URLs, so `astro build` works before
// anyone has run `bun run configure`.
let baseDomain = 'proc.io';
try {
  baseDomain = JSON.parse(
    readFileSync(new URL('../../stack.generated.json', import.meta.url), 'utf8'),
  ).baseDomain;
} catch {
  // not configured yet
}

export default defineConfig({
  output: 'static',
  site: `https://perch.${baseDomain}`,
  trailingSlash: 'never',
  build: { format: 'file' },
  vite: {
    // The browser runtime imports perch's own js/bootstrap.js from the crate.
    server: { fs: { allow: ['..'] } },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  },
});
