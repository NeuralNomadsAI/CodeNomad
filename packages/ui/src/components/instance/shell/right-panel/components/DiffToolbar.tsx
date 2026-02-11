import type { Component } from "solid-js"

import type { DiffContextMode, DiffViewMode } from "../types"

interface DiffToolbarProps {
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
}

const DiffToolbar: Component<DiffToolbarProps> = (props) => {
  return (
    <div class="file-viewer-toolbar">
      <button
        type="button"
        class={`file-viewer-toolbar-button${props.viewMode === "split" ? " active" : ""}`}
        aria-pressed={props.viewMode === "split"}
        onClick={() => props.onViewModeChange("split")}
      >
        Split
      </button>
      <button
        type="button"
        class={`file-viewer-toolbar-button${props.viewMode === "unified" ? " active" : ""}`}
        aria-pressed={props.viewMode === "unified"}
        onClick={() => props.onViewModeChange("unified")}
      >
        Unified
      </button>
      <button
        type="button"
        class={`file-viewer-toolbar-button${props.contextMode === "collapsed" ? " active" : ""}`}
        aria-pressed={props.contextMode === "collapsed"}
        onClick={() => props.onContextModeChange("collapsed")}
        title="Hide unchanged regions"
      >
        Collapsed
      </button>
      <button
        type="button"
        class={`file-viewer-toolbar-button${props.contextMode === "expanded" ? " active" : ""}`}
        aria-pressed={props.contextMode === "expanded"}
        onClick={() => props.onContextModeChange("expanded")}
        title="Show full file"
      >
        Expanded
      </button>
    </div>
  )
}

export default DiffToolbar
