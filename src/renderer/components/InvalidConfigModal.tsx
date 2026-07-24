import { useState, useEffect } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useConfigLoadError } from '../store'
import { useBackend } from '../backend'
import { MonacoEditor } from './MonacoEditor'

/** Boot-time config.json recovery, shown as the whole window (App.tsx returns
 *  early on a config error, so there's no dismiss). The raw text loads into a
 *  Monaco editor; Save & Retry writes it back and re-applies if it parses,
 *  Reset to defaults starts fresh. See persistence.ts for the quarantine +
 *  write-suspend behavior backing this. */
export function InvalidConfigModal(): JSX.Element | null {
  const loadError = useConfigLoadError()
  const backend = useBackend()
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'reset'>(null)
  // The original parse error, replaced by the validation error after a failed save.
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void backend.readRawConfig().then((res) => {
      if (!cancelled) setText(res.text)
    })
    return () => {
      cancelled = true
    }
  }, [backend])

  if (!loadError) return null

  const onSave = async (): Promise<void> => {
    if (text == null || busy) return
    setBusy('save')
    setSaveError(null)
    const result = await backend.saveRawConfigAndRetry(text)
    // On success the app relaunches and this view never returns; only the
    // failure path resolves here.
    if (!result.ok) {
      setSaveError(result.error)
      setBusy(null)
    }
  }

  const onReset = async (): Promise<void> => {
    setBusy('reset')
    await backend.resetConfigToDefaults()
    // Relaunches on success.
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[8vh] bg-black/50">
      <div className="w-full max-w-3xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col">
        <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
          <AlertTriangle className="icon-base text-amber-400 shrink-0" />
          <h2 className="text-sm font-semibold text-fg-bright">
            Couldn&apos;t read your configuration
          </h2>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3 text-sm text-fg">
          <p>
            Harness couldn&apos;t parse <code className="text-xs">config.json</code>, so it
            started with default settings. Fix it below and click Save &amp; Retry, or
            reset to defaults to start fresh — your settings won&apos;t be saved until
            this is resolved.
          </p>

          <div className="rounded bg-bg border border-amber-500/40 px-3 py-2 font-mono text-xs text-amber-300 break-all">
            {saveError ?? loadError.message}
          </div>

          <div className="h-[40vh] min-h-64 rounded border border-border overflow-hidden">
            {text == null ? (
              <div className="h-full w-full flex items-center justify-center text-fg-dim text-xs">
                <Loader2 className="icon-sm animate-spin mr-2" />
                Loading config.json…
              </div>
            ) : (
              <MonacoEditor
                value={text}
                filePath="config.json"
                onChange={setText}
                onSave={() => {
                  void onSave()
                }}
                wordWrap
              />
            )}
          </div>

          {loadError.backupPath && (
            <p className="text-xs text-fg-dim break-all">
              A copy of the unreadable file was saved to{' '}
              <code className="text-xs">{loadError.backupPath}</code>.
            </p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onReset}
            disabled={busy !== null}
            className="px-3 py-1.5 text-xs font-medium rounded bg-bg hover:bg-border text-fg-bright border border-border cursor-pointer transition-colors disabled:opacity-50 mr-auto flex items-center gap-1.5"
          >
            {busy === 'reset' && <Loader2 className="icon-xs animate-spin" />}
            Reset to defaults
          </button>
          <button
            onClick={onSave}
            disabled={busy !== null || text == null}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy === 'save' && <Loader2 className="icon-xs animate-spin" />}
            Save &amp; Retry
          </button>
        </div>
      </div>
    </div>
  )
}
