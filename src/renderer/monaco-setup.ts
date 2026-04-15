// Monaco worker registration. Imported once from main.tsx before any
// editor is constructed. Vite's ?worker suffix bundles each worker as a
// standalone chunk and returns a Worker constructor.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// Pull current Tailwind theme tokens from the document and build a Monaco
// theme that tracks them. Called once at boot and on theme changes.
function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function defineHarnessTheme(): void {
  const bg = readVar('--color-app', '#0b0d10')
  const panel = readVar('--color-panel', '#12151a')
  const fg = readVar('--color-fg', '#e6e6e6')
  const muted = readVar('--color-muted', '#b0b0b0')
  const faint = readVar('--color-faint', '#6b7280')
  const border = readVar('--color-border', '#1f242c')

  monaco.editor.defineTheme('harness', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: fg.replace('#', '') }
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': muted,
      'editorGutter.background': bg,
      'editor.lineHighlightBackground': panel,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': fg,
      'editorWhitespace.foreground': '#2a2f38',
      'editor.selectionBackground': '#3a4252',
      'editor.inactiveSelectionBackground': '#2a3040',
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': '#3a424d',
      'editorWidget.background': panel,
      'editorWidget.border': border,
      'scrollbarSlider.background': '#3a424d55',
      'scrollbarSlider.hoverBackground': '#4a5260aa',
      'scrollbarSlider.activeBackground': '#5a6270',
      'diffEditor.insertedTextBackground': '#1a5c2a22',
      'diffEditor.removedTextBackground': '#5c1a2a22',
      'diffEditor.insertedLineBackground': '#1a5c2a1a',
      'diffEditor.removedLineBackground': '#5c1a2a1a'
    }
  })
  monaco.editor.setTheme('harness')
}

// Map common file extensions to Monaco language ids. Monaco ships with
// grammars for all the common languages; we just need to pick the right
// id so syntax highlighting kicks in.
export function detectMonacoLanguage(filePath: string | undefined): string {
  if (!filePath) return 'plaintext'
  const name = filePath.split('/').pop() || ''
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const byName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    'cmakelists.txt': 'cmake'
  }
  if (byName[name.toLowerCase()]) return byName[name.toLowerCase()]
  const byExt: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', hh: 'cpp', cxx: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    sql: 'sql', xml: 'xml', svg: 'xml',
    php: 'php', swift: 'swift', kt: 'kotlin', dart: 'dart', lua: 'lua',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'dockerfile'
  }
  return byExt[ext] || 'plaintext'
}
