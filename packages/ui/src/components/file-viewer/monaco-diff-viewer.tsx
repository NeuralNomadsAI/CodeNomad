import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { loadMonaco } from "../../lib/monaco/setup"
import { getOrCreateTextModel } from "../../lib/monaco/model-cache"
import { inferMonacoLanguageId } from "../../lib/monaco/language"
import { ensureMonacoLanguageLoaded } from "../../lib/monaco/setup"
import { useTheme } from "../../lib/theme"

interface MonacoDiffViewerProps {
  scopeKey: string
  path: string
  before: string
  after: string
  viewMode?: "split" | "unified"
  contextMode?: "expanded" | "collapsed"
}

export function MonacoDiffViewer(props: MonacoDiffViewerProps) {
  const { isDark } = useTheme()
  let host: HTMLDivElement | undefined

  let diffEditor: any = null
  let monaco: any = null
  const [ready, setReady] = createSignal(false)

  const disposeEditor = () => {
    try {
      diffEditor?.setModel(null as any)
    } catch {
      // ignore
    }
    try {
      diffEditor?.dispose()
    } catch {
      // ignore
    }
    diffEditor = null
  }

  onMount(() => {
    let cancelled = false
    void (async () => {
      monaco = await loadMonaco()
      if (cancelled) return
      if (!host || !monaco) return

      monaco.editor.setTheme(isDark() ? "vs-dark" : "vs")
      diffEditor = monaco.editor.createDiffEditor(host, {
        readOnly: true,
        automaticLayout: true,
        renderSideBySide: true,
        renderSideBySideInlineBreakpoint: 0,
        renderMarginRevertIcon: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: "selection",
        fontSize: 13,
        wordWrap: "off",
        glyphMargin: false,
        folding: false,
        // Keep enough gutter space so unified diffs don't overlap `+`/`-` markers.
        lineNumbersMinChars: 4,
        lineDecorationsWidth: 12,
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
    if (!ready() || !monaco || !diffEditor) return
    monaco.editor.setTheme(isDark() ? "vs-dark" : "vs")
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const viewMode = props.viewMode === "unified" ? "unified" : "split"
    const contextMode = props.contextMode === "collapsed" ? "collapsed" : "expanded"

    diffEditor.updateOptions({
      renderSideBySide: viewMode === "split",
      renderSideBySideInlineBreakpoint: 0,
      hideUnchangedRegions:
        contextMode === "collapsed"
          ? { enabled: true }
          : { enabled: false },
    })
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const languageId = inferMonacoLanguageId(monaco, props.path)
    const beforeKey = `${props.scopeKey}:diff:${props.path}:before`
    const afterKey = `${props.scopeKey}:diff:${props.path}:after`

    const original = getOrCreateTextModel({ monaco, cacheKey: beforeKey, value: props.before, languageId })
    const modified = getOrCreateTextModel({ monaco, cacheKey: afterKey, value: props.after, languageId })
    diffEditor.setModel({ original, modified })

    void ensureMonacoLanguageLoaded(languageId).then(() => {
      try {
        monaco.editor.setModelLanguage(original, languageId)
        monaco.editor.setModelLanguage(modified, languageId)
      } catch {
        // ignore
      }
    })
  })

  return <div class="monaco-viewer" ref={host} />
}
