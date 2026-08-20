import { describe, it, expect } from 'vitest'
import {
  globalChatReducer,
  initialGlobalChat,
  type GlobalChatState
} from './global-chat'

describe('globalChatReducer', () => {
  it('sessionAssigned records the session id and cwd', () => {
    const next = globalChatReducer(initialGlobalChat, {
      type: 'globalChat/sessionAssigned',
      payload: { sessionId: 'global-1', cwd: '/home/u/.harness/global-chat' }
    })
    expect(next.sessionId).toBe('global-1')
    expect(next.cwd).toBe('/home/u/.harness/global-chat')
  })

  it('sessionAssigned keeps the reference when nothing changed', () => {
    const seeded: GlobalChatState = {
      sessionId: 'global-1',
      cwd: '/tmp/gc',
      auth: 'ok'
    }
    const next = globalChatReducer(seeded, {
      type: 'globalChat/sessionAssigned',
      payload: { sessionId: 'global-1', cwd: '/tmp/gc' }
    })
    expect(next).toBe(seeded)
  })

  it('sessionAssigned replaces the id when the chat is reset', () => {
    const seeded: GlobalChatState = {
      sessionId: 'global-1',
      cwd: '/tmp/gc',
      auth: 'ok'
    }
    const next = globalChatReducer(seeded, {
      type: 'globalChat/sessionAssigned',
      payload: { sessionId: 'global-2', cwd: '/tmp/gc' }
    })
    expect(next.sessionId).toBe('global-2')
    expect(next.auth).toBe('ok')
  })

  it('authChanged updates the auth verdict', () => {
    const next = globalChatReducer(initialGlobalChat, {
      type: 'globalChat/authChanged',
      payload: 'required'
    })
    expect(next.auth).toBe('required')
  })

  it('authChanged keeps the reference when the verdict is unchanged', () => {
    const seeded: GlobalChatState = { sessionId: null, cwd: '', auth: 'ok' }
    expect(
      globalChatReducer(seeded, {
        type: 'globalChat/authChanged',
        payload: 'ok'
      })
    ).toBe(seeded)
  })
})
