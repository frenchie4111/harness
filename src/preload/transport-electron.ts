// Electron implementation of the shared ClientTransport interface.
//
// Wraps ipcRenderer so the preload's exposed `window.api` surface can be
// built as thin one-line wrappers over the transport instead of each
// method calling ipcRenderer directly. A future ClientTransport
// implementation (WebSocket, etc.) slots in here without changing any
// method on window.api.

import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { StateEvent, StateSnapshot } from '../shared/state'
import type {
  ClientSignalHandler,
  ClientTransport,
  StateEventListener
} from '../shared/transport/transport'

export class ElectronClientTransport implements ClientTransport {
  getStateSnapshot(): Promise<StateSnapshot> {
    return ipcRenderer.invoke('state:getSnapshot')
  }

  onStateEvent(listener: StateEventListener): () => void {
    const handler = (_event: IpcRendererEvent, stateEvent: StateEvent, seq: number): void => {
      listener(stateEvent, seq)
    }
    ipcRenderer.on('state:event', handler)
    return () => {
      ipcRenderer.removeListener('state:event', handler)
    }
  }

  request(name: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(name, ...args)
  }

  send(name: string, ...args: unknown[]): void {
    ipcRenderer.send(name, ...args)
  }

  onSignal(name: string, handler: ClientSignalHandler): () => void {
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      handler(...args)
    }
    ipcRenderer.on(name, wrapped)
    return () => {
      ipcRenderer.removeListener(name, wrapped)
    }
  }

  getClientId(): Promise<string> {
    return ipcRenderer.invoke('transport:getClientId') as Promise<string>
  }
}
