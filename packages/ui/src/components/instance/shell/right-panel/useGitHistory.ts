import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { GitCommitDetails, GitHistoryPage } from "../../../../../../server/src/api-types"
import { serverApi } from "../../../../lib/api-client"
import { backgroundReads } from "../../../../lib/background-read-queue"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../../../../lib/filesystem-events"

export function useGitHistory(instanceId: string, slug: Accessor<string>, active: Accessor<boolean>) {
  const [page, setPage] = createSignal<GitHistoryPage | null>(null)
  const [details, setDetails] = createSignal<GitCommitDetails | null>(null)
  const [selected, setSelected] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [detailLoading, setDetailLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let listController: AbortController | undefined
  let detailController: AbortController | undefined
  let pending = false

  async function refresh(more = false) {
    if (!active()) return
    if (loading()) { pending = true; return }
    const controller = listController = new AbortController()
    const scope = slug(), previous = page()
    setLoading(true)
    setError(null)
    try {
      const result = await backgroundReads.run(controller.signal, () => serverApi.fetchGitHistory(instanceId, scope,
        more ? previous?.commits.length ?? 0 : 0, more ? previous?.head ?? undefined : undefined, controller.signal), "visible")
      if (controller.signal.aborted || scope !== slug()) return
      if (more && previous) setPage({ ...result, commits: [...previous.commits, ...result.commits] })
      else if (previous && previous.head === result.head && previous.commits.length > result.commits.length) {
        setPage({ ...result, commits: [...result.commits, ...previous.commits.slice(result.commits.length)], hasMore: previous.hasMore })
      } else setPage(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (listController === controller) {
        setLoading(false)
        if (pending) { pending = false; void refresh() }
      }
    }
  }

  async function select(id: string) {
    if (!active()) return
    detailController?.abort()
    const controller = detailController = new AbortController()
    setSelected(id)
    setDetails(null)
    setError(null)
    setDetailLoading(true)
    try {
      const result = await backgroundReads.run(controller.signal, () => serverApi.fetchGitCommit(instanceId, slug(), id, controller.signal), "visible")
      if (!controller.signal.aborted) setDetails(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause))
    } finally { if (detailController === controller) setDetailLoading(false) }
  }

  function cancel() {
    listController?.abort()
    detailController?.abort()
    listController = detailController = undefined
    pending = false
    setLoading(false)
    setDetailLoading(false)
  }
  createEffect(on(slug, () => { cancel(); setPage(null); setDetails(null); setSelected(null); setError(null) }))
  createEffect(on(() => active() ? slug() : null, value => {
    if (value === null) { cancel(); return }
    void refresh()
    if (selected() && !details()) void select(selected()!)
  }))
  const debounced = createDebouncedRefresh(() => void refresh())
  createEffect(on(() => filesystemInvalidationVersion(instanceId), () => { if (active()) debounced.trigger() }, { defer: true }))
  onCleanup(() => { cancel(); debounced.cancel() })
  return { page, details, selected, loading, detailLoading, error, refresh, select,
    back: () => { detailController?.abort(); setSelected(null); setDetails(null); setError(null); setDetailLoading(false) } }
}
