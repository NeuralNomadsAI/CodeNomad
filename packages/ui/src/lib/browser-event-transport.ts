import type { WorkspaceEventPayload } from "../../../server/src/api-types"

export interface BrowserEventStreamCallbacks {
  onEvent: (event: WorkspaceEventPayload) => boolean | void
  onError?: () => void
  onOpen?: () => void
  onPing?: (payload: { ts?: number }) => boolean | void
  onReplayReset?: () => boolean | void | Promise<boolean | void>
  onParseError?: (error: unknown) => void
  getLastEventId?: () => string | undefined
  onEventId?: (id?: string) => void
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
    const requestCursor = callbacks.getLastEventId?.() ?? lastEventId
    if (requestCursor !== undefined) headers.set("Last-Event-ID", requestCursor)

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
            return isCurrent() ? callbacks.onEvent(event) : false
          },
          onError: callbacks.onError,
          onPing: (payload) => {
            return isCurrent() ? callbacks.onPing?.(payload) : false
          },
          onReplayReset: () => {
            return isCurrent() ? callbacks.onReplayReset?.() : false
          },
          onParseError: (error) => {
            if (isCurrent()) callbacks.onParseError?.(error)
          },
          onEventId: (id) => {
            if (!isCurrent()) return
            lastEventId = id || undefined
            callbacks.onEventId?.(id)
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
  onEventId: (id?: string) => void
}

async function readEventStream(stream: ReadableStream<Uint8Array>, callbacks: EventStreamReaderCallbacks): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let eventName = ""
  let eventId: string | undefined
  let dataLines: string[] = []

  const dispatch = async () => {
    if (dataLines.length === 0) return
    let payload: WorkspaceEventPayload & { ts?: number }
    try {
      payload = JSON.parse(dataLines.join("\n")) as WorkspaceEventPayload & { ts?: number }
    } catch (error) {
      callbacks.onParseError?.(error)
      return
    }

    let accepted: boolean | void
    if (eventName === "codenomad.client.ping") accepted = callbacks.onPing?.(payload)
    else if (eventName === "codenomad.replay.cursor") accepted = true
    else if (eventName === "codenomad.replay.reset") accepted = await callbacks.onReplayReset?.()
    else if (!eventName || eventName === "message") accepted = callbacks.onEvent(payload)
    else return

    if (eventName === "codenomad.replay.reset") {
      if (accepted === false) throw new Error("Replay reset resynchronization failed")
      callbacks.onEventId(eventId)
    } else if (accepted !== false && eventId !== undefined) {
      callbacks.onEventId(eventId)
    }
  }

  const processLine = async (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (!line) {
      await dispatch()
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
      await processLine(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf("\n")
    }
    if (done) break
  }
}
