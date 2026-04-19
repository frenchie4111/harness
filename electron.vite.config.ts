import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        // Emit a second main-process entry for the permission-prompt MCP
        // server so it lands at out/main/permission-prompt-mcp.js and can
        // be spawned via ELECTRON_RUN_AS_NODE=1 by JsonClaudeManager.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'permission-prompt-mcp': resolve(
            __dirname,
            'src/main/permission-prompt-mcp/index.ts'
          )
        },
        external: ['electron', 'node-pty'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      ssr: false
    }
  }
})
