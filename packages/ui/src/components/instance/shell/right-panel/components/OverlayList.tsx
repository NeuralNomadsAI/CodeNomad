import type { Component, JSX } from "solid-js"

interface OverlayListProps {
  ariaLabel: string
  children: JSX.Element
}

const OverlayList: Component<OverlayListProps> = (props) => {
  return (
    <div class="file-list-overlay" role="dialog" aria-label={props.ariaLabel}>
      <div class="file-list-scroll">{props.children}</div>
    </div>
  )
}

export default OverlayList
