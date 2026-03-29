import { type Component } from "solid-js"
import type { SideCarTabRecord } from "../stores/sidecars"

interface SideCarViewProps {
  tab: SideCarTabRecord
}

export const SideCarView: Component<SideCarViewProps> = (props) => {
  return (
    <iframe
      src={props.tab.shellUrl}
      title={props.tab.name}
      class="w-full h-full border-0 bg-surface"
      referrerPolicy="same-origin"
    />
  )
}
