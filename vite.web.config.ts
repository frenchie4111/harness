// Build config for the standalone web-client bundle. Lives separately
// from `electron.vite.config.ts` because the web client is a plain Vite
// app with its own entry HTML — no preload, no main process integration.
// `npm run build` runs this after the electron-vite build so both
// outputs land under `out/`.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/web-client'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'out/web-client'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022'
  }
})
