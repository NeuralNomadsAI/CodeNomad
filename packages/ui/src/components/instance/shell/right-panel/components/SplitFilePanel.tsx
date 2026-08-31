import { Show, type Component, type JSX } from "solid-js"

import { useI18n } from "../../../../../lib/i18n"
import OverlayList from "./OverlayList"

type SplitFilePanelList = {
  panel: () => JSX.Element
  overlay: () => JSX.Element
}

interface SplitFilePanelProps {
  header: JSX.Element
  list: SplitFilePanelList
  viewer: JSX.Element
  viewerActions?: JSX.Element

  listOpen: boolean
  onToggleList: () => void

  splitWidth: number
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void

  isPhoneLayout: boolean
  overlayAriaLabel: string
}

const SplitFilePanel: Component<SplitFilePanelProps> = (props) => {
  const { t } = useI18n()
  const viewer = () => (
    <div class="relative flex flex-1 min-h-0 min-w-0">
      {props.viewer}
      <Show when={props.viewerActions}>
        <div class="absolute bottom-2 left-2 z-40 flex items-center gap-1">{props.viewerActions}</div>
      </Show>
    </div>
  )

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

      <div class="files-tab-body">
        <Show
          when={!props.isPhoneLayout && props.listOpen}
          fallback={viewer()}
        >
          <div class="files-split" style={{ "--files-pane-width": `${props.splitWidth}px` }}>
            <div class="file-list-panel">
              <div class="file-list-scroll">{props.list.panel()}</div>
            </div>
            <div
              class="file-split-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("instanceShell.filesShell.resizeFiles")}
              onMouseDown={props.onResizeMouseDown}
              onTouchStart={props.onResizeTouchStart}
            />
            {viewer()}
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
