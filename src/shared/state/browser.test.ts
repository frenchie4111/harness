import { describe, it, expect } from 'vitest'
import { initialBrowser, browserReducer, type BrowserState } from './browser'

describe('browserReducer', () => {
  it('tabStateChanged creates an entry and merges partial updates', () => {
    let state: BrowserState = initialBrowser
    state = browserReducer(state, {
      type: 'browser/tabStateChanged',
      payload: { tabId: 'b1', state: { url: 'https://example.com', loading: true } }
    })
    expect(state.byTab.b1.url).toBe('https://example.com')
    expect(state.byTab.b1.loading).toBe(true)
    expect(state.byTab.b1.title).toBe('')

    state = browserReducer(state, {
      type: 'browser/tabStateChanged',
      payload: { tabId: 'b1', state: { title: 'Example', loading: false } }
    })
    expect(state.byTab.b1.url).toBe('https://example.com')
    expect(state.byTab.b1.title).toBe('Example')
    expect(state.byTab.b1.loading).toBe(false)
  })

  it('tabRemoved drops the entry', () => {
    let state: BrowserState = initialBrowser
    state = browserReducer(state, {
      type: 'browser/tabStateChanged',
      payload: { tabId: 'b1', state: { url: 'x' } }
    })
    expect(state.byTab.b1).toBeDefined()
    state = browserReducer(state, { type: 'browser/tabRemoved', payload: 'b1' })
    expect(state.byTab.b1).toBeUndefined()
  })
})
