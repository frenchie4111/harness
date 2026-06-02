import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { detectMonacoLanguage } from '../monaco-setup'

interface MonacoDiffEditorProps {
  original: string
  modified: string
  filePath?: string
  readOnly?: boolean
  /** Side-by-side (true) vs inline/unified (false, default) rendering. */
  renderSideBySide?: boolean
  /** Hide whitespace-only changes (Monaco default true). Set false to
   *  surface trailing/leading whitespace diffs. */
  ignoreTrimWhitespace?: boolean
  fontFamily?: string
  fontSize?: number
  wordWrap?: boolean
  onModifiedChange?: (value: string) => void
  onSave?: () => void
  onReferenceLine?: (lineNumber: number) => void
  onEditorMount?: (editor: monaco.editor.IStandaloneDiffEditor) => void
  glyphClassName?: string
  glyphHoverMessage?: string
  /** When set, the editor grows to fit its content (no internal vertical
   *  scroll) and reports its content height via onContentHeight, so it can be
   *  embedded in an outer scroll container (the stacked all-files review). */
  autoHeight?: boolean
  onContentHeight?: (height: number) => void
}

export function MonacoDiffEditor({
  original,
  modified,
  filePath,
  readOnly = true,
  renderSideBySide = false,
  ignoreTrimWhitespace = true,
  fontFamily,
  fontSize,
  wordWrap = false,
  onModifiedChange,
  onSave,
  onReferenceLine,
  onEditorMount,
  glyphClassName = 'ref-line-glyph',
  glyphHoverMessage = 'Reference this line in Claude',
  autoHeight = false,
  onContentHeight
}: MonacoDiffEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const onChangeRef = useRef(onModifiedChange)
  const onSaveRef = useRef(onSave)
  const onRefRef = useRef(onReferenceLine)
  const onMountRef = useRef(onEditorMount)
  const glyphClassRef = useRef(glyphClassName)
  const glyphHoverRef = useRef(glyphHoverMessage)
  const onContentHeightRef = useRef(onContentHeight)
  const renderSideBySideRef = useRef(renderSideBySide)
  onChangeRef.current = onModifiedChange
  onSaveRef.current = onSave
  onRefRef.current = onReferenceLine
  onMountRef.current = onEditorMount
  glyphClassRef.current = glyphClassName
  glyphHoverRef.current = glyphHoverMessage
  onContentHeightRef.current = onContentHeight
  renderSideBySideRef.current = renderSideBySide

  useEffect(() => {
    if (!hostRef.current) return
    const language = detectMonacoLanguage(filePath)
    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)

    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      theme: 'harness',
      renderSideBySide,
      // Without this, Monaco silently falls back to the inline view when the
      // editor is narrower than renderSideBySideInlineBreakpoint (~900px) —
      // so "Split" looks identical to "Unified" in a narrow pane. Force it
      // to honor renderSideBySide at any width.
      useInlineViewWhenSpaceIsLimited: false,
      ignoreTrimWhitespace,
      readOnly,
      originalEditable: false,
      automaticLayout: true,
      glyphMargin: true,
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: false },
      // No minimap and no diff overview ruler (the colored change-strip on
      // the right edge) — keeps the stacked review clean.
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      fixedOverflowWidgets: true,
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 3,
        minimumLineCount: 3,
        revealLineCount: 20
      },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
        // Auto-height mode: the editor grows to exactly its content height and
        // the OUTER container scrolls. Hide the inner vertical scrollbar, but
        // keep mouse-wheel handling ON — with no vertical scroll room and
        // alwaysConsumeMouseWheel off, vertical wheel bubbles up to the stacked
        // container while HORIZONTAL wheel still scrolls long lines here.
        ...(autoHeight
          ? { vertical: 'hidden' as const, alwaysConsumeMouseWheel: false }
          : {})
      }
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    editorRef.current = editor

    onMountRef.current?.(editor)

    // Auto-height: report the diff's content height (the taller side in
    // side-by-side, else the modified editor — which in inline mode already
    // includes deleted-line and comment view zones) so the host can size to
    // fit and the outer container owns the scroll.
    let heightSubs: monaco.IDisposable[] = []
    let revealTimer = 0
    if (autoHeight) {
      // Mount hidden and fade in once the diff has actually computed —
      // otherwise the fresh editor briefly paints the full modified text
      // un-tokenized and before hideUnchangedRegions collapses it, a visible
      // flash on (re)expand. Set synchronously so the first paint is hidden.
      const host = hostRef.current
      if (host) {
        host.style.opacity = '0'
        host.style.transition = 'opacity 100ms ease'
      }
      let revealed = false
      const reveal = (): void => {
        if (revealed) return
        revealed = true
        // One more frame so tokenization for the visible range lands too.
        requestAnimationFrame(() => {
          if (hostRef.current) hostRef.current.style.opacity = '1'
        })
      }
      const reportHeight = (): void => {
        const mod = editor.getModifiedEditor()
        const orig = editor.getOriginalEditor()
        const h = renderSideBySideRef.current
          ? Math.max(orig.getContentHeight(), mod.getContentHeight())
          : mod.getContentHeight()
        onContentHeightRef.current?.(h)
      }
      heightSubs = [
        editor.getModifiedEditor().onDidContentSizeChange(reportHeight),
        editor.getOriginalEditor().onDidContentSizeChange(reportHeight),
        editor.onDidUpdateDiff(() => {
          reportHeight()
          reveal()
        })
      ]
      reportHeight()
      // Fallback: reveal even if onDidUpdateDiff never fires (identical
      // content, error, binary) so the editor can't get stuck invisible.
      revealTimer = window.setTimeout(reveal, 300)
    }

    const changeSub = editor
      .getModifiedEditor()
      .onDidChangeModelContent(() => {
        onChangeRef.current?.(editor.getModifiedEditor().getValue())
      })

    editor.getModifiedEditor().addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSaveRef.current?.()
      }
    )

    // Hover-tracked glyph-margin button for "reference line in Claude".
    // Inline diff means both sides flow through the modified editor's DOM;
    // we hook onto it for hover/click.
    const modifiedEd = editor.getModifiedEditor()
    const glyphCollection = modifiedEd.createDecorationsCollection()
    const setHoverLine = (lineNumber: number | null): void => {
      if (!onRefRef.current || lineNumber == null) {
        glyphCollection.clear()
        return
      }
      glyphCollection.set([
        {
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            glyphMarginClassName: glyphClassRef.current,
            glyphMarginHoverMessage: { value: glyphHoverRef.current }
          }
        }
      ])
    }
    const moveSub = modifiedEd.onMouseMove((e) => {
      if (!onRefRef.current) return
      setHoverLine(e.target.position?.lineNumber ?? null)
    })
    const leaveSub = modifiedEd.onMouseLeave(() => setHoverLine(null))
    const downSub = modifiedEd.onMouseDown((e) => {
      if (!onRefRef.current) return
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const ln = e.target.position?.lineNumber
      if (ln != null) onRefRef.current(ln)
    })

    return () => {
      changeSub.dispose()
      moveSub.dispose()
      leaveSub.dispose()
      downSub.dispose()
      for (const s of heightSubs) s.dispose()
      if (revealTimer) clearTimeout(revealTimer)
      glyphCollection.clear()
      // Dispose the editor before the models it holds. Disposing models
      // first fires "TextModel got disposed before DiffEditorWidget model
      // got reset" from Monaco's internal listeners and poisons the React
      // tree so subsequent diff tabs silently fail to render.
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync value changes externally. For v1 read-only we rebuild models if
  // either side changes because there's no cursor to worry about.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    if (model.original.getValue() !== original) {
      model.original.setValue(original)
    }
    if (model.modified.getValue() !== modified) {
      model.modified.setValue(modified)
    }
  }, [original, modified])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const language = detectMonacoLanguage(filePath)
    monaco.editor.setModelLanguage(model.original, language)
    monaco.editor.setModelLanguage(model.modified, language)
  }, [filePath])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide })
  }, [renderSideBySide])

  useEffect(() => {
    editorRef.current?.updateOptions({ ignoreTrimWhitespace })
  }, [ignoreTrimWhitespace])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13
    })
  }, [fontFamily, fontSize])

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  return <div ref={hostRef} className="h-full w-full" />
}
