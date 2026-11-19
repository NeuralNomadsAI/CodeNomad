import { createSignal, onCleanup, onMount } from "solid-js"
import {
  requestDeviceSpeech, type DeviceSpeechError, type DeviceSpeechSnapshot, type HexPlan, type SpeechEngine,
} from "../../lib/native/device-speech"
import { TrailingResyncCoordinator } from "../../lib/trailing-resync"

type Preparation = { state: "starting" | "verifying" | "stopping" } | { state: "downloading"; downloadedBytes: number }
type Run = { id?: string; stopping: boolean; cancelSent?: boolean }

export function useDeviceSpeechSettings() {
  const [snapshot, setSnapshot] = createSignal<DeviceSpeechSnapshot>()
  const [phase, setPhase] = createSignal<Preparation>()
  const [error, setError] = createSignal<DeviceSpeechError>()
  const [resume, setResume] = createSignal(false)
  const [reading, setReading] = createSignal(false)
  const [readFailed, setReadFailed] = createSignal(false)
  const [selecting, setSelecting] = createSignal(false)
  let disposed = false
  let timer: number | undefined
  let run: Run | undefined
  const busy = () => reading() || selecting() || Boolean(phase())
  const canChange = () => !busy() && !readFailed()

  const reads = new TrailingResyncCoordinator(async () => {
    if (disposed) return
    const result = await requestDeviceSpeech("read", {})
    if (disposed) return
    setReadFailed(!result.ok)
    if (result.ok) setSnapshot(result.value)
  }, () => { if (!disposed) setReadFailed(true) })

  async function refresh() {
    if (disposed || selecting() || phase()) return
    setReading(true)
    await reads.request("device")
    if (!disposed) setReading(false)
  }

  async function select(engine: SpeechEngine) {
    if (disposed || !canChange() || !snapshot() || snapshot()?.engine === engine) return
    setError(undefined)
    setSelecting(true)
    const result = await requestDeviceSpeech("select", { engine })
    if (disposed) return
    setSelecting(false)
    if (result.ok) setSnapshot(result.value)
    else {
      setError(result.error)
      await refresh()
    }
  }

  async function cancelOwned(current: Run) {
    if (!current.id || current.cancelSent) return
    current.cancelSent = true
    const result = await requestDeviceSpeech("cancel", { id: current.id })
    if (!disposed && run === current && !result.ok && result.error !== "notOwned") setError(result.error)
  }

  function cancel() {
    if (!run || run.stopping) return
    run.stopping = true
    setPhase({ state: "stopping" })
    void cancelOwned(run)
  }

  async function settle(current: Run, result: "prepared" | "cancelled" | DeviceSpeechError) {
    // Remove terminal receipts and stop work on a failed status read as well.
    void cancelOwned(current)
    if (disposed || run !== current) return
    run = undefined
    setResume(result !== "prepared")
    setError(result === "prepared" || result === "cancelled" ? undefined : result)
    setPhase(undefined)
    await refresh()
  }

  async function observe(current: Run, id: string) {
    const result = await requestDeviceSpeech("status", { id })
    if (disposed || run !== current) return
    // Cancelling after native completion can discard the receipt first.
    if (!result.ok) return settle(current, current.stopping && result.error === "notOwned" ? "cancelled" : result.error)
    switch (result.value.state) {
      case "prepared":
      case "cancelled": return settle(current, result.value.state)
      case "error": return settle(current, result.value.error)
      case "stopping": setPhase({ state: "stopping" }); break
      case "downloading": if (!current.stopping) setPhase(result.value); break
      case "verifying":
      case "starting": if (!current.stopping) setPhase({ state: result.value.state }); break
      default: return settle(current, "failed")
    }
    timer = window.setTimeout(() => { void observe(current, id) }, 300)
  }

  async function prepare(plan: HexPlan) {
    const hex = snapshot()?.hex
    if (disposed || !canChange() || hex?.state !== "needsPreparation" || plan.id !== hex.plan.id) return
    const current: Run = { stopping: false }
    run = current
    setError(undefined)
    setPhase({ state: "starting" })
    const result = await requestDeviceSpeech("prepare", { planId: plan.id })
    if (!result.ok) return settle(current, result.error)
    current.id = result.value.id
    if (disposed || run !== current || current.stopping) await cancelOwned(current)
    if (!disposed && run === current) void observe(current, result.value.id)
  }

  function dispose() {
    disposed = true
    window.clearTimeout(timer)
    if (run) void cancelOwned(run)
  }
  const refreshOnFocus = () => { void refresh() }
  onMount(() => {
    refreshOnFocus()
    window.addEventListener("focus", refreshOnFocus)
    window.addEventListener("pagehide", dispose)
  })
  onCleanup(() => {
    window.removeEventListener("focus", refreshOnFocus)
    window.removeEventListener("pagehide", dispose)
    dispose()
  })

  return { snapshot, phase, error, resume, reading, readFailed, canChange, refresh, select, prepare, cancel }
}
