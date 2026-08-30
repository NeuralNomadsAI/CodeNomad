import { createSignal } from "solid-js"

const [openInstanceTabIds, setOpenInstanceTabIds] = createSignal<ReadonlySet<string>>(new Set())
const closeRequestListeners = new Set<(instanceId: string) => void>()

function attachInstanceTabMembership(instanceId: string): void {
  setOpenInstanceTabIds((previous) => {
    if (previous.has(instanceId)) return previous
    return new Set(previous).add(instanceId)
  })
}

function detachInstanceTabMembership(instanceId: string): void {
  setOpenInstanceTabIds((previous) => {
    if (!previous.has(instanceId)) return previous
    const next = new Set(previous)
    next.delete(instanceId)
    return next
  })
}

function onInstanceTabCloseRequested(listener: (instanceId: string) => void): () => void {
  closeRequestListeners.add(listener)
  return () => closeRequestListeners.delete(listener)
}

function requestInstanceTabClose(instanceId: string): void {
  for (const listener of closeRequestListeners) listener(instanceId)
}

export {
  attachInstanceTabMembership,
  detachInstanceTabMembership,
  onInstanceTabCloseRequested,
  openInstanceTabIds,
  requestInstanceTabClose,
}
