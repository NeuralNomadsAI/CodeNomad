import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { PushService } from "./service"
import type { PushSubscription } from "./transport"

test("focus is subscription/principal-bound, expires and preserves delivery on other devices", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-push-focus-"))
  let sends = 0
  const push = new PushService({
    file: path.join(dir, "push.json"), enabled: () => true, projects: () => ["project"],
    authority: () => "active", validate: value => value as PushSubscription,
    keys: () => ({ publicKey: "public", privateKey: "private" }),
    send: async () => { sends++; return { status: 201 } },
  })
  t.after(() => { push.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const owner = { id: "owner", channel: "https" as const, origin: "https://code.example.test" }
  const endpoint = "https://push.example.test/device-1"
  const body = { subscription: { endpoint, keys: { p256dh: "key", auth: "key" } },
    projects: ["project"], preferences: { v: 1, needsInput: true, sessionDone: true } }
  push.subscribe(owner, body)
  const event = (key: string) => ({ key, category: "needsInput" as const, instanceId: "project", sessionId: "session" })
  push.focus({ ...owner, id: "foreign" }, { endpoint, viewId: "view", focused: true })
  await push.publish(event("foreign"))
  assert.equal(sends, 1)
  push.focus(owner, { endpoint, viewId: "view", focused: true })
  push.focus(owner, { endpoint, viewId: "hidden-sibling", focused: false })
  await push.publish(event("focused"))
  assert.equal(sends, 1)
  push.subscribe(owner, { ...body, subscription: { ...body.subscription, endpoint: `${endpoint}-other` } })
  await push.publish(event("other-device"))
  assert.equal(sends, 2)
  const now = Date.now
  const time = now()
  Date.now = () => time + 31000
  try { await push.publish(event("expired")); assert.equal(sends, 4) }
  finally { Date.now = now }
  push.focus(owner, { endpoint, viewId: "view", focused: false })
})
