import { describe, it, expect } from 'vitest'
import {
  initialSshBootstrap,
  sshBootstrapReducer,
  type BootstrapError
} from './ssh-bootstrap'

const err: BootstrapError = {
  code: 'auth_failed',
  message: 'SSH key rejected for mike@build-box'
}

const start = (id = 'b1') =>
  sshBootstrapReducer(initialSshBootstrap, {
    type: 'sshBootstrap/started',
    payload: { bootstrapId: id, label: 'build-box', target: 'build-box', now: 1000 }
  })

describe('sshBootstrapReducer', () => {
  it('sshBootstrap/started seeds an entry in connecting phase', () => {
    const next = start()
    expect(next.byId['b1']).toEqual({
      bootstrapId: 'b1',
      label: 'build-box',
      target: 'build-box',
      phase: 'connecting',
      lines: [],
      updatedAt: 1000
    })
  })

  it('sshBootstrap/started replaces an existing entry for the same id', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/started',
      payload: { bootstrapId: 'b1', label: 'build-box-2', target: 'newhost', now: 2000 }
    })
    expect(s2.byId['b1'].label).toBe('build-box-2')
    expect(s2.byId['b1'].target).toBe('newhost')
    expect(s2.byId['b1'].updatedAt).toBe(2000)
    expect(s2.byId['b1'].lines).toEqual([])
  })

  it('sshBootstrap/phaseChanged updates phase + updatedAt', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/phaseChanged',
      payload: { bootstrapId: 'b1', phase: 'installing', now: 1500 }
    })
    expect(s2.byId['b1'].phase).toBe('installing')
    expect(s2.byId['b1'].updatedAt).toBe(1500)
  })

  it('sshBootstrap/phaseChanged is a no-op for unknown id', () => {
    const next = sshBootstrapReducer(initialSshBootstrap, {
      type: 'sshBootstrap/phaseChanged',
      payload: { bootstrapId: 'missing', phase: 'installing', now: 1500 }
    })
    expect(next).toBe(initialSshBootstrap)
  })

  it('sshBootstrap/lineLogged appends to lines and bumps updatedAt', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/lineLogged',
      payload: { bootstrapId: 'b1', line: 'first line', now: 1100 }
    })
    const s3 = sshBootstrapReducer(s2, {
      type: 'sshBootstrap/lineLogged',
      payload: { bootstrapId: 'b1', line: 'second line', now: 1200 }
    })
    expect(s3.byId['b1'].lines).toEqual(['first line', 'second line'])
    expect(s3.byId['b1'].updatedAt).toBe(1200)
  })

  it('sshBootstrap/connectionLinked attaches connectionId', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/connectionLinked',
      payload: { bootstrapId: 'b1', connectionId: 'conn-1' }
    })
    expect(s2.byId['b1'].connectionId).toBe('conn-1')
  })

  it('sshBootstrap/errored flips phase to error and attaches detail', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/errored',
      payload: { bootstrapId: 'b1', error: err, now: 1900 }
    })
    expect(s2.byId['b1'].phase).toBe('error')
    expect(s2.byId['b1'].error).toEqual(err)
    expect(s2.byId['b1'].updatedAt).toBe(1900)
  })

  it('sshBootstrap/clear removes the entry', () => {
    const s1 = start()
    const s2 = sshBootstrapReducer(s1, {
      type: 'sshBootstrap/clear',
      payload: { bootstrapId: 'b1' }
    })
    expect(s2.byId['b1']).toBeUndefined()
  })

  it('sshBootstrap/clear is a no-op for unknown id (returns same reference)', () => {
    const cleared = sshBootstrapReducer(initialSshBootstrap, {
      type: 'sshBootstrap/clear',
      payload: { bootstrapId: 'missing' }
    })
    expect(cleared).toBe(initialSshBootstrap)
  })

  it('does not mutate the input state', () => {
    const next = start()
    expect(next).not.toBe(initialSshBootstrap)
    expect(initialSshBootstrap.byId).toEqual({})
  })

  it('multiple bootstraps coexist independently', () => {
    let state = start('b1')
    state = sshBootstrapReducer(state, {
      type: 'sshBootstrap/started',
      payload: { bootstrapId: 'b2', label: 'dev-box', target: 'dev-box', now: 2000 }
    })
    state = sshBootstrapReducer(state, {
      type: 'sshBootstrap/phaseChanged',
      payload: { bootstrapId: 'b1', phase: 'tunneling', now: 2100 }
    })
    expect(state.byId['b1'].phase).toBe('tunneling')
    expect(state.byId['b2'].phase).toBe('connecting')
    expect(state.byId['b2'].label).toBe('dev-box')
  })
})
