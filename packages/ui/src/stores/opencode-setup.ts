import { createSignal } from "solid-js"
import type { OpenCodeUpdateStatus } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"

export const [openCodeSetupStatus, setOpenCodeSetupStatus] = createSignal<OpenCodeUpdateStatus>()
export const [openCodeSetupOpen, setOpenCodeSetupOpen] = createSignal(false)
export const [openCodeSetupBusy, setOpenCodeSetupBusy] = createSignal(false)
export const [openCodeSetupError, setOpenCodeSetupError] = createSignal(false)
let generation = 0
let notifiedGeneration = -1
let pending: Promise<void> | undefined
let resume: (() => Promise<unknown>) | undefined

export function needsOpenCodeSetup(status = openCodeSetupStatus()): boolean {
  return status?.state === "missing" || status?.state === "update_required" || status?.serviceState === "restart_required"
}

export function openOpenCodeSetup(retry?: () => Promise<unknown>) {
  if (retry) resume = retry
  setOpenCodeSetupOpen(true)
  void refreshOpenCodeSetup()
}

export function reportOpenCodeSetupRequired() {
  if (openCodeSetupBusy() || notifiedGeneration === generation) return
  notifiedGeneration = generation
  openOpenCodeSetup()
}

export function invalidateOpenCodeSetup() {
  generation++
  pending = undefined
  // Keep the selected folder while the user chooses a different executable.
  // Its callback resolves the current settings again; old mutations stay fenced.
  setOpenCodeSetupStatus(undefined)
  void refreshOpenCodeSetup()
}

export function refreshOpenCodeSetup(afterMutation = false): Promise<void> {
  if (openCodeSetupBusy() && !afterMutation) return Promise.resolve()
  if (pending) return pending
  const epoch = generation
  const request = serverApi.fetchOpenCodeUpdateStatus().then(status => {
    if (epoch !== generation) return
    setOpenCodeSetupStatus(status)
    setOpenCodeSetupError(false)
  }).catch(() => { if (epoch === generation) setOpenCodeSetupError(true) })
    .finally(() => { if (pending === request) pending = undefined })
  pending = request
  return request
}

export async function runOpenCodeSetup(action: "install" | "start" | "restart" | "reload") {
  if (openCodeSetupBusy()) return
  const epoch = ++generation
  pending = undefined
  setOpenCodeSetupBusy(true)
  setOpenCodeSetupError(false)
  try {
    if (action === "install") await serverApi.updateOpenCode()
    if (epoch !== generation) return
    // Installation can leave an older shared daemon running. Re-read first so
    // restart remains a separate explicit action, never an implicit interruption.
    await refreshOpenCodeSetup(true)
    if (epoch !== generation) return
    if (action !== "restart" && openCodeSetupStatus()?.serviceState === "restart_required") return
    const status = action === "reload" ? await serverApi.reloadOpenCodeConfiguration() : await serverApi.startOpenCode(action === "restart")
    if (epoch !== generation) return
    setOpenCodeSetupStatus(status)
    if (status.state === "ready" && (status.serviceState === "ready" || status.serviceState === "restart_available")) {
      const retry = resume
      resume = undefined
      if (status.serviceState === "ready") setOpenCodeSetupOpen(false)
      await retry?.() // Workspace-open retry only; never a session prompt/mutation.
    }
  } catch {
    if (epoch === generation) { await refreshOpenCodeSetup(true); setOpenCodeSetupError(true) }
  } finally {
    setOpenCodeSetupBusy(false)
    if (epoch !== generation) void refreshOpenCodeSetup()
  }
}
