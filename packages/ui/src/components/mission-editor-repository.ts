import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { repositoryIdentitySchema, type MissionRepositoryIdentity } from "../../../server/src/missions/mission-repository-condition"

export type MissionRepositoryDiscovery = { repository?: MissionRepositoryIdentity; loading: boolean; failed: boolean; retry(): void }

/** Demand-only detection; publishing discovery never writes or retargets a criterion. */
export function createMissionEditorRepository(props: { instanceId: string; directory(): string | undefined; active(): boolean;
  captureView(): () => boolean }) {
  const [repository, setRepository] = createSignal<MissionRepositoryIdentity>()
  const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false), [refresh, setRefresh] = createSignal(0)
  const identity = createMemo(() => JSON.stringify([props.instanceId, props.directory(), getOpenCodeInstanceGeneration(props.instanceId)]))
  let owner = ""
  createEffect(on([identity, props.active, refresh], ([key, active]) => {
    if (owner !== key) { owner = key; setRepository(undefined); setFailed(false) }
    if (!active || !props.directory()) { setLoading(false); return }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const view = props.captureView(), directory = props.directory()!
    const current = () => view() && !controller.signal.aborted && identity() === key
    setLoading(true); setFailed(false)
    void backgroundReads.run(signal, () => serverApi.fetchRepositorySource(props.instanceId, directory, signal)).then(result => {
      if (!current()) return
      setRepository(result.status === "ok" ? repositoryIdentitySchema.strict().parse(result.repository) : undefined)
      setFailed(result.status !== "ok" && result.reason !== "no_remote")
    }).catch(() => { if (current()) setFailed(true) }).finally(() => { if (current()) setLoading(false) })
    onCleanup(() => controller.abort())
  }))
  return (): MissionRepositoryDiscovery => ({ repository: repository(), loading: loading(), failed: failed(), retry: () => setRefresh(value => value + 1) })
}
