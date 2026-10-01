import { OpenCode } from "@opencode/client"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createInstanceFetch } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"

// Deliberately small transport fixture, not a replacement session store/UI.
// All API requests and SSE use the real production browser adapters.
const baseUrl = `${location.origin}/workspaces/workspace/instance/`
const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
const [selected, setSelected] = createSignal("A")
const [loaded, setLoaded] = createSignal("")
const [draft, setDraft] = createSignal("")
const [opens, setOpens] = createSignal(0)
const [events, setEvents] = createSignal(0)
const [pending, setPending] = createSignal(false)
const errors: string[] = []
let catalogueSettled = 0
serverEvents.onOpen(() => setOpens(value => value + 1))
serverEvents.on("instance.eventStatus", () => setEvents(value => value + 1))

const fixture = {
  start(action: "prompt" | "compact") {
    setPending(true)
    const operation = action === "prompt"
      ? client.session.prompt({ sessionID: "A", text: "private transport fixture" })
      : client.session.compact({ sessionID: "A" })
    void operation.catch(error => errors.push(String(error))).finally(() => setPending(false))
  },
  catalogues() {
    // Five distinct catalogue intents, not foreground session reads: production
    // createInstanceFetch must admit only two and leave the other three queued.
    // Distinct URLs avoid Chromium's same-URL cache request coalescing.
    for (let index = 0; index < 5; index++) {
      void client.agent.get({ agentID: `fixture-${index}` }).catch(error => errors.push(String(error))).finally(() => catalogueSettled++)
    }
  },
  async info() { return (await fetch("/api/meta")).json() },
  async witness() { return (await fetch("/api/witness")).json() },
  snapshot() { return { selected: selected(), loaded: loaded(), draft: draft(), opens: opens(), events: events(), pending: pending(), catalogueSettled, errors } },
}
;(window as any).fixture = fixture

render(() => <main>
  <input aria-label="Draft" value={draft()} onInput={event => setDraft(event.currentTarget.value)} />
  <button onClick={() => {
    setSelected("B")
    void client.session.get({ sessionID: "B" }).then(session => setLoaded(session.id)).catch(error => errors.push(String(error)))
  }}>Switch to B</button>
  <output data-selected>{selected()}</output>
  <output data-loaded>{loaded()}</output>
</main>, document.getElementById("root")!)
