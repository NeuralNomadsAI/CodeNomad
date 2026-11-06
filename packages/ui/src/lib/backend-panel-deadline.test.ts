import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { backendEvents, ServerEvents } from "./server-events"
import { panelExtensionsApi4 } from "./panel-extensions-api"
import { API4_HOST_DEADLINE_MS, useApi4Channel } from "../components/panel-extensions/api4-channel"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

for (const detachFirst of [false, true]) test(`panel deadline aborts IO and ${detachFirst ? "a revoked attachment stays silent" : "its live owner answers before the frame deadline"}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const source = new ServerEvents({ api: { connectEvents: () => ({ close() {} } as EventSource), sendClientConnectionPong: async () => {} },
    auth: { check: async () => {}, onRestored: () => () => false } })
  const id = `panel_deadline_${detachFirst}`, detach = backendEvents.attach(id, source)
  t.after(() => { detach(); source.dispose() })
  let release!: (value: never) => void, signal!: AbortSignal
  t.mock.method(panelExtensionsApi4, "images", async (_authority: unknown, _session: string, _cursor: unknown, parent: AbortSignal) => {
    signal = parent
    return new Promise<never>(resolve => { release = resolve })
  })
  const answers: unknown[] = []
  let receive!: ReturnType<typeof useApi4Channel>
  createRoot(dispose => {
    t.after(dispose)
    receive = useApi4Channel({ instanceId: `${id}~ws`, id: "example.gallery", digest: "d", permissions: ["session.images.read"], sessionId: "s",
      send: value => { answers.push(value) }, host: { activeSessionId: () => "s", promptInputApi: () => null, isPhoneLayout: () => false, closePanel() {} } })
  })
  const run = receive({ type: "api4:request", id: 1, capability: "images", method: "list", input: {} })
  await tick()
  if (detachFirst) detach()
  t.mock.timers.tick(API4_HOST_DEADLINE_MS)
  assert.equal(signal.aborted, true)
  assert.deepEqual(answers, detachFirst ? [] : [{ type: "api4:result", id: 1, error: true }])
  release({ status: "page", entries: [], cursor: null } as never)
  await run
  assert.equal(answers.length, detachFirst ? 0 : 1, "the cancelled late success cannot answer or navigate")
})
