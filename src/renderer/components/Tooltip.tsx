import { type ReactNode, type ReactElement } from 'react'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import { formatBindingGlyphs, type Action, type HotkeyBinding } from '../hotkeys'
import { HotkeysContextProvider, useHotkeyLabel } from './HotkeyBadge'

export function HotkeysProvider({
  bindings,
  children
}: {
  bindings: Record<Action, HotkeyBinding>
  children: ReactNode
}): ReactElement {
  return (
    <HotkeysContextProvider bindings={bindings}>
      <RadixTooltip.Provider delayDuration={0} skipDelayDuration={0}>
        {children}
      </RadixTooltip.Provider>
    </HotkeysContextProvider>
  )
}

type Side = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: ReactNode
  action?: Action
  hotkey?: string
  side?: Side
  children: ReactElement
}

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
              {formatBindingGlyphs(hotkeyText)}
            </span>
          )}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
