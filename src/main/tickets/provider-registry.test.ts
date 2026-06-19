import { describe, it, expect } from 'vitest'
import { validateProviderConfig } from './provider-registry'

describe('validateProviderConfig', () => {
  describe('github-issues', () => {
    it('accepts a well-formed owner/repo string', () => {
      expect(validateProviderConfig('github-issues', { repo: 'owner/name' })).toEqual({
        repo: 'owner/name'
      })
    })

    it('preserves an optional defaultQuery', () => {
      expect(
        validateProviderConfig('github-issues', {
          repo: 'owner/name',
          defaultQuery: 'label:bug'
        })
      ).toEqual({ repo: 'owner/name', defaultQuery: 'label:bug' })
    })

    it('rejects missing or malformed repo', () => {
      expect(validateProviderConfig('github-issues', {})).toBeNull()
      expect(validateProviderConfig('github-issues', { repo: '' })).toBeNull()
      expect(validateProviderConfig('github-issues', { repo: 'no-slash' })).toBeNull()
      expect(validateProviderConfig('github-issues', { repo: '/leading' })).toBeNull()
      expect(validateProviderConfig('github-issues', { repo: 'trailing/' })).toBeNull()
    })

    it('strips unknown fields', () => {
      const out = validateProviderConfig('github-issues', {
        repo: 'a/b',
        bogus: 'no'
      })
      expect(out).toEqual({ repo: 'a/b' })
    })

    it('rejects when given a notion-shape payload', () => {
      expect(
        validateProviderConfig('github-issues', { databaseId: 'abc' })
      ).toBeNull()
    })
  })

  describe('notion', () => {
    it('accepts a databaseId-only payload', () => {
      expect(validateProviderConfig('notion', { databaseId: 'db-1' })).toEqual({
        databaseId: 'db-1'
      })
    })

    it('preserves optional title + description property names', () => {
      expect(
        validateProviderConfig('notion', {
          databaseId: 'db-1',
          titleProperty: 'Task',
          descriptionProperty: 'Notes'
        })
      ).toEqual({
        databaseId: 'db-1',
        titleProperty: 'Task',
        descriptionProperty: 'Notes'
      })
    })

    it('rejects missing or empty databaseId', () => {
      expect(validateProviderConfig('notion', {})).toBeNull()
      expect(validateProviderConfig('notion', { databaseId: '' })).toBeNull()
    })

    it('drops empty-string optional properties', () => {
      expect(
        validateProviderConfig('notion', {
          databaseId: 'db-1',
          titleProperty: '',
          descriptionProperty: ''
        })
      ).toEqual({ databaseId: 'db-1' })
    })

    it('rejects when given a github-shape payload', () => {
      expect(validateProviderConfig('notion', { repo: 'a/b' })).toBeNull()
    })
  })

  it('returns null for non-object payloads', () => {
    expect(validateProviderConfig('github-issues', null)).toBeNull()
    expect(validateProviderConfig('github-issues', 'string')).toBeNull()
    expect(validateProviderConfig('notion', 123)).toBeNull()
  })
})
