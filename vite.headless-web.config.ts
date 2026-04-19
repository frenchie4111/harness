// Headless web-client build. Same input as vite.web.config.ts but emits
// to dist-headless/web-client so it sits next to the headless main
// bundle. index.ts at runtime computes
// `join(__dirname, '../web-client')` to find this folder.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/web-client'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'dist-headless/web-client'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022'
  }
})
