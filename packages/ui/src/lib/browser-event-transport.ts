import type { WorkspaceEventPayload } from "../../../server/src/api-types"

export interface BrowserEventStreamCallbacks {
  onEvent: (event: WorkspaceEventPayload) => void
  onError?: () => void
  onOpen?: () => void
  onPing?: (payload: { ts?: number }) => void
  onReplayReset?: () => void
  onParseError?: (error: unknown) => void
}

export interface BrowserEventStreamConnection {
  close: () => void
  finished: Promise<void>
}

export function createBrowserEventConnector(fetchImpl: typeof fetch = fetch) {
  let lastEventId: string | undefined
  let generation = 0

  return (url: string, callbacks: BrowserEventStreamCallbacks): BrowserEventStreamConnection => {
    const connectionGeneration = ++generation
    const controller = new AbortController()
    let closed = false
    let errorRaised = false

    const isCurrent = () => !closed && connectionGeneration === generation
    const raiseError = () => {
      if (!isCurrent() || errorRaised) return
      errorRaised = true
      callbacks.onError?.()
    }

    const headers = new Headers({ Accept: "text/event-stream" })
    if (lastEventId !== undefined) headers.set("Last-Event-ID", lastEventId)

    const finished = (async () => {
      try {
        const response = await fetchImpl(url, {
          credentials: "include",
          headers,
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Event stream unavailable (${response.status})`)
        if (!response.body) throw new Error("Event stream response has no body")
        if (!isCurrent()) return
        callbacks.onOpen?.()
        await readEventStream(response.body, {
          onEvent: (event) => {
            if (isCurrent()) callbacks.onEvent(event)
          },
          onError: callbacks.onError,
          onPing: (payload) => {
            if (isCurrent()) callbacks.onPing?.(payload)
          },
          onReplayReset: () => {
            if (isCurrent()) callbacks.onReplayReset?.()
          },
          onParseError: (error) => {
            if (isCurrent()) callbacks.onParseError?.(error)
          },
          onEventId: (id) => {
            if (isCurrent()) lastEventId = id || undefined
          },
        })
        raiseError()
      } catch (error) {
        if (!isCurrent()) return
        callbacks.onParseError?.(error)
        raiseError()
      }
    })()

    return {
      close() {
        if (closed) return
        closed = true
        controller.abort()
      },
      finished,
    }
  }
}

interface EventStreamReaderCallbacks extends BrowserEventStreamCallbacks {
  onEventId: (id: string) => void
}

async function readEventStream(stream: ReadableStream<Uint8Array>, callbacks: EventStreamReaderCallbacks): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let eventName = ""
  let eventId: string | undefined
  let dataLines: string[] = []

  const dispatch = () => {
    if (eventId !== undefined) callbacks.onEventId(eventId)
    if (dataLines.length === 0) return
    try {
      const payload = JSON.parse(dataLines.join("\n")) as WorkspaceEventPayload & { ts?: number }
      if (eventName === "codenomad.client.ping") callbacks.onPing?.(payload)
      else if (eventName === "codenomad.replay.reset") callbacks.onReplayReset?.()
      else if (!eventName || eventName === "message") callbacks.onEvent(payload)
    } catch (error) {
      callbacks.onParseError?.(error)
    }
  }

  const processLine = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (!line) {
      dispatch()
      eventName = ""
      eventId = undefined
      dataLines = []
      return
    }
    if (line.startsWith(":")) return
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") eventName = value
    else if (field === "id" && !value.includes("\0")) eventId = value
    else if (field === "data") dataLines.push(value)
  }

  while (true) {
    const { done, value } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    let newline = buffered.indexOf("\n")
    while (newline >= 0) {
      processLine(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
    }
    if (done) break
  }
  if (buffered) processLine(buffered)
  processLine("")
}
