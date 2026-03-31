import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { loadMonaco } from "../../lib/monaco/setup"
import { getOrCreateTextModel } from "../../lib/monaco/model-cache"
import { inferMonacoLanguageId } from "../../lib/monaco/language"
import { ensureMonacoLanguageLoaded } from "../../lib/monaco/setup"
import { useTheme } from "../../lib/theme"

interface MonacoFileViewerProps {
  scopeKey: string
  path: string
  content: string
  onSave?: (content: string) => void
  onContentChange?: (content: string) => void
}

export function MonacoFileViewer(props: MonacoFileViewerProps) {
  const { isDark } = useTheme()
  let host: HTMLDivElement | undefined

  let editor: any = null
  let monaco: any = null
  const [ready, setReady] = createSignal(false)

  const disposeEditor = () => {
    try {
      editor?.setModel(null)
    } catch {
      // ignore
    }
    try {
      editor?.dispose()
    } catch {
      // ignore
    }
    editor = null
  }

  const saveContent = () => {
    if (!editor || !props.onSave) return
    props.onSave(editor.getValue())
  }

  onMount(() => {
    let cancelled = false
    void (async () => {
      monaco = await loadMonaco()
      if (cancelled) return
      if (!host || !monaco) return

      monaco.editor.setTheme(isDark() ? "vs-dark" : "vs")
      editor = monaco.editor.create(host, {
        value: "",
        language: "plaintext",
        readOnly: false,
        automaticLayout: true,
        lineNumbers: "on",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        renderWhitespace: "selection",
        fontSize: 13,
      })

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveContent)

      editor.onDidChangeModelContent(() => {
        if (props.onContentChange) {
          props.onContentChange(editor.getValue())
        }
      })

      setReady(true)
    })()

    onCleanup(() => {
      cancelled = true
      setReady(false)
      disposeEditor()
    })
  })

  createEffect(() => {
    if (!ready() || !monaco || !editor) return
    monaco.editor.setTheme(isDark() ? "vs-dark" : "vs")
  })

  createEffect(() => {
    if (!ready() || !monaco || !editor) return
    const languageId = inferMonacoLanguageId(monaco, props.path)
    const cacheKey = `${props.scopeKey}:file:${props.path}`
    const model = getOrCreateTextModel({ monaco, cacheKey, value: props.content, languageId })
    editor.setModel(model)

    void ensureMonacoLanguageLoaded(languageId).then(() => {
      try {
        monaco.editor.setModelLanguage(model, languageId)
      } catch {
        // ignore
      }
    })
  })

  return <div class="monaco-viewer" ref={host} />
}
