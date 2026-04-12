import { Show, type Component, type JSX } from "solid-js"

import { useI18n } from "../../../../../lib/i18n"
import OverlayList from "./OverlayList"
import ProgressBar from "../../../../file-viewer/progress-bar"
import type { FileOperationState } from "../hooks/useFileOperations"

type SplitFilePanelList = {
  panel: () => JSX.Element
  overlay: () => JSX.Element
}

interface SplitFilePanelProps {
  header: JSX.Element
  list: SplitFilePanelList
  viewer: JSX.Element

  listOpen: boolean
  onToggleList: () => void

  splitWidth: number
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void

  isPhoneLayout: boolean
  overlayAriaLabel: string

  operationState?: FileOperationState
  onResetOperation?: () => void
}

const SplitFilePanel: Component<SplitFilePanelProps> = (props) => {
  const { t } = useI18n()
  return (
    <div class="files-tab-container">
      <div class="files-tab-header">
        <div class="files-tab-header-row">
          <button type="button" class="files-toggle-button" onClick={props.onToggleList}>
            {props.listOpen ? t("instanceShell.filesShell.hideFiles") : t("instanceShell.filesShell.showFiles")}
          </button>

          {props.header}
        </div>
      </div>

      <Show when={props.operationState?.inProgress}>
        <ProgressBar
          progress={props.operationState?.progress ?? 0}
          label={props.operationState?.label}
          onCancel={() => props.operationState?.cancel?.()}
          showClose={props.operationState?.isComplete ?? false}
          onClose={props.onResetOperation}
        />
      </Show>

      <div class="files-tab-body">
        <Show
          when={!props.isPhoneLayout && props.listOpen}
          fallback={props.viewer}
        >
          <div class="files-split" style={{ "--files-pane-width": `${props.splitWidth}px` }}>
            <div class="file-list-panel">
              <div class="file-list-scroll">{props.list.panel()}</div>
            </div>
            <div
              class="file-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file list"
              onMouseDown={props.onResizeMouseDown}
              onTouchStart={props.onResizeTouchStart}
            />
            <div class="file-viewer-cell">{props.viewer}</div>
          </div>
        </Show>

        <Show when={props.isPhoneLayout}>
          <Show when={props.listOpen}>
            <OverlayList ariaLabel={props.overlayAriaLabel}>{props.list.overlay()}</OverlayList>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default SplitFilePanel
