import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { loadMonaco } from "../../lib/monaco/setup"
import { getOrCreateTextModel } from "../../lib/monaco/model-cache"
import { inferMonacoLanguageId } from "../../lib/monaco/language"
import { ensureMonacoLanguageLoaded } from "../../lib/monaco/setup"
import { useTheme } from "../../lib/theme"
import { parsePatchToBeforeAfter } from "../../lib/diff-utils"

interface MonacoDiffViewerProps {
  scopeKey: string
  path: string
  patch?: string
  before?: string
  after?: string
  viewMode?: "split" | "unified"
  contextMode?: "expanded" | "collapsed"
  wordWrap?: "on" | "off"
  compactUnifiedGutter?: boolean
  classicUnifiedGutter?: boolean
}

export function MonacoDiffViewer(props: MonacoDiffViewerProps) {
  const { isDark } = useTheme()
  let host: HTMLDivElement | undefined

  let diffEditor: any = null
  let monaco: any = null
  const [ready, setReady] = createSignal(false)

  const resolvedContent = createMemo(() => {
    if (props.patch !== undefined && props.patch !== null) {
      return parsePatchToBeforeAfter(props.patch)
    }
    return {
      before: props.before ?? "",
      after: props.after ?? "",
    }
  })

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
        wordWrap: props.wordWrap === "on" ? "on" : "off",
        glyphMargin: false,
        folding: false,
        // Keep enough gutter space so unified diffs don't overlap `+`/`-` markers.
        lineNumbersMinChars: 4,
        lineDecorationsWidth: 12,
        // Use legacy diff algorithm for better performance with large files
        // See: https://github.com/microsoft/vscode/issues/184037
        diffAlgorithm: "legacy",
        // Limit computation time to avoid freezing on large files
        maxComputationTime: 10000,
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
    if (!host) return
    host.dataset.compactUnifiedGutter = props.compactUnifiedGutter ? "true" : "false"
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const viewMode = props.viewMode === "unified" ? "unified" : "split"
    const contextMode = props.contextMode === "collapsed" ? "collapsed" : "expanded"
    const wordWrap = props.wordWrap === "on" ? "on" : "off"
    const compactUnifiedGutter = Boolean(props.compactUnifiedGutter) && viewMode === "unified"
    const classicUnifiedGutter = Boolean(props.classicUnifiedGutter) && viewMode === "unified"
    const lineNumbersMinChars = compactUnifiedGutter ? 3 : classicUnifiedGutter ? 4 : 4
    const lineDecorationsWidth = compactUnifiedGutter ? 9 : classicUnifiedGutter ? 12 : 12

    diffEditor.updateOptions({
      renderSideBySide: viewMode === "split",
      renderSideBySideInlineBreakpoint: 0,
      compactMode: compactUnifiedGutter,
      renderIndicators: true,
      lineNumbersMinChars,
      lineDecorationsWidth,
      hideUnchangedRegions:
        contextMode === "collapsed"
          ? { enabled: true }
          : { enabled: false },
      wordWrap,
      experimental: {
        useTrueInlineView: compactUnifiedGutter,
      },
    })

    try {
      diffEditor.getOriginalEditor?.()?.updateOptions?.({
        wordWrap,
        lineNumbersMinChars,
        lineDecorationsWidth,
      })
    } catch {
      // ignore
    }

    try {
      diffEditor.getModifiedEditor?.()?.updateOptions?.({
        wordWrap,
        lineNumbersMinChars,
        lineDecorationsWidth,
      })
    } catch {
      // ignore
    }
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const languageId = inferMonacoLanguageId(monaco, props.path)
    const { before, after } = resolvedContent()
    const beforeKey = `${props.scopeKey}:diff:${props.path}:before`
    const afterKey = `${props.scopeKey}:diff:${props.path}:after`

    const original = getOrCreateTextModel({ monaco, cacheKey: beforeKey, value: before, languageId })
    const modified = getOrCreateTextModel({ monaco, cacheKey: afterKey, value: after, languageId })
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
