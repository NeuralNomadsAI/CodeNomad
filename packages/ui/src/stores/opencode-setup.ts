import { createSignal } from "solid-js"
import type { OpenCodeUpdateStatus } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"

export const [openCodeSetupStatus, setOpenCodeSetupStatus] = createSignal<OpenCodeUpdateStatus>()
export const [openCodeSetupOpen, setOpenCodeSetupOpen] = createSignal(false)
export const [openCodeSetupBusy, setOpenCodeSetupBusy] = createSignal(false)
export const [openCodeSetupError, setOpenCodeSetupError] = createSignal(false)
export const [openCodeSetupCheckError, setOpenCodeSetupCheckError] = createSignal(false)
export const [openCodeInstallationError, setOpenCodeInstallationError] = createSignal<"installation_busy" | "installation_in_use">()
export type OpenCodeSetupAction = "install" | "start" | "restart" | "reload"
export const [openCodeSetupAction, setOpenCodeSetupAction] = createSignal<OpenCodeSetupAction>()
export const [openCodeSetupChecking, setOpenCodeSetupChecking] = createSignal(false)
export const [openCodeSetupFeedback, setOpenCodeSetupFeedback] = createSignal<"checked" | "reloaded">()
let generation = 0
let notifiedGeneration = -1
let pending: { promise: Promise<void>; again: boolean; announce: boolean } | undefined
const [resume, setResume] = createSignal<(() => Promise<unknown>)>()
export const canContinueOpenCodeSetup = () => Boolean(resume())

export function isOpenCodeConnected(status = openCodeSetupStatus()): boolean {
  return !openCodeSetupCheckError() && (status?.serviceState === "ready" || status?.serviceState === "restart_available")
}

export async function continueOpenCodeSetup() {
  if (!isOpenCodeConnected() || openCodeSetupBusy() || openCodeSetupChecking()) return
  const epoch = generation
  const retry = resume()
  await refreshOpenCodeSetup()
  if (epoch !== generation || openCodeSetupBusy() || !isOpenCodeConnected() || resume() !== retry) return
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
  setOpenCodeSetupCheckError(false)
  setOpenCodeSetupError(false)
  setOpenCodeInstallationError(undefined)
  void refreshOpenCodeSetup()
}

export function refreshOpenCodeSetup(afterMutation = false, announce = false): Promise<void> {
  if (openCodeSetupBusy() && !afterMutation) return Promise.resolve()
  if (pending) {
    pending.again = true
    pending.announce ||= announce
    return pending.promise
  }
  const epoch = generation
  const request = { promise: Promise.resolve(), again: false, announce }
  pending = request
  setOpenCodeSetupChecking(true)
  setOpenCodeSetupFeedback(undefined)
  request.promise = (async () => {
    do {
      request.again = false
      try {
        const status = await serverApi.fetchOpenCodeUpdateStatus()
        if (epoch !== generation) return
        setOpenCodeSetupStatus(status)
        setOpenCodeSetupCheckError(false)
        setOpenCodeSetupError(false)
        setOpenCodeInstallationError(undefined)
        if (!request.again && request.announce && !status.checkError && !status.serviceError && status.state !== "error") {
          setOpenCodeSetupFeedback("checked")
        }
      } catch {
        if (epoch !== generation) return
        setOpenCodeSetupCheckError(true)
      }
    } while (request.again && epoch === generation)
  })().finally(() => {
    if (pending === request) { pending = undefined; setOpenCodeSetupChecking(false) }
  })
  return request.promise
}

export async function runOpenCodeSetup(action: OpenCodeSetupAction, options: { resumeWorkspace?: boolean } = {}): Promise<OpenCodeUpdateStatus | undefined> {
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
    if (epoch !== generation || openCodeSetupCheckError()) return
    if (action !== "restart" && (openCodeSetupStatus()?.serviceState === "restart_required" || openCodeSetupStatus()?.serviceState === "incompatible")) return
    const status = action === "reload" ? await serverApi.reloadOpenCodeConfiguration() : await serverApi.startOpenCode(action === "restart")
    if (epoch !== generation) return
    setOpenCodeSetupStatus(status)
    if (status.state === "ready" && (status.serviceState === "ready" || status.serviceState === "restart_available")) {
      // Info-panel maintenance must not resume a workspace-open request left in
      // a dismissed recovery dialog. Preserve it for explicit recovery instead.
      const retry = options.resumeWorkspace === false ? undefined : resume()
      if (options.resumeWorkspace !== false) setResume(undefined)
      if (action === "reload") setOpenCodeSetupFeedback("reloaded")
      if (retry && status.serviceState === "ready") setOpenCodeSetupOpen(false)
      await retry?.() // Workspace-open retry only; never a session prompt/mutation.
      return status
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
