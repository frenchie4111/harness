// Monaco worker registration. Imported once from main.tsx before any
// editor is constructed. Vite's ?worker suffix bundles each worker as a
// standalone chunk and returns a Worker constructor.
import * as monaco from 'monaco-editor'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '../shared/state/settings'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import EditorWorkerUrl from 'monaco-editor/esm/vs/editor/editor.worker?worker&url'
import JsonWorkerUrl from 'monaco-editor/esm/vs/language/json/json.worker?worker&url'
import CssWorkerUrl from 'monaco-editor/esm/vs/language/css/css.worker?worker&url'
import HtmlWorkerUrl from 'monaco-editor/esm/vs/language/html/html.worker?worker&url'
import TsWorkerUrl from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker&url'

const workerUrlByLabel: Record<string, string> = {
  editor: EditorWorkerUrl,
  json: JsonWorkerUrl,
  css: CssWorkerUrl,
  scss: CssWorkerUrl,
  less: CssWorkerUrl,
  html: HtmlWorkerUrl,
  handlebars: HtmlWorkerUrl,
  razor: HtmlWorkerUrl,
  typescript: TsWorkerUrl,
  javascript: TsWorkerUrl
}

// If a Monaco worker fails to construct, Monaco falls back to loading
// the worker source inline on the main thread. That fallback ALSO fails
// because the worker chunk is ESM and the inline-parse hits `export`,
// at which point Monaco's worker subsystem is poisoned for the entire
// renderer session — every diff editor renders without highlighting
// until full reload. We can't fix that here; we just capture enough
// detail to root-cause it and emit a window event so the UI can offer
// a one-click reload.
function safeCreateWorker(label: string, factory: () => Worker): Worker {
  try {
    const worker = factory()
    worker.addEventListener('error', (ev) => {
      const detail = {
        label,
        phase: 'runtime',
        message: ev.message,
        filename: (ev as ErrorEvent).filename,
        lineno: (ev as ErrorEvent).lineno,
        workerUrl: workerUrlByLabel[label]
      }
      // eslint-disable-next-line no-console
      console.error(`[monaco] worker '${label}' runtime error`, detail)
      window.dispatchEvent(new CustomEvent('monaco:worker-failed', { detail }))
    })
    return worker
  } catch (err) {
    const detail = {
      label,
      phase: 'construct',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      userAgent: navigator.userAgent,
      workerUrl: workerUrlByLabel[label]
    }
    // eslint-disable-next-line no-console
    console.error(`[monaco] worker '${label}' construction failed`, detail)
    window.dispatchEvent(new CustomEvent('monaco:worker-failed', { detail }))
    throw err
  }
}

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return safeCreateWorker('json', () => new JsonWorker())
    if (label === 'css' || label === 'scss' || label === 'less')
      return safeCreateWorker(label, () => new CssWorker())
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return safeCreateWorker(label, () => new HtmlWorker())
    if (label === 'typescript' || label === 'javascript')
      return safeCreateWorker(label, () => new TsWorker())
    return safeCreateWorker('editor', () => new EditorWorker())
  }
}

// Configure the TS/JS language defaults so JSX parses correctly and we
// don't get semantic noise from unresolved imports (no project-wide type
// graph — Monaco only sees one file at a time).
function configureTypescriptDefaults(): void {
  // The runtime API for the TypeScript language service lives at
  // monaco.languages.typescript. Recent @types mark it as `{deprecated: true}`
  // and don't expose its members through the type system, so we cast to any.
  // DO NOT switch this to `monaco.typescript` — that path is undefined at
  // runtime and throws during module evaluation, silently breaking every
  // Monaco editor's syntax highlighting + theme.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts: any = (monaco as any).languages.typescript
  const tsOptions = {
    ...ts.typescriptDefaults.getCompilerOptions(),
    jsx: ts.JsxEmit.Preserve,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: true
  }
  ts.typescriptDefaults.setCompilerOptions(tsOptions)
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
  })
  ts.javascriptDefaults.setCompilerOptions({
    ...ts.javascriptDefaults.getCompilerOptions(),
    jsx: ts.JsxEmit.Preserve,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowNonTsExtensions: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: true
  })
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false
  })
}

configureTypescriptDefaults()

// Pull current Tailwind theme tokens from a source element and build a Monaco
// theme that tracks them. Called once at boot and on theme changes.
function readVar(source: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(source).getPropertyValue(name).trim()
  return v || fallback
}

/** Resolve a CSS color (hex/oklch/named/var) to its luminance and decide if
 *  it reads as dark — used to pick Monaco's vs vs vs-dark base. */
function isColorDark(color: string): boolean {
  const probe = document.createElement('span')
  probe.style.color = color
  probe.style.display = 'none'
  document.documentElement.appendChild(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  const m = rgb.match(/\d+(\.\d+)?/g)
  if (!m || m.length < 3) return true
  const [r, g, b] = m.map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

// Review-diff appearance override. 'match' (default) tracks the app theme by
// reading `:root`; 'light'/'dark' pin the editors to the configured light/dark
// palette so the diffs can differ from the app chrome. Monaco's theme is
// global, so this redefines the single 'harness' theme — every Monaco surface
// (diff + file viewers) follows it, while the non-Monaco chrome/terminals
// keep the app theme.
let reviewDiffMode: 'match' | 'light' | 'dark' = 'match'
let lightThemeId = DEFAULT_LIGHT_THEME
let darkThemeId = DEFAULT_DARK_THEME

export function setReviewDiffMode(
  mode: 'match' | 'light' | 'dark',
  lightId: string,
  darkId: string
): void {
  reviewDiffMode = mode
  lightThemeId = lightId
  darkThemeId = darkId
  defineHarnessTheme()
}

// Resolve the element whose `--color-*` vars the Monaco theme reads. For
// 'match' that's the live document root; for an override we mount a hidden
// probe carrying the target theme's `[data-theme]` attribute — built-in
// palettes are plain attribute-selector rules, so the probe gets the full
// palette regardless of what the document root currently is.
function withThemeSource<T>(use: (source: HTMLElement) => T): T {
  if (reviewDiffMode === 'match') return use(document.documentElement)
  const probe = document.createElement('div')
  probe.dataset.theme = reviewDiffMode === 'light' ? lightThemeId : darkThemeId
  probe.style.display = 'none'
  document.documentElement.appendChild(probe)
  try {
    return use(probe)
  } finally {
    probe.remove()
  }
}

export function defineHarnessTheme(): void {
  withThemeSource(defineHarnessThemeFromSource)
}

function defineHarnessThemeFromSource(source: HTMLElement): void {
  const bg = readVar(source, '--color-app', '#0b0d10')
  const panel = readVar(source, '--color-panel', '#12151a')
  const fg = readVar(source, '--color-fg', '#e6e6e6')
  const muted = readVar(source, '--color-muted', '#b0b0b0')
  const faint = readVar(source, '--color-faint', '#6b7280')
  const border = readVar(source, '--color-border', '#1f242c')
  const dark = isColorDark(bg)

  monaco.editor.defineTheme('harness', {
    base: dark ? 'vs-dark' : 'vs',
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

// Re-derive the Monaco theme whenever the app theme changes. theme-apply
// mutates `data-theme` and inline custom-property styles on :root, so watch
// both — same signal XTerminal re-themes on. Without this, open diff/file
// editors keep their boot-time colors across a light/dark switch.
let themeObserver: MutationObserver | null = null
export function watchHarnessTheme(): void {
  if (themeObserver) return
  themeObserver = new MutationObserver(() => defineHarnessTheme())
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class']
  })
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
