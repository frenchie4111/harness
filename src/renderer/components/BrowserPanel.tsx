import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Wrench, Loader2 } from 'lucide-react'
import { useBrowser } from '../store'
import { Tooltip } from './Tooltip'

interface BrowserPanelProps {
  tabId: string
  visible: boolean
  initialUrl: string
}

/**
 * Renders the URL bar + navigation buttons for a browser tab and a
 * placeholder body whose bounds are streamed to main. The actual web view
 * is a native `WebContentsView` positioned on top of this placeholder by
 * BrowserManager.
 */
export function BrowserPanel({ tabId, visible, initialUrl }: BrowserPanelProps): JSX.Element {
  const browser = useBrowser()
  const tabState = browser.byTab[tabId]
  const currentUrl = tabState?.url ?? initialUrl
  const loading = tabState?.loading ?? false
  const canGoBack = tabState?.canGoBack ?? false
  const canGoForward = tabState?.canGoForward ?? false

  const [draftUrl, setDraftUrl] = useState(currentUrl)
  const [editing, setEditing] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Keep the URL bar text in sync with the actual page URL when not editing.
  useEffect(() => {
    if (!editing) setDraftUrl(currentUrl)
  }, [currentUrl, editing])

  const pushBounds = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    if (!visible) {
      window.api.browserHide(tabId)
      return
    }
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) {
      window.api.browserHide(tabId)
      return
    }
    window.api.browserSetBounds(tabId, {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height
    })
  }, [tabId, visible])

  useEffect(() => {
    pushBounds()
    if (!visible) return
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => pushBounds())
    ro.observe(el)
    const onWinResize = (): void => pushBounds()
    window.addEventListener('resize', onWinResize)
    // Periodic re-check catches layout shifts that ResizeObserver misses
    // (sidebar collapse animations that move x/y without resizing us).
    const interval = setInterval(pushBounds, 150)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
      clearInterval(interval)
    }
  }, [pushBounds, visible])

  useEffect(() => {
    return () => {
      window.api.browserHide(tabId)
    }
  }, [tabId])

  const submitNav = (): void => {
    setEditing(false)
    if (!draftUrl.trim()) return
    void window.api.browserNavigate(tabId, draftUrl.trim())
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex items-center gap-1 px-2 h-9 shrink-0 border-b border-border bg-panel">
        <Tooltip label="Back">
          <button
            onClick={() => void window.api.browserBack(tabId)}
            disabled={!canGoBack}
            className="p-1 rounded text-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            onClick={() => void window.api.browserForward(tabId)}
            disabled={!canGoForward}
            className="p-1 rounded text-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowRight size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Reload">
          <button
            onClick={() => void window.api.browserReload(tabId)}
            className="p-1 rounded text-faint hover:text-fg transition-colors"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
          </button>
        </Tooltip>
        <input
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submitNav()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
            if (e.key === 'Escape') {
              setDraftUrl(currentUrl)
              setEditing(false)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          placeholder="Enter URL"
          spellCheck={false}
          className="flex-1 h-7 px-2 text-xs bg-app border border-border rounded text-fg focus:outline-none focus:border-accent"
        />
        <Tooltip label="DevTools">
          <button
            onClick={() => void window.api.browserOpenDevTools(tabId)}
            className="p-1 rounded text-faint hover:text-fg transition-colors"
          >
            <Wrench size={14} />
          </button>
        </Tooltip>
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 bg-app" />
    </div>
  )
}
