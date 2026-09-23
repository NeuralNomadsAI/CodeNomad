import { createSignal } from "solid-js"
import type { OpenCodeUpdateStatus } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"

export const [openCodeSetupStatus, setOpenCodeSetupStatus] = createSignal<OpenCodeUpdateStatus>()
export const [openCodeSetupOpen, setOpenCodeSetupOpen] = createSignal(false)
export const [openCodeSetupBusy, setOpenCodeSetupBusy] = createSignal(false)
export const [openCodeSetupError, setOpenCodeSetupError] = createSignal(false)
export const [openCodeInstallationError, setOpenCodeInstallationError] = createSignal<"installation_busy" | "installation_in_use">()
export type OpenCodeSetupAction = "install" | "start" | "restart" | "reload"
export const [openCodeSetupAction, setOpenCodeSetupAction] = createSignal<OpenCodeSetupAction>()
export const [openCodeSetupChecking, setOpenCodeSetupChecking] = createSignal(false)
export const [openCodeSetupFeedback, setOpenCodeSetupFeedback] = createSignal<"checked" | "reloaded">()
let generation = 0
let notifiedGeneration = -1
let pending: Promise<void> | undefined
const [resume, setResume] = createSignal<(() => Promise<unknown>)>()
export const canContinueOpenCodeSetup = () => Boolean(resume())

export function isOpenCodeConnected(status = openCodeSetupStatus()): boolean {
  return status?.serviceState === "ready" || status?.serviceState === "restart_available"
}

export async function continueOpenCodeSetup() {
  if (!isOpenCodeConnected() || openCodeSetupBusy()) return
  const retry = resume()
  setResume(undefined)
  setOpenCodeSetupOpen(false)
  await retry?.()
}

export function needsOpenCodeSetup(status = openCodeSetupStatus()): boolean {
  return status?.state === "missing" || status?.state === "update_required" || status?.serviceState === "restart_required" || status?.serviceState === "incompatible"
}

export function openOpenCodeSetup(retry?: () => Promise<unknown>) {
  if (retry) setResume(() => retry)
  setOpenCodeSetupFeedback(undefined)
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
  setOpenCodeSetupFeedback(undefined)
  void refreshOpenCodeSetup()
}

export function refreshOpenCodeSetup(afterMutation = false, announce = false): Promise<void> {
  if (openCodeSetupBusy() && !afterMutation) return Promise.resolve()
  if (pending) return pending
  const epoch = generation
  setOpenCodeSetupChecking(true)
  if (announce) setOpenCodeSetupFeedback(undefined)
  const request = serverApi.fetchOpenCodeUpdateStatus().then(status => {
    if (epoch !== generation) return
    setOpenCodeSetupStatus(status)
    setOpenCodeSetupError(false)
    setOpenCodeInstallationError(undefined)
    if (announce) setOpenCodeSetupFeedback("checked")
  }).catch(() => { if (epoch === generation) setOpenCodeSetupError(true) })
    .finally(() => { if (pending === request) { pending = undefined; setOpenCodeSetupChecking(false) } })
  pending = request
  return request
}

export async function runOpenCodeSetup(action: OpenCodeSetupAction) {
  if (openCodeSetupBusy()) return
  const epoch = ++generation
  pending = undefined
  setOpenCodeSetupBusy(true)
  setOpenCodeSetupAction(action)
  setOpenCodeSetupFeedback(undefined)
  setOpenCodeSetupError(false)
  setOpenCodeInstallationError(undefined)
  try {
    if (action === "install") await serverApi.updateOpenCode()
    if (epoch !== generation) return
    // Installation can leave an older shared daemon running. Re-read first so
    // restart remains a separate explicit action, never an implicit interruption.
    await refreshOpenCodeSetup(true)
    if (epoch !== generation) return
    if (action !== "restart" && (openCodeSetupStatus()?.serviceState === "restart_required" || openCodeSetupStatus()?.serviceState === "incompatible")) return
    const status = action === "reload" ? await serverApi.reloadOpenCodeConfiguration() : await serverApi.startOpenCode(action === "restart")
    if (epoch !== generation) return
    setOpenCodeSetupStatus(status)
    if (status.state === "ready" && (status.serviceState === "ready" || status.serviceState === "restart_available")) {
      const retry = resume()
      setResume(undefined)
      if (action === "reload") setOpenCodeSetupFeedback("reloaded")
      if (retry && status.serviceState === "ready") setOpenCodeSetupOpen(false)
      await retry?.() // Workspace-open retry only; never a session prompt/mutation.
    }
  } catch (error) {
    if (epoch === generation) {
      await refreshOpenCodeSetup(true)
      if (epoch !== generation) return
      setOpenCodeSetupError(true)
      if (error instanceof Error && (error.message === "installation_busy" || error.message === "installation_in_use")) {
        setOpenCodeInstallationError(error.message)
      }
    }
  } finally {
    setOpenCodeSetupBusy(false)
    setOpenCodeSetupAction(undefined)
    if (epoch !== generation) void refreshOpenCodeSetup()
  }
}
