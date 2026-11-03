import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// "@hive/*" points at the backend sources so the prototype compiles against the
// real types. Only `import type` is allowed from there; nothing is bundled.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
  resolve: {
    alias: {
      '@hive': fileURLToPath(new URL('../src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
