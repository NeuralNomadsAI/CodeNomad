import { createSignal } from "solid-js"

import type { OpenCodeSessionRepairAnalysis, OpenCodeSessionRepairMode, OpenCodeSessionRepairResult } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import { tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"
import { showToastNotification } from "../lib/notifications"
import { fetchSessions } from "./sessions"
import { instances } from "./instances"

type RepairDialogState = {
  loading: boolean
  applying: boolean
  analysis: OpenCodeSessionRepairAnalysis | null
  result: OpenCodeSessionRepairResult | null
  error: string | null
}

const log = getLogger("actions")

const [open, setOpen] = createSignal(false)
const [state, setState] = createSignal<RepairDialogState>({
  loading: false,
  applying: false,
  analysis: null,
  result: null,
  error: null,
})

async function refreshAllInstanceSessions(): Promise<void> {
  const refreshes: Promise<void>[] = []
  for (const instanceId of instances().keys()) {
    refreshes.push(fetchSessions(instanceId).catch((error) => log.error("Failed to refresh sessions after repair", { instanceId, error })))
  }
  await Promise.all(refreshes)
}

async function analyzeOpenCodeSessions(): Promise<void> {
  setState((current) => ({ ...current, loading: true, error: null, result: null }))
  try {
    const analysis = await serverApi.analyzeOpenCodeSessionRepair()
    setState((current) => ({ ...current, analysis, loading: false }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setState((current) => ({ ...current, loading: false, error: message }))
  }
}

async function openOpenCodeSessionRepairDialog(): Promise<void> {
  setOpen(true)
  setState({ loading: false, applying: false, analysis: null, result: null, error: null })
  await analyzeOpenCodeSessions()
}

async function applyOpenCodeSessionRepair(mode: OpenCodeSessionRepairMode): Promise<void> {
  const confirmed = await showConfirmDialog(tGlobal("commands.repairOpenCodeSessions.confirm.message"), {
    title: tGlobal("commands.repairOpenCodeSessions.confirm.title"),
    detail: tGlobal(`commands.repairOpenCodeSessions.confirm.detail.${mode}`),
    confirmLabel: tGlobal("commands.repairOpenCodeSessions.confirm.confirmLabel"),
    cancelLabel: tGlobal("commands.repairOpenCodeSessions.confirm.cancelLabel"),
    dismissible: false,
  })
  if (!confirmed) return

  setState((current) => ({ ...current, applying: true, error: null }))
  try {
    const result = await serverApi.executeOpenCodeSessionRepair({ mode })
    setState((current) => ({ ...current, applying: false, result, analysis: result.analysis }))
    await refreshAllInstanceSessions()
    showToastNotification({
      message: tGlobal("commands.repairOpenCodeSessions.toast.success"),
      variant: "success",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setState((current) => ({ ...current, applying: false, error: message }))
    showToastNotification({
      message: tGlobal("commands.repairOpenCodeSessions.toast.error"),
      variant: "error",
    })
  }
}

function closeOpenCodeSessionRepairDialog(): void {
  if (state().applying) return
  setOpen(false)
}

export {
  open as openOpenCodeSessionRepairDialogState,
  state as openCodeSessionRepairDialogState,
  openOpenCodeSessionRepairDialog,
  closeOpenCodeSessionRepairDialog,
  analyzeOpenCodeSessions,
  applyOpenCodeSessionRepair,
}
