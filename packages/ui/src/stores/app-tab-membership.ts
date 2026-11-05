import { createSignal } from "solid-js"
import { generateUUID } from "../lib/client-identity"

const [openInstanceTabIds, setOpenInstanceTabIds] = createSignal<ReadonlySet<string>>(new Set())
const closeRequestListeners = new Set<(instanceId: string) => void>()
const attachmentLifetimes = new Map<string, string>()
export const instanceTabAttachmentLifetime = (instanceId: string) => attachmentLifetimes.get(instanceId)

function attachInstanceTabMembership(instanceId: string): void {
  setOpenInstanceTabIds((previous) => {
    if (previous.has(instanceId)) return previous
    attachmentLifetimes.set(instanceId, generateUUID())
    return new Set(previous).add(instanceId)
  })
}

function detachInstanceTabMembership(instanceId: string): void {
  setOpenInstanceTabIds((previous) => {
    if (!previous.has(instanceId)) return previous
    attachmentLifetimes.delete(instanceId)
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
