import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SubagentTailer,
  parseAsyncLaunch,
  parseTaskNotification
} from './subagent-tailer'
import type { JsonClaudeChatEntry } from '../shared/state/json-claude'

// Verbatim from a real session — the exact prose Claude Code emits as the
// Task tool_result when a sub-agent is launched with run_in_background.
const LAUNCH_STUB = `Async agent launched successfully.
agentId: aece96b04cf6ba1c8 (internal ID - do not mention to user. Use SendMessage with to: 'aece96b04cf6ba1c8' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /private/tmp/claude-501/-Users-mike-proj/ccdb876f/tasks/aece96b04cf6ba1c8.output
Do NOT Read or tail this file via the shell tool — it is the full sub-agent JSONL transcript.`

const NOTIFICATION = `<task-notification>
<task-id>aece96b04cf6ba1c8</task-id>
<tool-use-id>toolu_017cdtxTucXJQuk5hyBFCdA6</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-mike-proj/ccdb876f/tasks/aece96b04cf6ba1c8.output</output-file>
<status>completed</status>
<summary>Agent "Source U of A financial deadlines" completed</summary>
<result>## 1. Alberta Student Aid

**NO SPECIFIC OPEN DATE PUBLISHED** — see <https://studentaid.alberta.ca/>.</result>
<usage><total_tokens>158902</total_tokens><tool_uses>168</tool_uses><duration_ms>793689</duration_ms></usage>
</task-notification>`

describe('parseAsyncLaunch', () => {
  it('extracts the agent id and output file from the launch stub', () => {
    expect(parseAsyncLaunch(LAUNCH_STUB)).toEqual({
      agentId: 'aece96b04cf6ba1c8',
      outputFile:
        '/private/tmp/claude-501/-Users-mike-proj/ccdb876f/tasks/aece96b04cf6ba1c8.output'
    })
  })

  it('ignores an ordinary tool result', () => {
    expect(parseAsyncLaunch('Found 3 matches in src/main/index.ts')).toBeNull()
  })

  it('ignores prose that merely mentions an agentId', () => {
    expect(
      parseAsyncLaunch('The agentId: abc123 field is used for correlation.')
    ).toBeNull()
  })

  it('accepts a stub without the announcement sentence', () => {
    const stub = 'agentId: xyz789\noutput_file: /tmp/tasks/xyz789.output'
    expect(parseAsyncLaunch(stub)?.agentId).toBe('xyz789')
  })
})

describe('parseTaskNotification', () => {
  it('parses ids, status, result and usage totals', () => {
    const n = parseTaskNotification(NOTIFICATION)
    expect(n?.taskId).toBe('aece96b04cf6ba1c8')
    expect(n?.toolUseId).toBe('toolu_017cdtxTucXJQuk5hyBFCdA6')
    expect(n?.status).toBe('completed')
    expect(n?.summary).toBe('Agent "Source U of A financial deadlines" completed')
    expect(n?.usage).toEqual({
      totalTokens: 158902,
      toolUses: 168,
      durationMs: 793689
    })
  })

  it('keeps markdown and angle brackets inside <result> intact', () => {
    expect(parseTaskNotification(NOTIFICATION)?.result).toContain(
      '<https://studentaid.alberta.ca/>'
    )
  })

  it('finds the block when wrapped in surrounding text', () => {
    const wrapped = `[SYSTEM NOTIFICATION]\n${NOTIFICATION}\ntrailing noise`
    expect(parseTaskNotification(wrapped)?.taskId).toBe('aece96b04cf6ba1c8')
  })

  it('returns null for a normal user message', () => {
    expect(parseTaskNotification('please fix the build')).toBeNull()
  })
})

// One assistant turn + its tool_result, in the on-disk sub-agent shape.
function assistantLine(text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      agentId: 'agent-x',
      uuid: `u-${text}`,
      message: {
        id: `msg_${text}`,
        role: 'assistant',
        content: [
          { type: 'text', text },
          { type: 'tool_use', id: `tu_${text}`, name: 'Read', input: { file_path: '/a' } }
        ]
      }
    }) + '\n'
  )
}

function toolResultLine(forText: string): string {
  return (
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      agentId: 'agent-x',
      uuid: `ur-${forText}`,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `tu_${forText}`, content: 'file body' }
        ]
      }
    }) + '\n'
  )
}

