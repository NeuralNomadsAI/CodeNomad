type EventHandler = ((event: Event) => unknown) | null

export class TunnelEventSource extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readonly withCredentials: boolean
  readonly url: string
  readyState = TunnelEventSource.CONNECTING
  onopen: EventHandler = null
  onmessage: ((event: MessageEvent) => unknown) | null = null
  onerror: EventHandler = null
  private controller: AbortController | null = null
  private reconnectDelay = 3_000
  private lastEventId = ""

  constructor(url: string | URL, options?: EventSourceInit) {
    super()
    this.url = new URL(url, window.location.href).toString()
    this.withCredentials = options?.withCredentials === true
    void this.connect()
  }

  close(): void {
    if (this.readyState === TunnelEventSource.CLOSED) return
    this.readyState = TunnelEventSource.CLOSED
    this.controller?.abort()
    this.controller = null
    const event = new Event("close")
    this.dispatchEvent(event)
    ;(this as EventSource & { onclose?: EventHandler }).onclose?.(event)
  }

  private async connect(): Promise<void> {
    while (this.readyState !== TunnelEventSource.CLOSED) {
      this.controller = new AbortController()
      try {
        const headers = new Headers({ Accept: "text/event-stream" })
        if (this.lastEventId) headers.set("Last-Event-ID", this.lastEventId)
        const response = await fetch(this.url, {
          headers,
          credentials: this.withCredentials ? "include" : "same-origin",
          signal: this.controller.signal,
          cache: "no-store",
        })
        if (response.status === 204) {
          this.readyState = TunnelEventSource.CLOSED
          return
        }
        if (!response.ok || !response.body) throw new Error(`Event stream failed with HTTP ${response.status}`)
        this.readyState = TunnelEventSource.OPEN
        const open = new Event("open")
        this.dispatchEvent(open)
        this.onopen?.(open)
        await this.read(response.body)
      } catch {
        if (this.readyState === TunnelEventSource.CLOSED) return
      }
      if (this.readyState === TunnelEventSource.CLOSED) return
      this.readyState = TunnelEventSource.CONNECTING
      const error = new Event("error")
      this.dispatchEvent(error)
      this.onerror?.(error)
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay))
    }
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let eventName = "message"
    let eventData: string[] = []
    let eventId = this.lastEventId

    const dispatch = () => {
      if (!eventData.length) {
        eventName = "message"
        return
      }
      this.lastEventId = eventId
      const event = new MessageEvent(eventName, { data: eventData.join("\n"), lastEventId: eventId })
      this.dispatchEvent(event)
      if (eventName === "message") this.onmessage?.(event)
      eventName = "message"
      eventData = []
    }

    while (!this.controller?.signal.aborted) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith("\r")) line = line.slice(0, -1)
        if (!line) dispatch()
        else if (!line.startsWith(":")) {
          const separator = line.indexOf(":")
          const field = separator < 0 ? line : line.slice(0, separator)
          let data = separator < 0 ? "" : line.slice(separator + 1)
          if (data.startsWith(" ")) data = data.slice(1)
          if (field === "event") eventName = data || "message"
          else if (field === "data") eventData.push(data)
          else if (field === "id" && !data.includes("\0")) eventId = data
          else if (field === "retry" && /^\d+$/.test(data)) this.reconnectDelay = Number(data)
        }
        newline = buffer.indexOf("\n")
      }
      if (done) {
        dispatch()
        break
      }
    }
  }

}
