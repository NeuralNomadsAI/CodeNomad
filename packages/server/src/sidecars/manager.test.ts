import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SideCarManager } from "./manager"

const existing = {
  id: "existing",
  kind: "port",
  name: "Existing",
  port: 65534,
  insecure: true,
  prefixMode: "strip",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

function manager(sidecars: unknown[] = []) {
  return new SideCarManager({
    settings: {
      getOwner: () => ({ sidecars }),
      mergePatchOwner: () => { throw new Error("disk full") },
    } as any,
    eventBus: { publish() {} } as any,
    logger: { warn() {} } as any,
  })
}

describe("SideCarManager persistence rollback", () => {
  it("restores create, update, and delete state when persistence fails", async () => {
    const createManager = manager()
    await assert.rejects(createManager.create({
      kind: "port",
      name: "New",
      port: 65533,
      insecure: true,
      prefixMode: "strip",
    }))
    assert.deepEqual(await createManager.list(), [])

    const updateManager = manager([existing])
    await assert.rejects(updateManager.update(existing.id, { name: "Changed" }))
    assert.equal((await updateManager.get(existing.id))?.name, existing.name)

    const deleteManager = manager([existing])
    await assert.rejects(deleteManager.delete(existing.id))
    assert.equal((await deleteManager.get(existing.id))?.id, existing.id)
  })
})
