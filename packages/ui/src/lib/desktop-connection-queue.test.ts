import assert from "node:assert/strict"
import test from "node:test"
import { connectionFailureMessage, installDesktopConnectionLaunchHandler, InteractionRequiredError, type PendingConnection } from "./desktop-connection-queue"

const tick = () => new Promise((resolve) => setImmediate(resolve))

function host(pending: PendingConnection[]) {
  const acknowledgements: Array<[string, string | null, boolean]> = []
  let notify: (() => void) | undefined
  return {
    acknowledgements,
    wake: () => notify?.(),
    api: {
      onPendingConnections: (callback: () => void) => { notify = callback; return () => { notify = undefined } },
      nextPendingConnection: async () => pending[0] ?? null,
      acknowledgePendingConnection: async (target: string, failure: string | null, handOff: boolean) => {
        acknowledgements.push([target, failure, handOff])
        if (pending[0]?.target === target) pending.shift()
      },
    },
  }
}

test("connections run one at a time, interactively, and report their own failures", async () => {
  const pending: PendingConnection[] = [{ target: "prod" }, { target: "missing" }]
  const { api, acknowledgements } = host(pending)
  const connected: string[] = []
  const shown: string[] = []
  const cleanup = installDesktopConnectionLaunchHandler(api, async (target, { interactive }) => {
    connected.push(`${target}:${interactive}`)
    if (target === "missing") throw new Error("No saved server is named \"missing\".")
  }, (message) => shown.push(message), (error) => assert.fail(String(error)))
  await tick(); await tick()
  cleanup()
  assert.deepEqual(connected, ["prod:true", "missing:true"])
  assert.deepEqual(shown, ["No saved server is named \"missing\"."])
  assert.deepEqual(acknowledgements, [["prod", null, false], ["missing", "No saved server is named \"missing\".", false]])
})

test("a hidden launch window never prompts or shows a failure: it hands both to the host", async () => {
  const { api, acknowledgements } = host([
    { target: "https://down.example.com/", hidden: true },
    { target: "https://self-signed.example.com/", hidden: true },
  ])
  const interactive: boolean[] = []
  const shown: string[] = []
  const cleanup = installDesktopConnectionLaunchHandler(api, async (target, options) => {
    interactive.push(options.interactive)
    if (target.includes("down")) throw new Error("unreachable")
    throw new InteractionRequiredError()
  }, (message) => shown.push(message), (error) => assert.fail(String(error)))
  await tick(); await tick(); await tick()
  cleanup()
  assert.deepEqual(interactive, [false, false])
  assert.deepEqual(shown, [])
  assert.deepEqual(acknowledgements, [["https://down.example.com/", "unreachable", false], ["https://self-signed.example.com/", null, true]])
})

test("a forwarded failure is shown without connecting again, and later requests wake the drain", async () => {
  const pending: PendingConnection[] = [{ target: "missing", failure: "No saved server is named \"missing\"." }]
  const { api, acknowledgements, wake } = host(pending)
  const connected: string[] = []
  const shown: string[] = []
  const cleanup = installDesktopConnectionLaunchHandler(api, async (target) => { connected.push(target) },
    (message) => shown.push(message), (error) => assert.fail(String(error)))
  await tick(); await tick()
  pending.push({ target: "prod" })
  wake()
  await tick(); await tick()
  cleanup()
  assert.deepEqual(shown, ["No saved server is named \"missing\"."])
  assert.deepEqual(connected, ["prod"])
  assert.deepEqual(acknowledgements, [["missing", null, false], ["prod", null, false]])
})

test("failure messages drop Electron's IPC wrapper", () => {
  assert.equal(connectionFailureMessage(new Error("Error invoking remote method 'remote:openWindow': Error: ERR_EMPTY_RESPONSE (-324) loading 'http://127.0.0.1:1/'")),
    "ERR_EMPTY_RESPONSE (-324) loading 'http://127.0.0.1:1/'")
  assert.equal(connectionFailureMessage(new Error("fetch failed")), "fetch failed")
  assert.equal(connectionFailureMessage("plain"), "plain")
})

test("windows without the connection bridge install nothing", () => {
  assert.doesNotThrow(installDesktopConnectionLaunchHandler(undefined, async () => {}, () => {}, () => {}))
})
