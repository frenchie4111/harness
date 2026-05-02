// Pure suggestion generator for the "Always allow" picker on the
// json-mode approval card. The MCP --permission-prompt-tool path
// doesn't carry Claude's own permission_suggestions, so we synthesize
// a small list ourselves from the tool name + raw input. The picker
// is responsible for letting the user choose; this module is just the
// table of options.
//
// Heuristics (narrow → broad):
//   Bash      → Bash(<head> <arg1>:*) / Bash(<head>:*) / Bash(*)
//   Read,Write,Edit,MultiEdit → <Tool>(<file>) / <Tool>(<dir>/**) / <Tool>(*)
//   Grep,Glob → <Tool>(<pattern>) / <Tool>(*)
//   WebFetch  → WebFetch(<url>) / WebFetch(domain:<host>) / WebFetch(*)
//   mcp__*    → bare tool name (input shapes vary too much to glob)
//   default   → bare tool name

export interface PermissionPatternSuggestion {
  rule: string
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

function bashSuggestions(
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const command = strField(input, 'command')
  if (!command) {
    return [{ rule: 'Bash(*)', label: 'Bash(*)', scope: 'broad' }]
  }
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const head = tokens[0]
  const arg1 = tokens[1]
  const out: PermissionPatternSuggestion[] = []
  if (head && arg1) {
    out.push({
      rule: `Bash(${head} ${arg1}:*)`,
      label: `Bash(${head} ${arg1}:*)`,
      scope: 'narrow'
    })
  }
  if (head) {
    out.push({
      rule: `Bash(${head}:*)`,
      label: `Bash(${head}:*)`,
      scope: 'medium'
    })
  }
  out.push({ rule: 'Bash(*)', label: 'Bash(*)', scope: 'broad' })
  return out
}

function fileToolSuggestions(
  toolName: string,
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const filePath = strField(input, 'file_path')
  if (!filePath) {
    return [
      { rule: toolName, label: toolName, scope: 'narrow' },
      { rule: `${toolName}(*)`, label: `${toolName}(*)`, scope: 'broad' }
    ]
  }
  const out: PermissionPatternSuggestion[] = [
    {
      rule: `${toolName}(${filePath})`,
      label: `${toolName}(${filePath})`,
      scope: 'narrow'
    }
  ]
  const dir = parentDir(filePath)
  if (dir) {
    out.push({
      rule: `${toolName}(${dir}/**)`,
      label: `${toolName}(${dir}/**)`,
      scope: 'medium'
    })
  }
  out.push({
    rule: `${toolName}(*)`,
    label: `${toolName}(*)`,
    scope: 'broad'
  })
  return out
}

function searchToolSuggestions(
  toolName: string,
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const pattern = strField(input, 'pattern')
  const out: PermissionPatternSuggestion[] = []
  if (pattern) {
    out.push({
      rule: `${toolName}(${pattern})`,
      label: `${toolName}(${pattern})`,
      scope: 'narrow'
    })
  }
  out.push({
    rule: `${toolName}(*)`,
    label: `${toolName}(*)`,
    scope: 'broad'
  })
  return out
}

function webFetchSuggestions(
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  const url = strField(input, 'url')
  if (!url) {
    return [{ rule: 'WebFetch(*)', label: 'WebFetch(*)', scope: 'broad' }]
  }
  const out: PermissionPatternSuggestion[] = [
    {
      rule: `WebFetch(${url})`,
      label: `WebFetch(${url})`,
      scope: 'narrow'
    }
  ]
  const host = extractHost(url)
  if (host) {
    out.push({
      rule: `WebFetch(domain:${host})`,
      label: `WebFetch(domain:${host})`,
      scope: 'medium'
    })
  }
  out.push({ rule: 'WebFetch(*)', label: 'WebFetch(*)', scope: 'broad' })
  return out
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

export function suggestPermissionPatterns(
  toolName: string,
  input: Record<string, unknown> | undefined
): PermissionPatternSuggestion[] {
  if (!toolName) {
    return [{ rule: '*', label: '* (any tool)', scope: 'broad' }]
  }
  if (toolName === 'Bash') return bashSuggestions(input)
  if (FILE_TOOLS.has(toolName)) return fileToolSuggestions(toolName, input)
  if (SEARCH_TOOLS.has(toolName)) return searchToolSuggestions(toolName, input)
  if (toolName === 'WebFetch') return webFetchSuggestions(input)
  if (toolName.startsWith('mcp__')) {
    return [{ rule: toolName, label: toolName, scope: 'narrow' }]
  }
  return [{ rule: toolName, label: toolName, scope: 'narrow' }]
}
