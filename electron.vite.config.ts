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
    resolve: {
      // React's production build compiles out `enableProfilerTimer`, so
      // <Profiler>'s onRender is never called and rendererPerf's reactCommits
      // reads 0 in every packaged build — `react-dom-client.production.js`
      // contains zero occurrences of `onRender`. That is not a hypothetical:
      // it made `react=0c/0ms` a measurement artifact in 100% of ~1,800
      // renderer samples and sent two separate perf investigations looking at
      // the main process. The profiling build costs a per-commit timestamp;
      // that is cheaper than shipping telemetry that silently reports zero.
      //
      // ONLY the client entry is swapped. Do not add a bare `react-dom` alias:
      // react-dom-profiling.profiling.js itself does require("react-dom") to
      // reach ReactDOMSharedInternals, so aliasing the bare specifier points
      // that lookup back at the profiling build and the cycle leaves the
      // internals undefined — the app dies at startup on `reading 'd'`.
      // Bare `react-dom` (createPortal in WorkspaceView) must keep resolving
      // to the real package; it carries no second copy of the reconciler.
      //
      // Anchored regex, not a bare string: alias `find` also matches on a `/`
      // prefix, so a plain 'react-dom' key would additionally rewrite
      // `react-dom/server` to `react-dom/profiling/server`.
      alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }]
    },
    build: {
      ssr: false
    }
  }
})
