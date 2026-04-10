import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Check, X, Eye, EyeOff, Star } from 'lucide-react'

interface SettingsProps {
  onClose: () => void
}

export function Settings({ onClose }: SettingsProps): JSX.Element {
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [autoStar, setAutoStar] = useState(true)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    window.api.hasGithubToken().then(setHasToken)
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setResult(null)
    try {
      const res = await window.api.setGithubToken(token, { starRepo: autoStar })
      if (res.ok) {
        let message = res.username ? `Connected as @${res.username}` : 'Token saved'
        if (autoStar && res.starred) message += ' · starred Harness on GitHub'
        setResult({ ok: true, message })
        setHasToken(true)
        setToken('')
      } else {
        setResult({ ok: false, message: `Invalid token: ${res.error || 'unknown error'}` })
      }
    } finally {
      setSaving(false)
    }
  }, [token, autoStar])

  const handleClear = useCallback(async () => {
    await window.api.clearGithubToken()
    setHasToken(false)
    setResult({ ok: true, message: 'Token removed' })
  }, [])

  return (
    <div className="flex flex-col h-full bg-neutral-950">
      {/* Title bar */}
      <div className="drag-region h-10 flex items-center shrink-0 border-b border-neutral-800">
        <button
          onClick={onClose}
          className="no-drag ml-20 flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="text-sm font-medium text-neutral-300 ml-4">Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-neutral-200 mb-1">GitHub</h2>
          <p className="text-sm text-neutral-500 mb-4">
            Harness uses a personal access token to fetch PR status and check results.
            The token is encrypted and stored locally using your macOS keychain.
          </p>

          <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              Personal Access Token
            </label>

            {hasToken && (
              <div className="flex items-center gap-2 mb-3 text-xs text-green-400">
                <Check size={14} />
                <span>A token is currently saved</span>
              </div>
            )}

            <label className="flex items-center gap-2 mb-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={autoStar}
                onChange={(e) => setAutoStar(e.target.checked)}
                className="w-3.5 h-3.5 accent-amber-400 cursor-pointer"
              />
              <Star size={12} className="text-amber-400 shrink-0" />
              <span className="text-xs text-neutral-400 group-hover:text-neutral-300 transition-colors">
                Automatically star Harness on GitHub
              </span>
            </label>

            <div className="relative mb-3">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={hasToken ? 'Enter a new token to replace the existing one' : 'ghp_... or github_pat_...'}
                className="w-full bg-neutral-950 border border-neutral-700 rounded px-3 py-2 pr-10 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 font-mono"
              />
              <button
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !token.trim()}
                className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 rounded text-sm text-neutral-200 transition-colors cursor-pointer"
              >
                {saving ? 'Validating...' : 'Save'}
              </button>
              {hasToken && (
                <button
                  onClick={handleClear}
                  className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                >
                  Remove
                </button>
              )}
            </div>

            {result && (
              <div className={`mt-3 text-xs flex items-center gap-1.5 ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
                {result.ok ? <Check size={12} /> : <X size={12} />}
                {result.message}
              </div>
            )}
          </div>

          <div className="mt-4 text-xs text-neutral-500 space-y-2">
            <p>
              Create a token at{' '}
              <a
                onClick={() => window.api.openExternal('https://github.com/settings/tokens?type=beta')}
                className="text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
              >
                github.com/settings/tokens
              </a>
              {' '}(fine-grained) or{' '}
              <a
                onClick={() => window.api.openExternal('https://github.com/settings/tokens')}
                className="text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
              >
                classic tokens
              </a>
              .
            </p>
            <p>
              Required scopes: <code className="bg-neutral-900 px-1 rounded">repo</code> for private repos,
              or <code className="bg-neutral-900 px-1 rounded">public_repo</code> for public only.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
