import { createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionBodySource, useMissionBody } from "../stores/mission-content"

/** Times Save as brief starts again from a newer map when a recorded input changed. */
const MAX_BRIEF_RESTARTS = 3

/** One recorded input of a snapshot: its value (undefined when the snapshot has none),
 * still reading, changed since that snapshot, or a failed read with its retry. */
export type MissionTargetValue =
  | { state: "ready"; value: string | undefined }
  | { state: "reading" }
  | { state: "changed" }
  | { state: "failed"; retry: () => void }

/** `field` of `target`, the snapshot an intent (an edit, a saved brief) starts from. Only
 * the body whose digest the target's descriptor names is its value, whatever the cache
 * retained; a whole body of another digest read at or after the target's revision means
 * the field changed since. A field the target names no descriptor of is absent, a member
 * of the snapshot. */
export function useTargetBody(instanceId: () => string, target: () => MissionPanelMap | undefined, field: "objective" | "notes") {
  const descriptor = () => target()?.bodies?.[field]
  const read = useMissionBody(() => {
    const value = target()
    return value && descriptor() ? missionBodySource(instanceId(), value, { kind: "mission", field }) : undefined
  })
  return createMemo((): MissionTargetValue => {
    const value = target(), expected = descriptor()
    if (!value) return { state: "reading" }
    if (!expected) return { state: "ready", value: undefined }
    const state = read.state(), body = state.body
    const whole = body !== undefined && body.text.length === body.characters
    if (whole && body.digest === expected.digest) return { state: "ready", value: body.text }
    if (whole && body.revision >= value.revision || state.status === "missing" && (state.revision ?? 0) >= value.revision) return { state: "changed" }
    if (state.status === "error") return { state: "failed", retry: read.retry }
    return { state: "reading" }
  })
}

/** Where several inputs of one snapshot stand together: ready only when each is. */
export function missionTargetState(values: readonly MissionTargetValue[]): "ready" | "reading" | "changed" | "failed" {
  if (values.every(value => value.state === "ready")) return "ready"
  if (values.some(value => value.state === "changed")) return "changed"
  return values.some(value => value.state === "failed") ? "failed" : "reading"
}

/** Retries each failed input. */
export function retryMissionTarget(values: readonly MissionTargetValue[]): void {
  for (const value of values) if (value.state === "failed") value.retry()
}

/** A selected mission's recorded objective and notes for Save as brief, from one snapshot:
 * the map shown when its name field opens (`open`), whatever unrelated revisions follow.
 * An input that changed since starts it again from the newest map (refreshed once if the
 * shown one has not caught up), at most `MAX_BRIEF_RESTARTS` times; then, or when a refresh
 * brings no newer map, it is `changed` until `retry` starts again from the current map. */
export function useRecordedBriefInputs(props: { instanceId: () => string; mission: () => MissionPanelMap; open: () => boolean; refresh: () => Promise<void> }) {
  const [target, setTarget] = createSignal<MissionPanelMap>()
  const [restarts, setRestarts] = createSignal(0)
  const [refreshed, setRefreshed] = createSignal<{ target: MissionPanelMap; settled: boolean }>()
  const begin = () => { setRestarts(0); setRefreshed(undefined); setTarget(props.open() ? props.mission() : undefined) }
  createEffect(on(props.open, () => untrack(begin)))
  const objective = useTargetBody(props.instanceId, target, "objective"), notes = useTargetBody(props.instanceId, target, "notes")
  const inputs = () => [objective(), notes()]
  createEffect(() => {
    const current = target(), newest = props.mission()
    if (!current || missionTargetState(inputs()) !== "changed" || untrack(restarts) >= MAX_BRIEF_RESTARTS) return
    if (newest.revision > current.revision) { setRestarts(count => count + 1); setTarget(newest); return }
    if (untrack(refreshed)?.target === current) return
    setRestarts(count => count + 1)
    setRefreshed({ target: current, settled: false })
    void untrack(props.refresh).finally(() => { if (refreshed()?.target === current) setRefreshed({ target: current, settled: true }) })
  })
  const state = () => {
    const value = missionTargetState(inputs()), current = target()
    if (value !== "changed" || !current) return value
    const stalled = refreshed()?.target === current && refreshed()!.settled && props.mission().revision <= current.revision
    return restarts() >= MAX_BRIEF_RESTARTS || stalled ? "changed" : "reading"
  }
  return {
    state,
    /** The snapshot's inputs, once both are read. */
    values: () => state() === "ready" ? { target: target()!, objective: (objective() as { value?: string }).value ?? "", notes: (notes() as { value?: string }).value ?? "" } : undefined,
    retry: () => { if (state() === "changed") begin(); else retryMissionTarget(inputs()) },
  }
}
