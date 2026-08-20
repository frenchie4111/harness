// Window root for the app-scoped chat (see main.tsx's ?view=global-chat
// branch). Deliberately thin: the transcript, composer, tool cards, and
// approval flow are JsonModeChat's, rendered with scope="app" so the
// handful of worktree-only affordances are suppressed. What lives here
// is only what a standalone window needs and a tab doesn't — applying
// the theme and UI scale to its own document, a title bar, and the
// pre-auth screen that stands in for the chat when Claude Code has no
// credentials to run on.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Loader2, RefreshCw, SquarePen } from 'lucide-react'
import {
  useAppState,
  useGlobalChat,
  useJsonClaudeSession,
  useJsonClaudePendingApprovals
} from '../store'
import { useBackend } from '../backend'
import { useActiveTheme } from '../hooks/useActiveTheme'
import { applyTheme, effectiveAppBg } from '../theme-apply'
import { scaleSpec } from '../../shared/state/settings'
import { QUESTION_TOOL_NAME } from '../../shared/state/json-claude'
import { resolveHotkeys } from '../hotkeys'
import { useHotkeys } from '../hooks/useHotkeys'
import { JsonModeChat } from './JsonModeChat'
import { HotkeysProvider, Tooltip } from './Tooltip'

export default function GlobalChat(): JSX.Element {
  const theme = useActiveTheme()
  const nessieColor = useAppState((s) => s.settings.nessieColor)
  const uiScale = useAppState((s) => s.settings.uiScale)
  const hotkeyOverrides = useAppState((s) => s.settings.hotkeys) ?? undefined
  const backend = useBackend()
  const resolvedHotkeys = useMemo(
    () => resolveHotkeys(hotkeyOverrides),
    [hotkeyOverrides]
  )

  // Same two document-level effects App.tsx runs. They're per-document,
  // not per-app, so a second window has to run them itself.
  useEffect(() => {
    applyTheme(theme, nessieColor)
    void backend.setLastEffectiveAppBg(effectiveAppBg(theme))
  }, [backend, theme, nessieColor])
  useEffect(() => {
    document.documentElement.style.fontSize = `${scaleSpec(uiScale).rootPx}px`
  }, [uiScale])

  // HotkeysProvider carries the Radix tooltip provider that <Tooltip>
  // requires, plus the binding context <HotkeyBadge> reads — both are
  // used by the shared chat components we render here, and both throw or
  // render wrong without a provider in scope.
  return (
    <HotkeysProvider bindings={resolvedHotkeys}>
      <ApprovalHotkeys overrides={hotkeyOverrides} />
      <div className="h-screen w-screen flex flex-col bg-app text-fg overflow-hidden">
        <Body />
      </div>
    </HotkeysProvider>
  )
}

/** Approve / deny for the oldest pending approval. The approval card
 *  advertises these two bindings unconditionally, and App.tsx's
 *  handler map isn't mounted in this window — without this they'd be
 *  labels for keystrokes that do nothing. Same semantics as the
 *  `approveToolUse` / `denyToolUse` entries in useHotkeyHandlers,
 *  including the AskUserQuestion carve-out (a plain allow there resolves
 *  the question as unanswered, so the card has to own it). */
function ApprovalHotkeys({
  overrides
}: {
  overrides?: Record<string, string>
}): null {
  const backend = useBackend()
  const { sessionId } = useGlobalChat()
  const pendingApprovals = useJsonClaudePendingApprovals()
  const active = useMemo(() => {
    if (!sessionId) return null
    const mine = Object.values(pendingApprovals)
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.timestamp - b.timestamp)
    return mine[0] ?? null
  }, [pendingApprovals, sessionId])

  const resolve = useCallback(
    (behavior: 'allow' | 'deny') => {
      if (!active) return
      if (active.toolName === QUESTION_TOOL_NAME) return
      document
        .getElementById(active.requestId)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      void backend.resolveJsonClaudeApproval(
        active.requestId,
        behavior === 'allow'
          ? { behavior, updatedInput: active.input }
          : { behavior, message: 'user denied' }
      )
    },
    [active, backend]
  )

  useHotkeys(
    {
      approveToolUse: () => resolve('allow'),
      denyToolUse: () => resolve('deny')
    },
    overrides
  )
  return null
}

