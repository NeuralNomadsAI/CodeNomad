import type { Component } from "solid-js"

import { AlignJustify, FoldVertical, Split, UnfoldVertical } from "lucide-solid"

import { useI18n } from "../../../../../lib/i18n"
import type { DiffContextMode, DiffViewMode } from "../types"

interface DiffToolbarProps {
  viewMode: DiffViewMode
  contextMode: DiffContextMode
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
}

const DiffToolbar: Component<DiffToolbarProps> = (props) => {
  const { t } = useI18n()
  const nextViewMode = (): DiffViewMode => (props.viewMode === "split" ? "unified" : "split")
  const nextContextMode = (): DiffContextMode => (props.contextMode === "collapsed" ? "expanded" : "collapsed")

  const viewModeTitle = () => (nextViewMode() === "split" ? t("instanceShell.diff.switchToSplit") : t("instanceShell.diff.switchToUnified"))
  const contextModeTitle = () =>
    nextContextMode() === "collapsed" ? t("instanceShell.diff.hideUnchanged") : t("instanceShell.diff.showFull")

  return (
    <div class="file-viewer-toolbar">
      <button
        type="button"
        class="file-viewer-toolbar-icon-button icon-toggle"
        onClick={() => props.onViewModeChange(nextViewMode())}
        aria-label={viewModeTitle()}
        data-active={props.viewMode === "split" ? "true" : undefined}
        title={viewModeTitle()}
      >
        {nextViewMode() === "split" ? <Split class="h-4 w-4" aria-hidden="true" /> : <AlignJustify class="h-4 w-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        class="file-viewer-toolbar-icon-button icon-toggle"
        onClick={() => props.onContextModeChange(nextContextMode())}
        aria-label={contextModeTitle()}
        data-active={props.contextMode === "expanded" ? "true" : undefined}
        title={contextModeTitle()}
      >
        {nextContextMode() === "collapsed" ? (
          <FoldVertical class="h-4 w-4" aria-hidden="true" />
        ) : (
          <UnfoldVertical class="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

export default DiffToolbar
