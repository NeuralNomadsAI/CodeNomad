import { createSignal } from "solid-js"

export interface SidebarControls {
  onLeftToggle: () => void
  onRightToggle: () => void
  leftLabel: string
  rightLabel: string
  leftIcon: "open" | "close"
  rightIcon: "open" | "close"
  leftDisabled: boolean
  rightDisabled: boolean
}

const [sidebarControls, setSidebarControls] = createSignal<SidebarControls | null>(null)

export function registerSidebarControls(controls: SidebarControls) {
  setSidebarControls(controls)
}

export function unregisterSidebarControls() {
  setSidebarControls(null)
}

export function getSidebarControls() {
  return sidebarControls()
}
