import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { detectMonacoLanguage } from '../monaco-setup'

interface MonacoEditorProps {
  value: string
  filePath?: string
  readOnly?: boolean
  fontFamily?: string
  fontSize?: number
  onChange?: (value: string) => void
  onSave?: () => void
  onReferenceLine?: (lineNumber: number) => void
}

export function MonacoEditor({
  value,
  filePath,
  readOnly = false,
  fontFamily,
  fontSize,
  onChange,
  onSave,
  onReferenceLine
}: MonacoEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onRefRef = useRef(onReferenceLine)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onRefRef.current = onReferenceLine

  // Construct the editor once and tear it down on unmount. Subsequent
  // prop updates are pushed imperatively so we don't recreate the model
  // (and lose undo history) on every render.
  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: detectMonacoLanguage(filePath),
      readOnly,
      theme: 'harness',
      fontFamily: fontFamily || undefined,
      fontSize: fontSize || 13,
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      tabSize: 2,
      fixedOverflowWidgets: true,
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false
      }
    })
    editorRef.current = editor

    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue())
    })

    // Cmd-S / Ctrl-S → onSave. Using addCommand lets Monaco own the
    // keybinding scope so it doesn't fire while focus is elsewhere.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.()
    })

    // Hover-tracked glyph-margin button for "reference line in Claude".
    const glyphCollection = editor.createDecorationsCollection()
    const setHoverLine = (lineNumber: number | null): void => {
      if (!onRefRef.current || lineNumber == null) {
        glyphCollection.clear()
        return
      }
      glyphCollection.set([
        {
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            glyphMarginClassName: 'ref-line-glyph',
            glyphMarginHoverMessage: { value: 'Reference this line in Claude' }
          }
        }
      ])
    }
    const moveSub = editor.onMouseMove((e) => {
      if (!onRefRef.current) return
      const ln = e.target.position?.lineNumber ?? null
      setHoverLine(ln)
    })
    const leaveSub = editor.onMouseLeave(() => setHoverLine(null))
    const downSub = editor.onMouseDown((e) => {
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
      editor.getModel()?.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync value when it changes externally (e.g. reload). Skip if the
  // editor already has the same content to avoid cursor resets.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      editor.setValue(value)
    }
  }, [value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, detectMonacoLanguage(filePath))
    }
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
