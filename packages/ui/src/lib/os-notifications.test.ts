import assert from "node:assert/strict"
import test from "node:test"
import { sendOsNotification } from "./os-notifications"

test("Tauri falls back to the notification plugin only when the host lacks the command", async () => {
  const missingCommand = "Command notification_show not found"
  let rejection: unknown = missingCommand
  const sent: unknown[] = []
  const attempts: string[] = []
  let actionId: string | undefined
  const windowStub = Object.assign(new EventTarget(), {
    __CODENOMAD_RUNTIME_HOST__: "tauri",
    __CODENOMAD_WINDOW_CONTEXT__: "remote",
    __CODENOMAD_NOTIFICATION_ACTIONS__: false,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { actionId?: string }) => {
        attempts.push(command)
        actionId = args.actionId
        throw rejection
      },
    },
    Notification: class {
      constructor(title: string, { body }: NotificationOptions) {
        sent.push({ title, body })
      }
    },
  })
  const originalWindow = globalThis.window
  Object.assign(globalThis, { window: windowStub })
  try {
    let clicks = 0
    const payload = { title: "CodeNomad", body: "R&D", onClick: () => { clicks++ } }
    const notice = { title: payload.title, body: payload.body }
    await sendOsNotification(payload)
    assert.deepEqual(attempts, [])
    assert.deepEqual(sent, [notice])

    windowStub.__CODENOMAD_NOTIFICATION_ACTIONS__ = true
    await sendOsNotification(payload)
    assert.deepEqual(attempts, ["notification_show"])
    assert.deepEqual(sent, [notice, notice])
    assert.ok(actionId)
    windowStub.dispatchEvent(new CustomEvent("codenomad:notification-click", { detail: actionId }))
    assert.equal(clicks, 0)

    for (rejection of ["IPC connection lost", "Command notification_show not allowed by ACL"]) {
      await assert.rejects(sendOsNotification(payload), error => error === rejection)
    }
    assert.deepEqual(attempts, Array(3).fill("notification_show"))
    assert.equal(sent.length, 2)
  } finally {
    Object.assign(globalThis, { window: originalWindow })
  }
})
