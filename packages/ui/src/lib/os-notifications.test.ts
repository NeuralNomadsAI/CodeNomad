import assert from "node:assert/strict"
import test from "node:test"
import { getOsNotificationCapability, requestOsNotificationPermission, sendOsNotification } from "./os-notifications"

test("Tauri uses native macOS authorization for permission reads and requests", async () => {
  const calls: unknown[] = []
  let permission: "default" | "denied" | "granted" | null = "default"
  const windowStub = {
    __CODENOMAD_RUNTIME_HOST__: "tauri",
    __CODENOMAD_NOTIFICATION_PERMISSION__: true,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { request: boolean }) => {
        calls.push([command, args])
        if (command === "plugin:notification|is_permission_granted") return true
        assert.equal(command, "notification_permission")
        if (args.request) permission = "denied"
        return permission
      },
    },
  }
  const originalWindow = globalThis.window
  Object.assign(globalThis, { window: windowStub })
  try {
    assert.deepEqual(await getOsNotificationCapability(), { supported: true, permission: "default", info: undefined })
    assert.equal(await requestOsNotificationPermission(), "denied")
    assert.equal((await getOsNotificationCapability()).permission, "denied")
    permission = "granted"
    assert.equal((await getOsNotificationCapability()).permission, "granted")
    assert.deepEqual(calls, [false, true, false, false].map(request => ["notification_permission", { request }]))

    permission = null // The unbundled host uses the plugin for delivery as well.
    assert.equal((await getOsNotificationCapability()).permission, "granted")
    assert.equal((calls.at(-1) as [string])[0], "plugin:notification|is_permission_granted")
    windowStub.__CODENOMAD_NOTIFICATION_PERMISSION__ = false
    calls.length = 0
    assert.equal((await getOsNotificationCapability()).permission, "granted")
    assert.deepEqual(calls, [["plugin:notification|is_permission_granted", {}]])
  } finally {
    Object.assign(globalThis, { window: originalWindow })
  }
})

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
