import { createEffect, onCleanup, type Accessor } from "solid-js"

interface TaskTranscriptLoadOptions {
  sessionId: Accessor<string>
  enabled: Accessor<boolean>
  loaded: Accessor<boolean>
  loading: Accessor<boolean>
  load: (sessionId: string, signal: AbortSignal) => Promise<void>
}

export function useTaskTranscriptLoad(options: TaskTranscriptLoadOptions): void {
  let owned: { sessionId: string; controller: AbortController } | undefined

  createEffect(() => {
    const sessionId = options.sessionId()
    const enabled = options.enabled()
    const loaded = options.loaded()
    const loading = options.loading()

    if (owned && (!enabled || owned.sessionId !== sessionId)) {
      owned.controller.abort()
      owned = undefined
    }
    if (!sessionId || !enabled || loaded || loading || owned) return

    const request = { sessionId, controller: new AbortController() }
    owned = request
    void options.load(sessionId, request.controller.signal).catch(() => undefined).finally(() => {
      if (owned === request) owned = undefined
    })
  })

  onCleanup(() => owned?.controller.abort())
}
