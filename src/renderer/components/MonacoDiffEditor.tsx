import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { detectMonacoLanguage } from '../monaco-setup'

interface MonacoDiffEditorProps {
  original: string
  modified: string
  filePath?: string
  readOnly?: boolean
  fontFamily?: string
  fontSize?: number
  onModifiedChange?: (value: string) => void
  onSave?: () => void
  onReferenceLine?: (lineNumber: number) => void
  onEditorMount?: (editor: monaco.editor.IStandaloneDiffEditor) => void
  glyphClassName?: string
  glyphHoverMessage?: string
}

export function MonacoDiffEditor({
  original,
  modified,
  filePath,
  readOnly = true,
  fontFamily,
  fontSize,
  onModifiedChange,
  onSave,
  onReferenceLine,
  onEditorMount,
  glyphClassName = 'ref-line-glyph',
  glyphHoverMessage = 'Reference this line in Claude'
}: MonacoDiffEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const onChangeRef = useRef(onModifiedChange)
  const onSaveRef = useRef(onSave)
  const onRefRef = useRef(onReferenceLine)
  const onMountRef = useRef(onEditorMount)
  const glyphClassRef = useRef(glyphClassName)
  const glyphHoverRef = useRef(glyphHoverMessage)
  onChangeRef.current = onModifiedChange
  onSaveRef.current = onSave
  onRefRef.current = onReferenceLine
  onMountRef.current = onEditorMount
  glyphClassRef.current = glyphClassName
  glyphHoverRef.current = glyphHoverMessage

  useEffect(() => {
    if (!hostRef.current) return
    const language = detectMonacoLanguage(filePath)
    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)

    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      theme: 'harness',
      renderSideBySide: false,
      readOnly,
      originalEditable: false,
      automaticLayout: true,
      glyphMargin: true,
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13,
      minimap: { enabled: false },
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
        useShadows: false
      }
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    editorRef.current = editor

    onMountRef.current?.(editor)

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
    editorRef.current?.updateOptions({
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13
    })
  }, [fontFamily, fontSize])

  return <div ref={hostRef} className="h-full w-full" />
}
