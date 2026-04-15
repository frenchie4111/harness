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
}

export function MonacoDiffEditor({
  original,
  modified,
  filePath,
  readOnly = true,
  fontFamily,
  fontSize,
  onModifiedChange,
  onSave
}: MonacoDiffEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const onChangeRef = useRef(onModifiedChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onModifiedChange
  onSaveRef.current = onSave

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

    return () => {
      changeSub.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      editor.dispose()
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
