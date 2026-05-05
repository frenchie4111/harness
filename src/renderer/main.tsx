import './styles.css'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStore } from './store'
import { defineHarnessTheme } from './monaco-setup'
import { renderMetrics } from './render-metrics'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LinuxWindowControls } from './components/LinuxWindowControls'

const SLOW_COMMIT_MS = 16

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  renderMetrics.record(actualDuration)
  if (actualDuration >= SLOW_COMMIT_MS) {
    window.api.perfLogSlowRender(id, actualDuration, phase)
  }
}

initStore()
  .then(() => {
    defineHarnessTheme()
    createRoot(document.getElementById('root')!).render(
      <ErrorBoundary label="app:root" showReload>
        <Profiler id="app" onRender={onRender}>
          <App />
        </Profiler>
        <LinuxWindowControls />
      </ErrorBoundary>
    )
  })
  .catch((err) => {
    // initStore awaits the first WS request when running against a
    // remote backend (preload swapped in WebSocketClientTransport
    // because --harness-remote-url= was in argv). A connection failure
    // surfaces here as a rejected promise. In local Electron mode the
    // ElectronClientTransport's getStateSnapshot is an in-process IPC
    // call and only fails if main itself is broken — same fallback UI
    // is fine for both paths.
    showBootError(err)
  })

function showBootError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[harness] boot failed', err)
  const message = err instanceof Error ? err.message : String(err)
  const isRemote = window.__HARNESS_WEB__ === true
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'padding:32px;max-width:640px;margin:64px auto;font-family:system-ui,sans-serif;color:#e5e5e5;background:#1a1a1a;border:1px solid #333;border-radius:8px;'
  const title = document.createElement('h1')
  title.style.cssText = 'font-size:18px;margin:0 0 12px 0;color:#ff6b6b;'
  title.textContent = isRemote ? 'Remote connection failed' : 'Harness failed to start'
  wrap.appendChild(title)
  const body = document.createElement('p')
  body.style.cssText = 'margin:0 0 16px 0;line-height:1.5;'
  body.textContent = isRemote
    ? 'Could not reach the remote harness-server. Check that the server is running and the URL/token are correct, then restart the app.'
    : 'The local Harness backend did not respond. Check the debug log and restart the app.'
  wrap.appendChild(body)
  const details = document.createElement('pre')
  details.style.cssText =
    'background:#0a0a0a;padding:12px;border-radius:4px;font-size:12px;overflow:auto;color:#aaa;'
  details.textContent = message
  wrap.appendChild(details)
  root.appendChild(wrap)
}
