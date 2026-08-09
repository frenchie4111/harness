import { useEffect, useRef } from 'react'
import type { Action } from '../hotkeys'
import { matchesBinding, resolveHotkeys, GESTURE_ACTIONS } from '../hotkeys'
import type { HotkeyBinding } from '../hotkeys'

type ActionMap = Partial<Record<Action, () => void>>

/**
 * Global hotkey listener. Attaches a single keydown handler on window
 * that checks all bindings and fires the matching action handler.
 *
 * @param actions - Map of action names to handler functions
 * @param overrides - Optional user config overrides (action name → shortcut string)
 */
export function useHotkeys(actions: ActionMap, overrides?: Record<string, string>): void {
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const bindingsRef = useRef<Record<Action, HotkeyBinding>>(resolveHotkeys(overrides))

  useEffect(() => {
    bindingsRef.current = resolveHotkeys(overrides)
  }, [overrides])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // Opt-in shielding: any focused element (or ancestor) with
      // `data-hotkeys="ignore"` gets full keyboard access — global
      // hotkeys are suppressed while typing inside it. Used by inline
      // editors (e.g. the alias rename input) so Cmd+W / Cmd+K / etc.
      // don't fire mid-edit. We use opt-in rather than a general
      // "skip when a text input is focused" rule because xterm.js uses
      // a hidden textarea for input capture — a general rule would
      // break every terminal-time hotkey.
      const target = e.target
      if (
        target instanceof Element &&
        target.closest('[data-hotkeys="ignore"]')
      ) {
        return
      }

      const bindings = bindingsRef.current
      const handlers = actionsRef.current

      for (const [action, binding] of Object.entries(bindings)) {
        if (GESTURE_ACTIONS.has(action as Action)) continue
        const handler = handlers[action as Action]
        if (!handler) continue

        if (matchesBinding(e, binding)) {
          e.preventDefault()
          e.stopPropagation()
          handler()
          return
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])
}
