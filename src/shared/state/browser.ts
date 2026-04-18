export interface BrowserTabState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface BrowserState {
  /** Per-tab navigation state, keyed by tab id. */
  byTab: Record<string, BrowserTabState>
}

export type BrowserEvent =
  | {
      type: 'browser/tabStateChanged'
      payload: { tabId: string; state: Partial<BrowserTabState> }
    }
  | { type: 'browser/tabRemoved'; payload: string }

export const initialBrowser: BrowserState = {
  byTab: {}
}

export const initialTabState: BrowserTabState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false
}

export function browserReducer(
  state: BrowserState,
  event: BrowserEvent
): BrowserState {
  switch (event.type) {
    case 'browser/tabStateChanged': {
      const { tabId, state: patch } = event.payload
      const prev = state.byTab[tabId] || initialTabState
      return {
        ...state,
        byTab: { ...state.byTab, [tabId]: { ...prev, ...patch } }
      }
    }
    case 'browser/tabRemoved': {
      const tabId = event.payload
      if (!(tabId in state.byTab)) return state
      const { [tabId]: _dropped, ...rest } = state.byTab
      void _dropped
      return { ...state, byTab: rest }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