describe('SubagentTailer', () => {
  let dir: string
  let received: Array<{ sessionId: string; entries: JsonClaudeChatEntry[] }>
  let tailer: SubagentTailer

  // The tailer derives its path from ~/.claude/projects/... — point HOME at
  // a temp dir so the test writes somewhere disposable.
  beforeEach(() => {
    dir = join(tmpdir(), `harness-subagent-${Date.now()}-${Math.random()}`)
    mkdirSync(dir, { recursive: true })
    vi.stubEnv('HOME', dir)
    received = []
    tailer = new SubagentTailer((sessionId, entries) =>
      received.push({ sessionId, entries })
    )
  })

  afterEach(() => {
    tailer.dispose()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function transcriptFile(sessionId: string, worktreePath: string): string {
    const projectDir = join(
      dir,
      '.claude',
      'projects',
      worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
      sessionId,
      'subagents'
    )
    mkdirSync(projectDir, { recursive: true })
    return join(projectDir, 'agent-agent-x.jsonl')
  }

  async function settle(ms = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  it('stamps the launching tool_use id onto every tailed entry', async () => {
    const file = transcriptFile('sess-1', '/tmp/wt')
    writeFileSync(file, assistantLine('one') + toolResultLine('one'))

    tailer.start({
      sessionId: 'sess-1',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    })
    await settle()

    const entries = received.flatMap((r) => r.entries)
    expect(entries.length).toBeGreaterThan(0)
    // This is what makes the existing TaskCard nesting pick them up.
    expect(entries.every((e) => e.parentToolUseId === 'toolu_parent')).toBe(true)
    expect(entries.some((e) => e.kind === 'assistant')).toBe(true)
    expect(entries.some((e) => e.kind === 'tool_result')).toBe(true)
  })

  it('emits only newly appended lines, never re-emitting old ones', async () => {
    const file = transcriptFile('sess-2', '/tmp/wt')
    writeFileSync(file, assistantLine('one'))
    tailer.start({
      sessionId: 'sess-2',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    })
    await settle()
    const afterFirst = received.flatMap((r) => r.entries).length

    appendFileSync(file, assistantLine('two'))
    await settle()

    const all = received.flatMap((r) => r.entries)
    expect(all.length).toBeGreaterThan(afterFirst)
    const ids = all.map((e) => e.entryId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('holds back a partially written final line until its newline arrives', async () => {
    const file = transcriptFile('sess-3', '/tmp/wt')
    const full = assistantLine('one')
    writeFileSync(file, full.slice(0, full.length - 10))
    tailer.start({
      sessionId: 'sess-3',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    })
    await settle()
    expect(received.flatMap((r) => r.entries)).toHaveLength(0)

    appendFileSync(file, full.slice(full.length - 10))
    await settle()
    expect(received.flatMap((r) => r.entries).length).toBeGreaterThan(0)
  })

  it('picks up a transcript that does not exist yet at launch time', async () => {
    tailer.start({
      sessionId: 'sess-4',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    })
    await settle(100)
    const file = transcriptFile('sess-4', '/tmp/wt')
    writeFileSync(file, assistantLine('late'))
    await settle(600)

    expect(received.flatMap((r) => r.entries).length).toBeGreaterThan(0)
  })

  it('drains remaining lines on finish and stops watching', async () => {
    const file = transcriptFile('sess-5', '/tmp/wt')
    writeFileSync(file, assistantLine('one'))
    tailer.start({
      sessionId: 'sess-5',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    })
    await settle()

    appendFileSync(file, assistantLine('final'))
    tailer.finish('sess-5', 'toolu_parent')
    await settle()
    const countAtFinish = received.flatMap((r) => r.entries).length

    appendFileSync(file, assistantLine('after'))
    await settle()
    expect(received.flatMap((r) => r.entries).length).toBe(countAtFinish)
  })

  it('does not double-tail when the same launch is seen twice', async () => {
    const file = transcriptFile('sess-6', '/tmp/wt')
    writeFileSync(file, assistantLine('one'))
    const args = {
      sessionId: 'sess-6',
      worktreePath: '/tmp/wt',
      toolUseId: 'toolu_parent',
      agentId: 'agent-x'
    }
    tailer.start(args)
    tailer.start(args)
    await settle()

    const kinds = received
      .flatMap((r) => r.entries)
      .filter((e) => e.kind === 'assistant')
    expect(kinds).toHaveLength(1)
  })
})
