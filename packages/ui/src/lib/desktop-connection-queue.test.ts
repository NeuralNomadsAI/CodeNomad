import assert from "node:assert/strict"
import test from "node:test"
import { installDesktopConnectionLaunchHandler, type PendingConnection } from "./desktop-connection-queue"

const tick = () => new Promise((resolve) => setImmediate(resolve))

function host(pending: PendingConnection[]) {
  const acknowledgements: Array<[string, string | null]> = []
  let notify: (() => void) | undefined
  return {
    acknowledgements,
    wake: () => notify?.(),
    api: {
      onPendingConnections: (callback: () => void) => { notify = callback; return () => { notify = undefined } },
      nextPendingConnection: async () => pending[0] ?? null,
      acknowledgePendingConnection: async (target: string, failure: string | null) => {
        acknowledgements.push([target, failure])
        if (pending[0]?.target === target) pending.shift()
      },
    },
  }
}

test("connections run one at a time and report their own failures", async () => {
  const pending: PendingConnection[] = [{ target: "prod" }, { target: "missing" }]
  const { api, acknowledgements } = host(pending)
  const connected: string[] = []
  const shown: string[] = []
  const cleanup = installDesktopConnectionLaunchHandler(api, async (target) => {
    connected.push(target)
    if (target === "missing") throw new Error("No saved server is named \"missing\".")
  }, (message) => shown.push(message), (error) => assert.fail(String(error)))
  await tick(); await tick()
  cleanup()
  assert.deepEqual(connected, ["prod", "missing"])
  assert.deepEqual(shown, ["No saved server is named \"missing\"."])
  assert.deepEqual(acknowledgements, [["prod", null], ["missing", "No saved server is named \"missing\"."]])
})

test("a connect-only window hands its failure to the host instead of showing it", async () => {
  const { api, acknowledgements } = host([{ target: "https://down.example.com/", deferFailure: true }])
  const shown: string[] = []
  const cleanup = installDesktopConnectionLaunchHandler(api, async () => { throw new Error("unreachable") },
    (message) => shown.push(message), (error) => assert.fail(String(error)))
  await tick(); await tick()
  cleanup()
  assert.deepEqual(shown, [])
  assert.deepEqual(acknowledgements, [["https://down.example.com/", "unreachable"]])
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
  assert.deepEqual(acknowledgements, [["missing", null], ["prod", null]])
})

test("windows without the connection bridge install nothing", () => {
  assert.doesNotThrow(installDesktopConnectionLaunchHandler(undefined, async () => {}, () => {}, () => {}))
})
