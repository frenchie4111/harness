import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'

// Captured once at vite startup. Restart `npm run dev` after switching
// branches if you want the title to update.
function currentGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const DEV_BRANCH = currentGitBranch()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        // index.ts loads desktop-shell via runtime require() under
        // `if (runtime === 'electron')` so the headless build doesn't
        // pull electron in. The bundler can't see that require, so the
        // shell needs an explicit entry to land in out/main next to
        // index.js where the require can find it at runtime.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'desktop-shell': resolve(__dirname, 'src/main/desktop-shell.ts')
        },
        external: ['electron', 'node-pty'],
        output: {
          format: 'cjs',
          // Stable output filenames so `require('./desktop-shell')`
          // resolves the way it would after a fresh `npm run build`.
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
    define: {
      __HARNESS_DEV_BRANCH__: JSON.stringify(DEV_BRANCH)
    },
    build: {
      ssr: false
    }
  }
})
