import { createContext, useContext, type ReactNode, type ReactElement } from 'react'
import {
  bindingToString,
  formatBindingGlyphs,
  type Action,
  type HotkeyBinding
} from '../hotkeys'

const HotkeysContext = createContext<Record<Action, HotkeyBinding> | null>(null)

export function HotkeysContextProvider({
  bindings,
  children
}: {
  bindings: Record<Action, HotkeyBinding>
  children: ReactNode
}): ReactElement {
  return <HotkeysContext.Provider value={bindings}>{children}</HotkeysContext.Provider>
}

export function useHotkeyLabel(action: Action | undefined): string | null {
  const bindings = useContext(HotkeysContext)
  if (!action || !bindings) return null
  const b = bindings[action]
  return b ? bindingToString(b) : null
}

interface HotkeyBadgeProps {
  /** Action name — badge looks up the current binding from context. */
  action?: Action
  /** Explicit binding string like "Cmd+K", overrides action lookup. */
  binding?: string
  /** Visual emphasis — "subtle" for inline next to labels, "strong" on hover. */
  variant?: 'subtle' | 'strong'
  className?: string
}

export function HotkeyBadge({
  action,
  binding,
  variant = 'subtle',
  className = ''
}: HotkeyBadgeProps): ReactElement | null {
  const labelFromAction = useHotkeyLabel(action)
  const text = binding ?? labelFromAction
  if (!text) return null

  const base =
    'inline-flex items-center font-mono text-[10px] leading-none rounded px-1 py-0.5 select-none whitespace-nowrap shrink-0'
  const style =
    variant === 'strong'
      ? 'bg-panel-raised border border-border-strong text-fg'
      : 'bg-app/60 border border-border text-faint'

  return <span className={`${base} ${style} ${className}`}>{formatBindingGlyphs(text)}</span>
}
