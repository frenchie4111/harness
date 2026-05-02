// Pure suggestion generator for the "Always allow" picker on the
// json-mode approval card. The MCP --permission-prompt-tool path
// doesn't carry Claude's own permission_suggestions, so we synthesize
// a small list ourselves from the tool name + raw input. The picker
// is responsible for letting the user choose; this module is just the
// table of options.
//
// Each suggestion carries the structured rule shape Claude expects
// (toolName + optional ruleContent) plus a pre-rendered display label.
// Ruleshape mirrors what's inside the bundled claude-code binary's
// addRules entries — a bare {toolName} with no ruleContent means "any
// invocation of this tool"; ruleContent like "git status:*" or
// "/repo/src/**" or "domain:example.com" matches a subset.
//
// Heuristics (narrow → broad):
//   Bash      → ruleContent "<head> <arg1>:*" / "<head>:*" / bare
//   Read,Write,Edit,MultiEdit → exact path / "<dir>/**" / bare  (only if path is inside cwd)
//   Grep,Glob → pattern / bare
//   WebFetch  → url / "domain:<host>" / bare
//   mcp__*    → bare toolName (input shapes vary too much to glob)
//   default   → bare toolName
//
// Cross-cwd file-path caveat: claude's permission matcher anchors
// path-based rules to the destination's root (cwd for localSettings,
// home for userSettings) and skips any path that resolves to a
// relative `..` path against that anchor. Result: a rule like
// Write(/tmp/**) written to a worktree's .claude/settings.local.json
// silently won't fire when the worktree is anywhere outside /tmp.
// `additionalDirectories` widens path-access boundaries but does NOT
// affect rule matching. The only persistent grant that actually fires
// for a cross-cwd file-tool path is the bare-tool rule (`Write` etc.,
// no parens) — same as TUI claude's "Yes, don't ask again" path. So
// when the request's file_path is outside the supplied cwd, we drop
// narrow/medium and only emit the bare grant.

export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

export interface PermissionPatternSuggestion {
  rule: PermissionRule
  label: string
  scope: 'narrow' | 'medium' | 'broad'
}

