import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { log } from './debug'
import type { RepoConfig } from '../shared/state/repo-configs'

export type { RepoConfig }

const REPO_CONFIG_FILENAME = '.harness.json'
const cache = new Map<string, RepoConfig>()

function configPath(repoRoot: string): string {
  return join(repoRoot, REPO_CONFIG_FILENAME)
}

export function loadRepoConfig(repoRoot: string): RepoConfig {
  if (!repoRoot) return {}
  const cached = cache.get(repoRoot)
  if (cached) return cached
  const path = configPath(repoRoot)
  if (!existsSync(path)) {
    cache.set(repoRoot, {})
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RepoConfig
    const clean = parsed && typeof parsed === 'object' ? parsed : {}
    cache.set(repoRoot, clean)
    return clean
  } catch (err) {
    log('repo-config', `failed to load ${path}: ${(err as Error).message}`)
    cache.set(repoRoot, {})
    return {}
  }
}

export function saveRepoConfig(repoRoot: string, next: RepoConfig): RepoConfig {
  const cleaned: RepoConfig = { version: 1 }
  const setup = next.setupCommand?.trim()
  const teardown = next.teardownCommand?.trim()
  if (setup) cleaned.setupCommand = setup
  if (teardown) cleaned.teardownCommand = teardown
  if (next.mergeStrategy) cleaned.mergeStrategy = next.mergeStrategy
  if (next.hideMergePanel) cleaned.hideMergePanel = true
  if (next.hidePrPanel) cleaned.hidePrPanel = true

  const hasAny = Object.keys(cleaned).some((k) => k !== 'version')
  const path = configPath(repoRoot)
  try {
    if (!hasAny) {
      if (existsSync(path)) unlinkSync(path)
      cache.set(repoRoot, {})
      return {}
    }
    writeFileSync(path, JSON.stringify(cleaned, null, 2) + '\n')
    cache.set(repoRoot, cleaned)
    return cleaned
  } catch (err) {
    log('repo-config', `failed to save ${path}: ${(err as Error).message}`)
    return cache.get(repoRoot) || {}
  }
}

export function invalidateRepoConfigCache(repoRoot?: string): void {
  if (repoRoot) cache.delete(repoRoot)
  else cache.clear()
}
