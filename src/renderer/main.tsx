import './styles.css'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStore } from './store'
import { defineHarnessTheme } from './monaco-setup'
import { renderMetrics } from './render-metrics'

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  renderMetrics.record(actualDuration)
}

initStore().then(() => {
  defineHarnessTheme()
  createRoot(document.getElementById('root')!).render(
    <Profiler id="app" onRender={onRender}>
      <App />
    </Profiler>
  )
})
