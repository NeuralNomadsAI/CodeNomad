import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { PermissionReceipts } from "../../permissions/receipts"
import { initialServerCapabilities, requireServerCapability } from "../../opencode/servers/capabilities"
import { registerPermissionReceiptRoutes } from "./permission-receipts"
import { registerPendingRequestRoutes } from "./pending-requests"

test("explicit pending and receipt routes refuse structurally before acquisition, Git, filesystem, lists or store reads", async t => {
  const app = Fastify(), effects: string[] = []
  t.after(() => app.close())
  const forbidden = (name: string) => () => { effects.push(name); throw new Error(`Forbidden ${name}`) }
  const manager = {
    get: (id: string) => ({ id, path: "/工作/100%", binding: { serverId: id, directory: "/工作/100%" } }),
    requireWorkspaceCapability: (id: string, capability: "pendingRecovery" | "historyEnrichment") => {
      const snapshot = initialServerCapabilities({ id, kind: "explicit", label: id, origin: "https://example.invalid" }, 1)
      requireServerCapability(capability, snapshot.features[capability])
    },
    getSharedServiceConnection: forbidden("connection"), getServiceLocation: forbidden("location"),
    getServicePathStyle: forbidden("path style"), getServiceDirectoryForPath: forbidden("host directory"),
    getWorktreeIdentityForPath: forbidden("Git"), getHostPathForServicePath: forbidden("host path"),
    ownsLocation: forbidden("ownership scan"), desktopPluginsReady: forbidden("provisioning"),
  }
  const receipts = new PermissionReceipts({ list: forbidden("receipt store") } as never, manager as never, new EventBus(), pino({ level: "silent" }))
  registerPermissionReceiptRoutes(app, receipts)
  registerPendingRequestRoutes(app, { workspaceManager: manager as never, worktreeDeletionFence: { isBlocked: forbidden("deletion fence") },
    readGitCommonDirectory: forbidden("Git common directory") as never })
  for (const id of ["A", "B"]) for (const [url, capability, reason] of [
    [`/api/workspaces/${id}/pending-requests?directories=${encodeURIComponent("/工作/100%")}`, "pendingRecovery", "liveOnly"],
    [`/api/workspaces/${id}/sessions/ses_same/permission-receipts?messageId=same`, "historyEnrichment", "deferred"],
  ]) {
    const response = await app.inject({ method: "GET", url })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability, reason: { code: reason } })
    assert.equal(response.headers["cache-control"], "no-store")
  }
  assert.deepEqual(effects, [])
})

test("receipt route preserves ordinary internal failures instead of disguising them as capability refusals", async t => {
  const app = Fastify()
  t.after(() => app.close())
  registerPermissionReceiptRoutes(app, { list: async () => { throw new Error("owned failure") } } as never)
  assert.equal((await app.inject("/api/workspaces/local/sessions/ses_same/permission-receipts?unanchored=true")).statusCode, 500)
})
