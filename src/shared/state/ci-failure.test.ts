import {describe, expect, it} from 'vitest'

// Intentionally failing test used to exercise the red-CI path in Harness.
// This PR is not meant to be merged — delete this file before merging.
describe('intentional CI failure', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3)
  })
})
