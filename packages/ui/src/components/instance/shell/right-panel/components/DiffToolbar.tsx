import type { Component } from "solid-js"

import { AlignJustify, FoldVertical, Split, UnfoldVertical, WrapText } from "lucide-solid"

import type { DiffContextMode, DiffViewMode, DiffWordWrapMode } from "../types"

interface DiffToolbarProps {
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  wordWrapMode: DiffWordWrapMode
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
  onWordWrapModeChange: (mode: DiffWordWrapMode) => void
}

const DiffToolbar: Component<DiffToolbarProps> = (props) => {
  const nextViewMode = (): DiffViewMode => (props.viewMode === "split" ? "unified" : "split")
  const nextContextMode = (): DiffContextMode => (props.contextMode === "collapsed" ? "expanded" : "collapsed")
  const nextWordWrapMode = (): DiffWordWrapMode => (props.wordWrapMode === "on" ? "off" : "on")

  const viewModeTitle = () => (nextViewMode() === "split" ? "Switch to split view" : "Switch to unified view")
  const contextModeTitle = () =>
    nextContextMode() === "collapsed" ? "Hide unchanged regions" : "Show full file"
  const wordWrapTitle = () => (nextWordWrapMode() === "on" ? "Enable word wrap" : "Disable word wrap")

  return (
    <div class="file-viewer-toolbar">
      <button
        type="button"
        class="file-viewer-toolbar-icon-button"
        onClick={() => props.onViewModeChange(nextViewMode())}
        aria-label={viewModeTitle()}
        title={viewModeTitle()}
      >
        {nextViewMode() === "split" ? <Split class="h-4 w-4" aria-hidden="true" /> : <AlignJustify class="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        class="file-viewer-toolbar-icon-button"
        onClick={() => props.onContextModeChange(nextContextMode())}
        aria-label={contextModeTitle()}
        title={contextModeTitle()}
      >
        {nextContextMode() === "collapsed" ? (
          <FoldVertical class="h-4 w-4" aria-hidden="true" />
        ) : (
          <UnfoldVertical class="h-4 w-4" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        class={`file-viewer-toolbar-icon-button${props.wordWrapMode === "on" ? " active" : ""}`}
        onClick={() => props.onWordWrapModeChange(nextWordWrapMode())}
        aria-label={wordWrapTitle()}
        title={wordWrapTitle()}
      >
        <WrapText class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}

export default DiffToolbar
