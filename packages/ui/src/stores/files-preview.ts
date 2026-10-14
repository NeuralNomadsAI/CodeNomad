import { createSignal } from "solid-js"

export interface FilePreviewTarget {
  kind?: "workspace" | "diff"
  sessionId: string
  slug: string
  directory: string
  serviceDirectory?: string
  path: string
  originalPath?: string | null
  scope?: "staged" | "unstaged"
  commit?: string
  subject?: string
}

// Only the current selection per project; file bytes belong to the mounted reader.
const [targets, setTargets] = createSignal(new Map<string, FilePreviewTarget>())
export const getFilePreview = (instanceId: string) => targets().get(instanceId) ?? null
export function openFilePreview(instanceId: string, target: FilePreviewTarget) {
  setTargets(previous => {
    const next = new Map(previous)
    next.delete(instanceId)
    next.set(instanceId, target)
    if (next.size > 32) next.delete(next.keys().next().value!)
    return next
  })
}
export function closeFilePreview(instanceId: string) {
  setTargets(previous => {
    if (!previous.has(instanceId)) return previous
    const next = new Map(previous)
    next.delete(instanceId)
    return next
  })
}
