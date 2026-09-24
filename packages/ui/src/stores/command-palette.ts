import { batch, createSignal } from "solid-js"

const [openStates, setOpenStates] = createSignal<Map<string, boolean>>(new Map())
const [focusRequests, setFocusRequests] = createSignal(new Map<string, number>())

function updateState(instanceId: string, open: boolean) {
  batch(() => {
    setOpenStates((prev) => new Map(prev).set(instanceId, open))
    if (open) setFocusRequests(prev => new Map(prev).set(instanceId, (prev.get(instanceId) ?? 0) + 1))
  })
}

export function getCommandPaletteFocusRequest(instanceId: string): number {
  return focusRequests().get(instanceId) ?? 0
}

export function showCommandPalette(instanceId: string) {
  if (!instanceId) return
  updateState(instanceId, true)
}

export function hideCommandPalette(instanceId?: string) {
  if (!instanceId) {
    setOpenStates(new Map())
    return
  }
  updateState(instanceId, false)
}

export function toggleCommandPalette(instanceId: string) {
  if (!instanceId) return
  const current = openStates().get(instanceId) ?? false
  updateState(instanceId, !current)
}

export function isOpen(instanceId: string): boolean {
  return openStates().get(instanceId) ?? false
}

export { openStates }
