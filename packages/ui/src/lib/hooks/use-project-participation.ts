import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { appTabs } from "../../stores/app-tabs"
import { instanceTabAttachmentLifetime } from "../../stores/app-tab-membership"
import { isPreferencesWindow, isWebHost } from "../runtime-env"
import { authenticatedFetch } from "../auth-recovery"
import { CODENOMAD_API_BASE } from "../api-base"
import { serverEvents } from "../server-events"
import { isServerId } from "../project-identity"
import type { ProjectParticipationRef } from "../../../../server/src/workspaces/project-participants"

/** Bounded positive declarations; persistence, hydration and visible selection are independent. */
export function useProjectParticipation() {
  if (!isWebHost() || isPreferencesWindow()) return
  const [grant, setGrant] = createSignal<{ token: string; current: () => boolean }>()
  const stop = serverEvents.onParticipation(value => setGrant(value))
  let revision = 0, disposed = false, pending: ProjectParticipationRef[] | "unknown" | undefined, running = false
  let lastDeclaration = ""
  let controller: AbortController | undefined
  const drain = async () => {
    if (running) return
    running = true
    try {
      while (!disposed && pending !== undefined) {
        const refs = pending, captured = untrack(grant)
        pending = undefined
        if (!captured?.current()) continue
        const abort = new AbortController(); controller = abort
        const timeout = setTimeout(() => abort.abort(), 5_000)
        try {
          // Capture the token and update before await; superseded replies publish no state.
          const response = await authenticatedFetch(`${CODENOMAD_API_BASE ?? ""}/api/project-participation`, {
            method: "POST", credentials: "include", signal: abort.signal,
            headers: { "content-type": "application/json", "x-codenomad-participation": captured.token },
            body: JSON.stringify({ revision: ++revision, refs: refs === "unknown" ? [] : refs, ...(refs === "unknown" ? { unknown: true } : {}) }),
          })
          await response.body?.cancel()
        } catch { /* Loss is unknown at the backend; there is no replay or private diagnostic. */ }
        finally { clearTimeout(timeout); if (controller === abort) controller = undefined }
      }
    } finally { running = false }
  }
  const offer = (refs: ProjectParticipationRef[] | "unknown") => {
    const value = JSON.stringify([untrack(grant)?.token, refs])
    if (value === lastDeclaration) return
    lastDeclaration = value; pending = refs; void drain()
  }
  createEffect(() => {
    const current = grant()
    if (!current?.current()) { controller?.abort(); pending = undefined; return }
    const refs: ProjectParticipationRef[] = []
    for (const tab of appTabs()) if (tab.kind === "instance") {
      if (refs.length >= 32) {
        offer("unknown"); return
      }
      const instance = tab.instance, tabId = instanceTabAttachmentLifetime(instance.id)
      const serverId = instance.binding?.serverId ?? "local-shared", directory = instance.binding?.directory ?? instance.folder
      if (!tabId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(tabId) || !isServerId(serverId)
        || typeof directory !== "string" || !directory.trim() || directory.length > 4096 || directory.includes("\0")
        || typeof instance.id !== "string" || !instance.id || instance.id.length > 512) { offer("unknown"); return }
      refs.push({ tabId, workspaceId: instance.id, serverId, directory })
    }
    offer(refs)
  })
  onCleanup(() => { disposed = true; pending = undefined; controller?.abort(); stop() })
}