function Body(): JSX.Element {
  const backend = useBackend()
  const { sessionId, cwd, auth } = useGlobalChat()
  const session = useJsonClaudeSession(sessionId ?? '')
  const [bootError, setBootError] = useState<string | null>(null)

  // Idempotent main-side, so a reload resumes rather than respawning.
  useEffect(() => {
    let cancelled = false
    void backend.globalChatEnsure().catch((err: unknown) => {
      if (cancelled) return
      setBootError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
    }
  }, [backend])

  if (bootError) {
    return (
      <>
        <TitleBar />
        <Screen title="Ness Chat couldn't start" icon={<KeyRound className="icon-lg" />}>
          <p>{bootError}</p>
        </Screen>
      </>
    )
  }
  // The pre-auth screen. Once a session exists, an auth failure mid-turn
  // surfaces as JsonModeChat's own AuthFailureCard instead — this one
  // only covers the case where main declined to spawn at all.
  if (auth === 'required' && session?.state === 'auth-required') {
    return (
      <>
        <TitleBar />
        <PreAuth />
      </>
    )
  }
  if (!sessionId || !cwd) {
    return (
      <>
        <TitleBar />
        <Screen title="Starting…" icon={<Loader2 className="icon-lg animate-spin" />}>
          <p className="text-muted">Spinning up the Ness assistant.</p>
        </Screen>
      </>
    )
  }
  return (
    <>
      <TitleBar showNewChat />
      <div className="flex-1 min-h-0 relative">
        <JsonModeChat
          key={sessionId}
          sessionId={sessionId}
          worktreePath={cwd}
          scope="app"
        />
      </div>
    </>
  )
}

function TitleBar({ showNewChat }: { showNewChat?: boolean }): JSX.Element {
  const backend = useBackend()
  const resettingRef = useRef(false)
  const reset = useCallback(() => {
    if (resettingRef.current) return
    resettingRef.current = true
    void backend.globalChatReset().finally(() => {
      resettingRef.current = false
    })
  }, [backend])

  return (
    <header className="drag-region titlebar-lead shrink-0 h-9 flex items-center gap-2 pr-3 border-b border-border">
      <span className="text-xs text-muted flex-1 min-w-0 truncate">Ness Chat</span>
      {showNewChat ? (
        <Tooltip label="Start a new conversation">
          <button
            type="button"
            onClick={reset}
            aria-label="New conversation"
            className="no-drag p-1.5 rounded hover:bg-panel text-muted hover:text-fg-bright cursor-pointer"
          >
            <SquarePen className="icon-sm" />
          </button>
        </Tooltip>
      ) : null}
    </header>
  )
}

function PreAuth(): JSX.Element {
  const backend = useBackend()
  const [checking, setChecking] = useState(false)
  const recheck = useCallback(() => {
    setChecking(true)
    void backend.globalChatRecheckAuth().finally(() => setChecking(false))
  }, [backend])

  return (
    <Screen title="Claude Code isn't signed in" icon={<KeyRound className="icon-lg" />}>
      <p>
        Ness Chat runs on the same Claude Code credentials your agents use, and
        there aren&apos;t any yet. Nothing here works until that&apos;s sorted —
        but it&apos;s a one-time step.
      </p>
      <p>
        Open a terminal and run <Code>claude</Code>, then follow the sign-in
        prompt. An Anthropic subscription or an API key both work. If you&apos;d
        rather not leave Ness, open any worktree, start a Claude tab, and sign in
        there — Ness Chat shares the same <Code>~/.claude/</Code> directory.
      </p>
      <p className="text-muted">
        Already signed in elsewhere? Check again and this window will start on
        its own.
      </p>
      <button
        type="button"
        onClick={recheck}
        disabled={checking}
        className="mt-1 self-start inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-panel-raised border border-border-strong text-fg-bright hover:bg-panel disabled:opacity-40 cursor-pointer"
      >
        {checking ? (
          <Loader2 className="icon-sm animate-spin" />
        ) : (
          <RefreshCw className="icon-sm" />
        )}
        Check again
      </button>
    </Screen>
  )
}

function Code({ children }: { children: React.ReactNode }): JSX.Element {
  return <code className="font-mono text-fg-bright">{children}</code>
}

function Screen({
  title,
  icon,
  children
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-3 text-sm leading-relaxed">
        <div className="flex items-center gap-2 text-lg font-semibold text-fg-bright">
          {icon}
          <span>{title}</span>
        </div>
        {children}
      </div>
    </div>
  )
}
