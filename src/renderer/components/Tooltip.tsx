import {
  createContext,
  useContext,
  type ReactNode,
  type ReactElement
} from 'react'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { bindingToString, type Action, type HotkeyBinding } from '../hotkeys'

/** Context that exposes the resolved hotkey map so tooltips can display the
 * current shortcut for an action without prop-drilling. */
const HotkeysContext = createContext<Record<Action, HotkeyBinding> | null>(null)

export function HotkeysProvider({
  bindings,
  children
}: {
  bindings: Record<Action, HotkeyBinding>
  children: ReactNode
}): ReactElement {
  // delayDuration: 0 → show instantly. skipDelayDuration keeps the 0-delay
  // behavior when moving between adjacent tooltips.
  return (
    <HotkeysContext.Provider value={bindings}>
      <RadixTooltip.Provider delayDuration={0} skipDelayDuration={0}>
        {children}
      </RadixTooltip.Provider>
    </HotkeysContext.Provider>
  )
}

function useHotkeyLabel(action: Action | undefined): string | null {
  const bindings = useContext(HotkeysContext)
  if (!action || !bindings) return null
  const b = bindings[action]
  return b ? bindingToString(b) : null
}

/** Format Cmd+Shift+E-style strings as ⌘⇧E with Unicode mac glyphs. */
function formatBindingForDisplay(binding: string): string {
  return binding
    .split('+')
    .map((part) => {
      const lower = part.trim().toLowerCase()
      if (lower === 'cmd' || lower === 'meta') return '\u2318' // ⌘
      if (lower === 'ctrl' || lower === 'control') return '\u2303' // ⌃
      if (lower === 'alt' || lower === 'option') return '\u2325' // ⌥
      if (lower === 'shift') return '\u21E7' // ⇧
      if (part === 'ArrowUp') return '\u2191'
      if (part === 'ArrowDown') return '\u2193'
      if (part === 'ArrowLeft') return '\u2190'
      if (part === 'ArrowRight') return '\u2192'
      if (part === 'Enter') return '\u23CE'
      if (part === 'Tab') return '\u21E5'
      if (part === 'Escape') return 'Esc'
      return part
    })
    .join('')
}

type Side = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: ReactNode
  /** Action name — if provided and the user has a binding for it, shows the
   * shortcut in a chip inside the tooltip. */
  action?: Action
  /** Explicit hotkey display string, overrides action lookup. */
  hotkey?: string
  side?: Side
  children: ReactElement
}

/** Thin wrapper over Radix Tooltip that renders a label + optional hotkey
 * chip. Radix handles collision detection, auto-flipping, and offset. */
export function Tooltip({
  label,
  action,
  hotkey,
  side = 'bottom',
  children
}: TooltipProps): ReactElement {
  const hotkeyFromAction = useHotkeyLabel(action)
  const hotkeyText = hotkey ?? hotkeyFromAction ?? null

  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className="z-50 flex items-center gap-2 bg-panel-raised border border-border-strong rounded px-2 py-1 text-xs text-fg-bright shadow-lg whitespace-nowrap select-none"
        >
          <span>{label}</span>
          {hotkeyText && (
            <span className="font-mono text-[10px] text-faint bg-app border border-border rounded px-1 py-0.5">
              {formatBindingForDisplay(hotkeyText)}
            </span>
          )}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