function strField(input: Record<string, unknown> | undefined, key: string): string | null {
  if (!input) return null
  const v = input[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parentDir(filePath: string): string | null {
  const idx = filePath.lastIndexOf('/')
  if (idx <= 0) return null
  return filePath.slice(0, idx)
}

function extractHost(url: string): string | null {
  try {
    const u = new URL(url)
    return u.host || null
  } catch {
    const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
    return m ? m[1] : null
  }
}

function formatLabel(rule: PermissionRule): string {
  return rule.ruleContent
    ? `${rule.toolName}(${rule.ruleContent})`
    : rule.toolName
}

function bashSuggestions(
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const command = strField(input, 'command')
  if (!command) {
    return [
      { rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' }
    ]
  }
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const head = tokens[0]
  const arg1 = tokens[1]
  const out: PermissionPatternSuggestion[] = []
  if (head && arg1) {
    const rule: PermissionRule = { toolName: 'Bash', ruleContent: `${head} ${arg1}:*` }
    out.push({ rule, label: formatLabel(rule), scope: 'narrow' })
  }
  if (head) {
    const rule: PermissionRule = { toolName: 'Bash', ruleContent: `${head}:*` }
    out.push({ rule, label: formatLabel(rule), scope: 'medium' })
  }
  out.push({ rule: { toolName: 'Bash' }, label: 'Bash', scope: 'broad' })
  return out
}

function fileToolSuggestions(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined
): PermissionPatternSuggestion[] {
  const filePath = strField(input, 'file_path')
  if (!filePath) {
    return [{ rule: { toolName }, label: toolName, scope: 'broad' }]
  }
  // Cross-cwd path: narrow + medium would silently never fire (matcher
  // skips any rule whose anchor-relative path starts with `..`). Drop
  // them and only offer the bare-tool grant, which is what TUI claude
  // also persists for the equivalent "Yes, don't ask again" path.
  if (cwd && !isPathInsideCwd(filePath, cwd)) {
    return [{ rule: { toolName }, label: toolName, scope: 'broad' }]
  }
  const out: PermissionPatternSuggestion[] = []
  const exact: PermissionRule = { toolName, ruleContent: filePath }
  out.push({ rule: exact, label: formatLabel(exact), scope: 'narrow' })
  const dir = parentDir(filePath)
  if (dir) {
    const glob: PermissionRule = { toolName, ruleContent: `${dir}/**` }
    out.push({ rule: glob, label: formatLabel(glob), scope: 'medium' })
  }
  out.push({ rule: { toolName }, label: toolName, scope: 'broad' })
  return out
}

const FILE_TOOLS_INTERNAL = ['Read', 'Write', 'Edit', 'MultiEdit'] as const

function isPathInsideCwd(filePath: string, cwd: string): boolean {
  // Both paths are compared as raw strings — no symlink resolution
  // (the renderer can't realpath synchronously). Relative file paths
  // are treated as inside cwd: tools resolve them against cwd anyway.
  if (!filePath.startsWith('/')) return true
  const cwdNorm = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return filePath === cwdNorm || filePath.startsWith(cwdNorm + '/')
}

/** True when the given approval is a file-tool call with an absolute
 *  file_path that resolves outside the worktree. The card uses this to
 *  render a one-line explainer ("file is outside this worktree — only a
 *  broad grant can persist") so the user understands why narrow/medium
 *  options aren't on offer. Returns false when cwd is unknown. */
export function isFileToolCrossCwd(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined
): boolean {
  if (!cwd) return false
  if (!(FILE_TOOLS_INTERNAL as readonly string[]).includes(toolName)) return false
  const filePath = strField(input, 'file_path')
  if (!filePath) return false
  return !isPathInsideCwd(filePath, cwd)
}

function searchToolSuggestions(
  toolName: string,
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const pattern = strField(input, 'pattern')
  const out: PermissionPatternSuggestion[] = []
  if (pattern) {
    const exact: PermissionRule = { toolName, ruleContent: pattern }
    out.push({ rule: exact, label: formatLabel(exact), scope: 'narrow' })
  }
  out.push({ rule: { toolName }, label: toolName, scope: 'broad' })
  return out
}

function webFetchSuggestions(
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const url = strField(input, 'url')
  if (!url) {
    return [{ rule: { toolName: 'WebFetch' }, label: 'WebFetch', scope: 'broad' }]
  }
  const out: PermissionPatternSuggestion[] = []
  const exact: PermissionRule = { toolName: 'WebFetch', ruleContent: url }
  out.push({ rule: exact, label: formatLabel(exact), scope: 'narrow' })
  const host = extractHost(url)
  if (host) {
    const domain: PermissionRule = {
      toolName: 'WebFetch',
      ruleContent: `domain:${host}`
    }
    out.push({ rule: domain, label: formatLabel(domain), scope: 'medium' })
  }
  out.push({
    rule: { toolName: 'WebFetch' },
    label: 'WebFetch',
    scope: 'broad'
  })
  return out
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

export function suggestPermissionPatterns(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd?: string
): PermissionPatternSuggestion[] {
  if (!toolName) {
    return [{ rule: { toolName: '*' }, label: '* (any tool)', scope: 'broad' }]
  }
  if (toolName === 'Bash') return bashSuggestions(input)
  if (FILE_TOOLS.has(toolName)) return fileToolSuggestions(toolName, input, cwd)
  if (SEARCH_TOOLS.has(toolName)) return searchToolSuggestions(toolName, input)
  if (toolName === 'WebFetch') return webFetchSuggestions(input)
  // MCP tools and unknown tools: input shape varies, just allow the tool.
  return [{ rule: { toolName }, label: toolName, scope: 'narrow' }]
}
