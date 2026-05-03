export type UpdaterStatus =
  | { state: 'checking' }
  | {
      state: 'available'
      version: string
      releaseUrl?: string
      manualInstallRequired?: boolean
    }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; error: string }

export interface UpdaterState {
  status: UpdaterStatus | null
}

export type UpdaterEvent = {
  type: 'updater/statusChanged'
  payload: UpdaterStatus
}

export const initialUpdater: UpdaterState = {
  status: null
}

export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case 'updater/statusChanged':
      return { ...state, status: event.payload }
    default: {
      const _exhaustive: never = event.type
      void _exhaustive
      return state
    }
  }
}
