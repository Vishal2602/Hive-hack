import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// "@hive/*" points at the backend sources so the prototype compiles against the
// real types. Only `import type` is allowed from there; nothing is bundled.
export default defineConfig({
  // Served by the Hive daemon at /ui (src/server/daemon.ts); the router basename follows BASE_URL.
  base: '/ui/',
  plugins: [react()],
  // `npm run dev`: proxy the daemon's API so the dev server is same-origin like production.
  server: {
    proxy: Object.fromEntries(['/me', '/api', '/snapshot', '/events', '/command', '/healthz', '/mcp']
      .map(path => [path, { target: process.env.HIVE_URL ?? 'http://127.0.0.1:4317', changeOrigin: false }])),
  },
  build: { chunkSizeWarningLimit: 900 },
  resolve: {
    alias: {
      '@hive': fileURLToPath(new URL('../src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
