import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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
  onRequestInsertContext?: (selection: { startLine: number; endLine: number }) => void
  insertContextLabel?: string
}

function getLineCount(value: string): number {
  if (!value) return 1
  return value.split("\n").length
}

function getDigitCount(value: number): number {
  return String(Math.max(1, value)).length
}

function getUnifiedGutterSizing(options: { before: string; after: string }) {
  const beforeLineCount = getLineCount(options.before)
  const afterLineCount = getLineCount(options.after)
  const beforeDigitCount = getDigitCount(beforeLineCount)
  const afterDigitCount = getDigitCount(afterLineCount)
  const maxDigitCount = Math.max(beforeDigitCount, afterDigitCount)
  const extraDigits = Math.max(0, maxDigitCount - 2)
  const beforeNumberChars = Math.max(2, beforeDigitCount)
  const afterNumberChars = Math.max(2, afterDigitCount)
  const fourDigitPenalty = Math.max(0, maxDigitCount - 3)

  return {
    diffEditorLineNumbersMinChars: Math.max(beforeNumberChars, afterNumberChars),
    originalLineNumbersMinChars: beforeNumberChars,
    modifiedLineNumbersMinChars: afterNumberChars,
    lineDecorationsWidth: 6 + extraDigits * 2 + fourDigitPenalty * 2,
  }
}

function getSplitGutterSizing(options: { before: string; after: string }) {
  const beforeLineCount = getLineCount(options.before)
  const afterLineCount = getLineCount(options.after)
  const beforeDigitCount = getDigitCount(beforeLineCount)
  const afterDigitCount = getDigitCount(afterLineCount)
  const maxDigitCount = Math.max(beforeDigitCount, afterDigitCount)
  const extraDigits = Math.max(0, maxDigitCount - 2)
  const beforeNumberChars = Math.max(2, beforeDigitCount)
  const afterNumberChars = Math.max(2, afterDigitCount)
  const fourDigitPenalty = Math.max(0, maxDigitCount - 3)

  return {
    diffEditorLineNumbersMinChars: Math.max(beforeNumberChars, afterNumberChars),
    originalLineNumbersMinChars: beforeNumberChars,
    modifiedLineNumbersMinChars: afterNumberChars,
    lineDecorationsWidth: 8 + extraDigits * 2 + fourDigitPenalty,
  }
}

