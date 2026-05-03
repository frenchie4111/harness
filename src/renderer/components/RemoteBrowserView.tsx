import { useEffect, useRef, useState } from 'react'
import { useBrowser } from '../store'

interface RemoteBrowserViewProps {
  tabId: string
  /** Pause polling when the panel isn't visible — saves the screenshot
   *  RPC + base64 transfer when the user is on a different tab. */
  visible: boolean
}

const POLL_MS = 1500

interface Shot {
  data: string
  format: 'jpeg' | 'png'
  /** Natural dimensions of the screenshot, used to translate viewport
   *  click offsets back to the source coordinate space. */
  width: number
  height: number
}

/**
 * Screenshot-only browser view for the web client. Polls a JPEG every
 * POLL_MS, renders it as an `<img>` scaled to fit the panel, and
 * forwards click + type events back to the controller via IPC.
 *
 * Live screencast (CDP Page.screencastFrame) is the obvious follow-up;
 * this gets the agent loop usable in headless mode without it.
 */
export function RemoteBrowserView({ tabId, visible }: RemoteBrowserViewProps): JSX.Element {
  const browser = useBrowser()
  const tabError = browser.byTab[tabId]?.error
  const [shot, setShot] = useState<Shot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [typing, setTyping] = useState(false)
  const [typeBuf, setTypeBuf] = useState('')

  useEffect(() => {
    if (!visible) return
    if (tabError) return
    let cancelled = false
    let timer: number | null = null

    const refresh = async (): Promise<void> => {
      try {
        const result = await window.api.browserScreenshot(tabId, {
          format: 'jpeg',
          quality: 70
        })
        if (cancelled) return
        if (!result) {
          setError('screenshot unavailable')
          return
        }
        const img = new Image()
        img.onload = () => {
          if (cancelled) return
          setShot({
            data: result.data,
            format: result.format,
            width: img.naturalWidth,
            height: img.naturalHeight
          })
          setError(null)
        }
        img.onerror = () => {
          if (cancelled) return
          setError('screenshot decode failed')
        }
        img.src = `data:${result.format === 'png' ? 'image/png' : 'image/jpeg'};base64,${result.data}`
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    void refresh()
    timer = window.setInterval(() => void refresh(), POLL_MS)

    return () => {
      cancelled = true
      if (timer != null) window.clearInterval(timer)
    }
  }, [tabId, visible, tabError])

  const handleClick = (e: React.MouseEvent<HTMLImageElement>): void => {
    if (!shot) return
    const img = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const sx = shot.width / rect.width
    const sy = shot.height / rect.height
    const x = Math.round((e.clientX - rect.left) * sx)
    const y = Math.round((e.clientY - rect.top) * sy)
    void window.api.browserClick(tabId, x, y).catch(() => {})
  }

  const submitType = (): void => {
    const text = typeBuf
    setTyping(false)
    setTypeBuf('')
    if (!text) return
    void window.api.browserType(tabId, text).catch(() => {})
  }

  const submitKey = (key: string): void => {
    void window.api.browserType(tabId, '', key).catch(() => {})
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-app">
      <div className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center">
        {tabError ? (
          <div className="max-w-lg px-6 text-center text-xs text-fg space-y-2">
            <div className="font-medium text-red-500">Remote browser unavailable</div>
            <div className="text-faint whitespace-pre-wrap break-words">{tabError}</div>
          </div>
        ) : shot ? (
          <img
            ref={imgRef}
            src={`data:${shot.format === 'png' ? 'image/png' : 'image/jpeg'};base64,${shot.data}`}
            onClick={handleClick}
            className="max-w-full max-h-full object-contain cursor-crosshair select-none"
            alt="remote browser"
            draggable={false}
          />
        ) : (
          <div className="text-faint text-xs px-6 text-center">
            {error ? `Remote browser: ${error}` : 'Loading screenshot…'}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-t border-border bg-panel text-[11px]">
        <span className="text-faint">Remote view (screenshot polled every {POLL_MS / 1000}s).</span>
        <div className="flex-1" />
        {typing ? (
          <>
            <input
              autoFocus
              value={typeBuf}
              onChange={(e) => setTypeBuf(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitType()
                } else if (e.key === 'Escape') {
                  setTyping(false)
                  setTypeBuf('')
                }
              }}
              placeholder="Type into page, then Enter"
              className="h-6 px-2 bg-app border border-border rounded text-fg focus:outline-none focus:border-accent"
            />
            <button
              onClick={() => submitKey('Enter')}
              className="h-6 px-2 rounded text-faint hover:text-fg border border-border"
              title="Send Enter key"
            >
              ⏎
            </button>
            <button
              onClick={() => {
                setTyping(false)
                setTypeBuf('')
              }}
              className="h-6 px-2 rounded text-faint hover:text-fg"
            >
              cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setTyping(true)}
            className="h-6 px-2 rounded text-faint hover:text-fg border border-border"
          >
            Type into page
          </button>
        )}
      </div>
    </div>
  )
}
