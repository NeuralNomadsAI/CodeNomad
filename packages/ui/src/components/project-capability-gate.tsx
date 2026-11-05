import { Show, onCleanup, type JSX } from "solid-js"
import { createProjectAdmission } from "../stores/project-capability"
import type { ProjectFeature } from "../lib/project-capability"

/** Admission precedes child construction; unavailable features render nothing. */
export function ProjectCapabilityBoundary(props: {
  instanceId: string; feature: ProjectFeature; children: JSX.Element
  focusWithin?: () => HTMLElement | undefined
  onRemovedFocus?: (root: HTMLElement) => void
}) {
  const admission = createProjectAdmission(() => props.instanceId, () => props.feature)
  return <Show keyed when={admission()}>{_admission => {
    onCleanup(() => {
      const root = props.focusWithin?.()
      if (!root) return
      const focused = document.activeElement
      if (!root.contains(focused)) return
      queueMicrotask(() => {
        if (root.isConnected && focused && !focused.isConnected && document.hasFocus() && document.activeElement === document.body) props.onRemovedFocus?.(root)
      })
    })
    return props.children
  }}</Show>
}
