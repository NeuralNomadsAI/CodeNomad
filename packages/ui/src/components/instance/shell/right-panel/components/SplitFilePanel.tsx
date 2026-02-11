import { Show, type Component, type JSX } from "solid-js"

import OverlayList from "./OverlayList"

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
}

const SplitFilePanel: Component<SplitFilePanelProps> = (props) => {
  return (
    <div class="files-tab-container">
      <div class="files-tab-header">
        <div class="files-tab-header-row">
          <button type="button" class="files-toggle-button" onClick={props.onToggleList}>
            {props.listOpen ? "Hide files" : "Show files"}
          </button>

          {props.header}
        </div>
      </div>

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
            {props.viewer}
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
