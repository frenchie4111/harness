import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory fs: `files` keys are file paths; directories are implicit
// (any strict prefix of a file path is a directory). `mtimes` backs statSync.
const fsState: { files: Map<string, string>; mtimes: Map<string, number> } = {
  files: new Map(),
  mtimes: new Map()
}

function isDir(p: string): boolean {
  const prefix = p.endsWith('/') ? p : p + '/'
  for (const key of fsState.files.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p) || isDir(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.files.set(p, data)
  },
  mkdirSync: () => {},
  readdirSync: (p: string) => {
    const prefix = p.endsWith('/') ? p : p + '/'
    const names = new Set<string>()
    for (const key of fsState.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0])
    }
    return [...names].map((name) => ({
      name,
      isDirectory: () => isDir(prefix + name)
    }))
  },
  statSync: (p: string) => {
    if (!fsState.files.has(p) && !isDir(p)) throw new Error(`ENOENT: ${p}`)
    return { mtimeMs: fsState.mtimes.get(p) ?? 0 }
  }
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

vi.mock('../hooks', () => ({
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks,
  buildSpawnArgs,
  latestSessionId
} from './cursor'

const HOOKS_PATH = join(homedir(), '.cursor', 'hooks.json')

// Mirror cursor.ts's projectTranscriptsDir(): ~/.cursor/projects/<slug>/agent-transcripts
function projectDir(cwd: string): string {
  const slug = cwd.replace(/^\/+/, '').replace(/\//g, '-')
  return join(homedir(), '.cursor', 'projects', slug, 'agent-transcripts')
}

function transcriptFile(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), sessionId, `${sessionId}.jsonl`)
}

beforeEach(() => {
  fsState.files.clear()
  fsState.mtimes.clear()
})

describe('cursor hook install / dedup', () => {
  it('hooksInstalled() recognizes entries with the status-dir signature', () => {
    const data = {
      version: 1,
      hooks: {
        preToolUse: [
          {
            command:
              "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
            timeout: 5
          }
        ]
      }
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: 'echo user hook', timeout: 5 }]
        }
      })
    )
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      const entries = data.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].command).toContain('/tmp/harness-status')
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    after.hooks.preToolUse.push({ command: 'echo user hook' })
    fsState.files.set(HOOKS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(final.hooks?.preToolUse).toEqual([{ command: 'echo user hook' }])
    expect(final.hooks?.postToolUse).toBeUndefined()
  })
})

describe('cursor buildSpawnArgs', () => {
  it('appends --model when configured', () => {
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        model: 'composer-2.5'
      })
    ).toBe("agent --model 'composer-2.5'")
  })

  it('starts fresh when the session is not on disk yet', () => {
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        sessionId: 'abc-123'
      })
    ).toBe('agent')
  })

  it('resumes when the session exists under the project slug', () => {
    fsState.files.set(transcriptFile('/tmp', 'abc-123'), '')
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        sessionId: 'abc-123'
      })
    ).toBe('agent --resume abc-123')
  })

  it("resumes via global scan when Cursor's project slug differs from ours", () => {
    fsState.files.set(
      join(
        homedir(),
        '.cursor',
        'projects',
        'some-other-slug',
        'agent-transcripts',
        'abc-123',
        'abc-123.jsonl'
      ),
      ''
    )
    expect(
      buildSpawnArgs({
        command: 'agent',
        cwd: '/tmp',
        sessionId: 'abc-123'
      })
    ).toBe('agent --resume abc-123')
  })
})

describe('cursor latestSessionId', () => {
  it('returns the session whose transcript was written most recently', () => {
    const older = transcriptFile('/tmp', 'aaa-111')
    const newer = transcriptFile('/tmp', 'bbb-222')
    fsState.files.set(older, '')
    fsState.files.set(newer, '')
    fsState.mtimes.set(older, 100)
    fsState.mtimes.set(newer, 200)
    expect(latestSessionId('/tmp')).toBe('bbb-222')
  })

  it('ignores sessions belonging to other projects', () => {
    const ours = transcriptFile('/tmp', 'aaa-111')
    const theirs = transcriptFile('/other/project', 'zzz-999')
    fsState.files.set(ours, '')
    fsState.files.set(theirs, '')
    fsState.mtimes.set(ours, 100)
    fsState.mtimes.set(theirs, 999)
    expect(latestSessionId('/tmp')).toBe('aaa-111')
  })

  it('returns null when the project has no sessions', () => {
    expect(latestSessionId('/tmp')).toBeNull()
  })
})