export function MonacoDiffViewer(props: MonacoDiffViewerProps) {
  const { isDark } = useTheme()
  let host: HTMLDivElement | undefined

  let diffEditor: any = null
  let monaco: any = null
  let splitLayoutFrame: number | null = null
  const [ready, setReady] = createSignal(false)
  const [hoveredLine, setHoveredLine] = createSignal<number | null>(null)
  const [selectedRange, setSelectedRange] = createSignal<{ startLine: number; endLine: number } | null>(null)
  const [widgetHovered, setWidgetHovered] = createSignal(false)
  const [widgetPosition, setWidgetPosition] = createSignal<{ top: number; left: number } | null>(null)

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

  const clearSplitLayoutVariables = () => {
    if (!host) return
    host.style.removeProperty("--split-original-line-number-width")
    host.style.removeProperty("--split-original-delete-sign-left")
    host.style.removeProperty("--split-original-gutter-width")
  }

  const syncSplitLayoutVariables = (options: {
    viewMode: "split" | "unified"
    originalLineNumbersMinChars: number
    lineDecorationsWidth: number
  }) => {
    if (!host) return
    if (splitLayoutFrame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(splitLayoutFrame)
      splitLayoutFrame = null
    }
    if (options.viewMode !== "split" || typeof window === "undefined") {
      clearSplitLayoutVariables()
      return
    }

    splitLayoutFrame = window.requestAnimationFrame(() => {
      splitLayoutFrame = null
      if (!host) return
      const originalLineNumbers = host.querySelector<HTMLElement>(".editor.original .line-numbers")
      const measuredWidth = originalLineNumbers?.getBoundingClientRect().width ?? 0
      const lineNumberWidth =
        measuredWidth > 0 ? measuredWidth : Math.max(12, options.originalLineNumbersMinChars * 6)
      host.style.setProperty("--split-original-line-number-width", `${lineNumberWidth}px`)
      host.style.setProperty("--split-original-delete-sign-left", `${lineNumberWidth}px`)
      host.style.setProperty(
        "--split-original-gutter-width",
        `${lineNumberWidth + options.lineDecorationsWidth}px`,
      )
    })
  }

  const getModifiedEditor = () => diffEditor?.getModifiedEditor?.() ?? null

  const getActiveInsertRange = () => {
    const selection = selectedRange()
    if (selection) return selection
    if (widgetHovered() && hoveredLine()) {
      return { startLine: hoveredLine() as number, endLine: hoveredLine() as number }
    }
    const line = hoveredLine()
    if (!line) return null
    return { startLine: line, endLine: line }
  }

  const layoutInsertWidget = () => {
    const modifiedEditor = getModifiedEditor()
    const container = host
    if (!modifiedEditor || !container) return
    const activeRange = getActiveInsertRange()
    if (!activeRange) {
      setWidgetPosition(null)
      return
    }

    try {
      const modifiedDom = modifiedEditor.getDomNode?.() as HTMLElement | null
      if (!modifiedDom) {
        setWidgetPosition(null)
        return
      }

      const margin = modifiedDom.querySelector<HTMLElement>(".margin")
      const scrollable = modifiedDom.querySelector<HTMLElement>(".monaco-scrollable-element.editor-scrollable")
      const lineTop = modifiedEditor.getTopForLineNumber?.(activeRange.startLine) ?? 0
      const scrollTop = modifiedEditor.getScrollTop?.() ?? 0
      const lineHeight = Number(modifiedEditor.getOption?.(monaco.editor.EditorOption.lineHeight) ?? 18)
      const modifiedRect = modifiedDom.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const seamLeft = modifiedRect.left - containerRect.left + (margin?.offsetWidth ?? scrollable?.offsetLeft ?? 0)
      const centerTop = modifiedRect.top - containerRect.top + (lineTop - scrollTop) + lineHeight / 2

      setWidgetPosition({ top: centerTop, left: seamLeft })
    } catch {
      setWidgetPosition(null)
    }
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

      layoutInsertWidget()
    })()

    onCleanup(() => {
      cancelled = true
      if (splitLayoutFrame !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(splitLayoutFrame)
        splitLayoutFrame = null
      }
      clearSplitLayoutVariables()
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
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const modifiedEditor = diffEditor.getModifiedEditor?.()
    if (!modifiedEditor?.onDidChangeCursorSelection) return

    const disposable = modifiedEditor.onDidChangeCursorSelection((event: any) => {
      const selection = event?.selection
      if (!selection || selection.isEmpty?.()) {
        setSelectedRange(null)
        layoutInsertWidget()
        return
      }
      setSelectedRange({
        startLine: Math.min(selection.startLineNumber, selection.endLineNumber),
        endLine: Math.max(selection.startLineNumber, selection.endLineNumber),
      })
      layoutInsertWidget()
    })

    onCleanup(() => {
      try {
        disposable?.dispose?.()
      } catch {
        // ignore
      }
    })
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const modifiedEditor = getModifiedEditor()
    if (!modifiedEditor?.onMouseMove || !modifiedEditor?.onMouseLeave || !modifiedEditor?.onMouseDown) return

    const moveDisposable = modifiedEditor.onMouseMove((event: any) => {
      const lineNumber = event?.target?.position?.lineNumber
      setHoveredLine(typeof lineNumber === "number" ? lineNumber : null)
      layoutInsertWidget()
    })

    const leaveDisposable = modifiedEditor.onMouseLeave(() => {
      if (!widgetHovered()) {
        setHoveredLine(null)
      }
      layoutInsertWidget()
    })

    const scrollDisposable = modifiedEditor.onDidScrollChange?.(() => {
      layoutInsertWidget()
    })

    onCleanup(() => {
      try {
        moveDisposable?.dispose?.()
        leaveDisposable?.dispose?.()
        scrollDisposable?.dispose?.()
      } catch {
        // ignore
      }
    })
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const activeRange = getActiveInsertRange()
    if (!activeRange) setWidgetPosition(null)
    layoutInsertWidget()
  })

  createEffect(() => {
    if (!ready() || !monaco || !diffEditor) return
    const viewMode = props.viewMode === "unified" ? "unified" : "split"
    const contextMode = props.contextMode === "collapsed" ? "collapsed" : "expanded"
    const wordWrap = props.wordWrap === "on" ? "on" : "off"
    const { before, after } = resolvedContent()
    const sizing =
      viewMode === "unified"
        ? getUnifiedGutterSizing({ before, after })
        : getSplitGutterSizing({ before, after })
    const {
      diffEditorLineNumbersMinChars,
      originalLineNumbersMinChars,
      modifiedLineNumbersMinChars,
      lineDecorationsWidth,
    } = sizing
    diffEditor.updateOptions({
      renderSideBySide: viewMode === "split",
      renderSideBySideInlineBreakpoint: 0,
      renderIndicators: true,
      lineNumbersMinChars: diffEditorLineNumbersMinChars,
      lineDecorationsWidth,
      hideUnchangedRegions:
        contextMode === "collapsed"
          ? { enabled: true }
          : { enabled: false },
      wordWrap,
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

    syncSplitLayoutVariables({
      viewMode,
      originalLineNumbersMinChars,
      lineDecorationsWidth,
    })
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

  return (
    <div class="monaco-viewer" ref={host}>
      <div class="git-change-context-overlay">
        <Show when={widgetPosition()}>
          {(position: () => { top: number; left: number }) => (
            <div
              class="git-change-context-widget-host"
              style={{ top: `${position().top}px`, left: `${position().left}px` }}
              onMouseEnter={() => {
                setWidgetHovered(true)
                layoutInsertWidget()
              }}
              onMouseLeave={() => {
                setWidgetHovered(false)
                layoutInsertWidget()
              }}
            >
              <button
                type="button"
                class="git-change-context-widget"
                aria-label={props.insertContextLabel ?? "Add git change context to prompt"}
                title={props.insertContextLabel ?? "Add git change context to prompt"}
                onMouseDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const activeRange = getActiveInsertRange()
                  if (!activeRange) return
                  props.onRequestInsertContext?.(activeRange)
                }}
              >
                +
              </button>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
