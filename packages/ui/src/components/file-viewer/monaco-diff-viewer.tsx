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
  unifiedGutterStyle?: "compact" | "classic"
}

function getLineCount(value: string): number {
  if (!value) return 1
  return value.split("\n").length
}

function getDigitCount(value: number): number {
  return String(Math.max(1, value)).length
}

function getUnifiedGutterSizing(options: {
  unifiedGutterStyle: "compact" | "classic" | null
  before: string
  after: string
}) {
  const beforeLineCount = getLineCount(options.before)
  const afterLineCount = getLineCount(options.after)
  const beforeDigitCount = getDigitCount(beforeLineCount)
  const afterDigitCount = getDigitCount(afterLineCount)
  const maxDigitCount = Math.max(beforeDigitCount, afterDigitCount)
  const extraDigits = Math.max(0, maxDigitCount - 2)
  // Reserve one extra character so the number lane keeps a visible gap before
  // the +/- indicator lane once the line numbers grow beyond trivial widths.
  const beforeNumberChars = Math.max(2, beforeDigitCount + 1)
  const afterNumberChars = Math.max(2, afterDigitCount + 1)
  const fourDigitPenalty = Math.max(0, maxDigitCount - 3)

  if (options.unifiedGutterStyle === "compact") {
    const sharedNumberChars = Math.max(beforeNumberChars, afterNumberChars)
    return {
      diffEditorLineNumbersMinChars: sharedNumberChars,
      originalLineNumbersMinChars: sharedNumberChars,
      modifiedLineNumbersMinChars: sharedNumberChars,
      lineDecorationsWidth: 8 + extraDigits * 4 + fourDigitPenalty * 2,
    }
  }

  if (options.unifiedGutterStyle === "classic") {
    return {
      diffEditorLineNumbersMinChars: Math.max(beforeNumberChars, afterNumberChars),
      originalLineNumbersMinChars: beforeNumberChars,
      modifiedLineNumbersMinChars: afterNumberChars,
      lineDecorationsWidth: 10 + extraDigits * 4 + fourDigitPenalty * 4,
    }
  }

  return {
    diffEditorLineNumbersMinChars: 4,
    originalLineNumbersMinChars: 4,
    modifiedLineNumbersMinChars: 4,
    lineDecorationsWidth: 12,
  }
}

function getSplitGutterSizing(options: { before: string; after: string }) {
  const beforeLineCount = getLineCount(options.before)
  const afterLineCount = getLineCount(options.after)
  const beforeDigitCount = getDigitCount(beforeLineCount)
  const afterDigitCount = getDigitCount(afterLineCount)
  const maxDigitCount = Math.max(beforeDigitCount, afterDigitCount)
  const extraDigits = Math.max(0, maxDigitCount - 2)
  const beforeNumberChars = Math.max(2, beforeDigitCount + 1)
  const afterNumberChars = Math.max(2, afterDigitCount + 1)
  const fourDigitPenalty = Math.max(0, maxDigitCount - 3)

  return {
    diffEditorLineNumbersMinChars: Math.max(beforeNumberChars, afterNumberChars),
    originalLineNumbersMinChars: beforeNumberChars,
    modifiedLineNumbersMinChars: afterNumberChars,
    lineDecorationsWidth: 10 + extraDigits * 2 + fourDigitPenalty * 2,
  }
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
    host.dataset.viewMode = props.viewMode === "split" ? "split" : "unified"
    host.dataset.unifiedGutterStyle = props.unifiedGutterStyle ?? ""
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const viewMode = props.viewMode === "unified" ? "unified" : "split"
    const contextMode = props.contextMode === "collapsed" ? "collapsed" : "expanded"
    const wordWrap = props.wordWrap === "on" ? "on" : "off"
    const unifiedGutterStyle = viewMode === "unified" ? props.unifiedGutterStyle ?? null : null
    const { before, after } = resolvedContent()
    const sizing =
      viewMode === "unified"
        ? getUnifiedGutterSizing({
            unifiedGutterStyle,
            before,
            after,
          })
        : getSplitGutterSizing({ before, after })
    const {
      diffEditorLineNumbersMinChars,
      originalLineNumbersMinChars,
      modifiedLineNumbersMinChars,
      lineDecorationsWidth,
    } = sizing
    const compactUnifiedGutter = unifiedGutterStyle === "compact"

    diffEditor.updateOptions({
      renderSideBySide: viewMode === "split",
      renderSideBySideInlineBreakpoint: 0,
      compactMode: compactUnifiedGutter,
      renderIndicators: true,
      lineNumbersMinChars: diffEditorLineNumbersMinChars,
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
        lineNumbersMinChars: originalLineNumbersMinChars,
        lineDecorationsWidth,
      })
    } catch {
      // ignore
    }

    try {
      diffEditor.getModifiedEditor?.()?.updateOptions?.({
        wordWrap,
        lineNumbersMinChars: modifiedLineNumbersMinChars,
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
