// Headless build config for src/main.
//
// Emits a plain-Node bundle at `dist-headless/main/index.js`. Externalizes
// every dep with native bindings or that's only meaningful inside Electron
// (electron, electron-updater) — they are either resolved by Node at
// runtime (node-pty) or never reached because the loading branch is gated
// on `process.versions.electron`.
//
// What lands in this bundle:
//   - src/main/index.ts and everything it imports STATICALLY
//   - HeadlessBrowserManager (no electron deps)
//   - The WS transport, web-client HTTP server, control server, FSMs
//
// What does NOT land:
//   - desktop-shell.ts, browser-manager.ts, transport-electron.ts —
//     index.ts loads desktop-shell via `(0, eval)('require')` which the
//     bundler can't follow, and the require is gated on Electron mode
//     so it never fires in the headless dist.
//   - electron, electron-updater — externals; resolving them in
//     headless mode would crash, but again the call sites never run.

import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    target: 'node20',
    outDir: resolve(__dirname, 'dist-headless/main'),
    emptyOutDir: true,
    sourcemap: true,
    ssr: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      external: [
        'electron',
        'electron-updater',
        'node-pty',
        // dynamic require — must stay external so the bundler doesn't
        // follow it. The require is gated on Electron mode so it never
        // resolves in headless runtime.
        './desktop-shell',
        // keytar is loaded dynamically in secrets.ts; absence is fine.
        'keytar',
        // Loaded via createRequire in browser-manager-playwright.ts so
        // we don't bloat the bundle with Chromium client glue. Resolved
        // from node_modules at runtime alongside the headless dist.
        'playwright-core'
      ],
      output: {
        format: 'cjs',
        entryFileNames: 'index.js'
      }
    }
  },
  ssr: {
    // ssr: true tells vite to externalize Node built-ins automatically.
    noExternal: []
  }
})
