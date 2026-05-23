import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  PERMISSION_AUTO_ACCEPT_STATE_KEY,
  createPermissionAutoAcceptServerPersistence,
  makePermissionAutoAcceptStatePatch,
  makePermissionAutoAcceptScope,
  makePermissionAutoAcceptStateKey,
  mergeUnmigratedPermissionAutoAcceptState,
  migrateLegacyPermissionAutoAcceptState,
  readPersistedPermissionAutoAcceptState,
  serializePermissionAutoAcceptState,
  shouldApplyPersistedPermissionAutoAcceptState,
} from "./permission-auto-accept-persistence.ts"
import { shouldSubagentInheritPermissionAutoAcceptValue } from "./permission-auto-accept-rules.ts"
import type { Session } from "../types/session.ts"

function installLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  type MockWindow = {
    location: Pick<Location, "origin">
    localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  }
  type MockEventSource = new () => Pick<EventSource, "addEventListener" | "removeEventListener" | "close">
  type TestGlobal = { window?: MockWindow; EventSource?: MockEventSource }
  const global = globalThis as unknown as TestGlobal
  const originalWindow = global.window
  const originalEventSource = global.EventSource

  global.window = {
    location: { origin: "http://localhost" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    },
  }
  global.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  return {
    values,
    restore: () => {
      if (originalWindow === undefined) {
        delete global.window
      } else {
        global.window = originalWindow
      }
      if (originalEventSource === undefined) {
        delete global.EventSource
      } else {
        global.EventSource = originalEventSource
      }
    },
  }
}

function waitForPatchCount(calls: unknown[], count: number): Promise<void> {
  if (calls.length >= count) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000
    const poll = () => {
      if (calls.length >= count) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${count} storage patch calls`))
        return
      }
      setTimeout(poll, 0)
    }
    poll()
  })
}

describe("subagent YOLO inheritance", () => {
  it("inherits only for non-fork child sessions when parent YOLO is enabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        true,
      ),
      true,
    )
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: { messageID: "msg", partID: "part" } },
        true,
      ),
      false,
    )
  })

  it("does not inherit when parent YOLO is disabled", () => {
    assert.equal(
      shouldSubagentInheritPermissionAutoAcceptValue(
        { parentId: "parent", revert: undefined },
        false,
      ),
      false,
    )
  })

})

describe("permission auto-accept persistence", () => {
  it("uses stable workspace-scoped session IDs for persisted keys", () => {
    const scope = makePermissionAutoAcceptScope("/tmp/work space")

    assert.equal(scope, "workspace:%2Ftmp%2Fwork%20space")
    assert.equal(makePermissionAutoAcceptStateKey(scope, "session"), "workspace:%2Ftmp%2Fwork%20space:session:session")
  })

  it("round-trips enabled session keys through UI state", () => {
    const key = makePermissionAutoAcceptStateKey(makePermissionAutoAcceptScope("/tmp/workspace"), "session")
    const serialized = serializePermissionAutoAcceptState(new Map([[key, true]]))

    assert.deepEqual(serialized, { [key]: true })
    assert.deepEqual(
      readPersistedPermissionAutoAcceptState({ [PERMISSION_AUTO_ACCEPT_STATE_KEY]: serialized }),
      new Map([[key, true]]),
    )
  })

  it("ignores missing, false, and malformed persisted values", () => {
    assert.equal(readPersistedPermissionAutoAcceptState({}), null)
    assert.deepEqual(
      readPersistedPermissionAutoAcceptState({
        [PERMISSION_AUTO_ACCEPT_STATE_KEY]: {
          enabled: true,
          disabled: false,
          malformed: "true",
        },
      }),
      new Map([["enabled", true]]),
    )
  })

  it("emits merge-patch deletes for disabled persisted keys", () => {
    const enabled = makePermissionAutoAcceptStateKey(makePermissionAutoAcceptScope("/tmp/workspace"), "enabled")
    const disabled = makePermissionAutoAcceptStateKey(makePermissionAutoAcceptScope("/tmp/workspace"), "disabled")

    assert.deepEqual(
      makePermissionAutoAcceptStatePatch(
        new Map([
          [enabled, true],
          [disabled, true],
        ]),
        new Map([[enabled, true]]),
      ),
      { [enabled]: true, [disabled]: null },
    )
  })

  it("migrates legacy instance-scoped local keys to workspace-scoped keys", () => {
    const scope = makePermissionAutoAcceptScope("/tmp/workspace")
    const migrated = migrateLegacyPermissionAutoAcceptState(
      new Map([
        ["instance-a:session-a", true],
        ["instance-b:session-b", true],
      ]),
      "instance-a",
      scope,
    )

    assert.deepEqual(
      migrated,
      new Map([
        [makePermissionAutoAcceptStateKey(scope, "session-a"), true],
        ["instance-b:session-b", true],
      ]),
    )
  })

  it("ignores stale persisted echoes while a newer local state is pending", () => {
    const enabled = new Map([[makePermissionAutoAcceptStateKey(makePermissionAutoAcceptScope("/tmp/workspace"), "session"), true]])

    assert.equal(shouldApplyPersistedPermissionAutoAcceptState(new Map<string, boolean>(), enabled), false)
    assert.equal(shouldApplyPersistedPermissionAutoAcceptState(enabled, enabled), true)
    assert.equal(shouldApplyPersistedPermissionAutoAcceptState(null, new Map<string, boolean>()), true)
  })

  it("preserves unmigrated legacy local keys when server state arrives first", () => {
    const scope = makePermissionAutoAcceptScope("/tmp/workspace")
    const serverKey = makePermissionAutoAcceptStateKey(scope, "server-session")
    const localWorkspaceKey = makePermissionAutoAcceptStateKey(scope, "stale-local-session")

    assert.deepEqual(
      mergeUnmigratedPermissionAutoAcceptState(
        new Map([[serverKey, true]]),
        new Map([
          ["instance-a:legacy-session", true],
          [localWorkspaceKey, true],
        ]),
      ),
      new Map([
        [serverKey, true],
        ["instance-a:legacy-session", true],
      ]),
    )
  })

  it("persists enable and disable changes to server state", async () => {
    const calls: Array<{ owner: string; patch: unknown }> = []
    const serverState: Record<string, boolean> = {}
    const stateKey = makePermissionAutoAcceptStateKey(makePermissionAutoAcceptScope("/tmp/workspace"), "session-a")
    const appliedBuckets: unknown[] = []

    const persistence = createPermissionAutoAcceptServerPersistence({
      owner: "ui",
      patchStateOwner: async (owner, patch) => {
        calls.push({ owner, patch })
        const permissionPatch = (patch as Record<string, Record<string, boolean | null>>)[PERMISSION_AUTO_ACCEPT_STATE_KEY]
        for (const [key, value] of Object.entries(permissionPatch)) {
          if (value === null) {
            delete serverState[key]
          } else {
            serverState[key] = value
          }
        }
        return { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { ...serverState } }
      },
      applyPersistedBucket: (bucket) => {
        appliedBuckets.push(bucket)
      },
      logError: () => {},
    })

    persistence.persistToServer(new Map([[stateKey, true]]))
    await waitForPatchCount(calls, 1)
    await waitForPatchCount(appliedBuckets, 1)

    assert.deepEqual(calls[0], {
      owner: "ui",
      patch: { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { [stateKey]: true } },
    })
    assert.deepEqual(appliedBuckets[0], { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { [stateKey]: true } })

    persistence.persistToServer(new Map<string, boolean>(), new Map([[stateKey, true]]))
    await waitForPatchCount(calls, 2)
    await waitForPatchCount(appliedBuckets, 2)

    assert.deepEqual(calls[1], {
      owner: "ui",
      patch: { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { [stateKey]: null } },
    })
    assert.deepEqual(appliedBuckets[1], { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: {} })
  })

  it("compacts queued server writes against the last confirmed server state after failures", async () => {
    const calls: Array<{ owner: string; patch: unknown }> = []
    const serverState: Record<string, boolean> = {}
    const scope = makePermissionAutoAcceptScope("/tmp/workspace")
    const firstKey = makePermissionAutoAcceptStateKey(scope, "session-a")
    const secondKey = makePermissionAutoAcceptStateKey(scope, "session-b")
    const appliedBuckets: unknown[] = []
    let shouldFail = true

    const persistence = createPermissionAutoAcceptServerPersistence({
      owner: "ui",
      patchStateOwner: async (owner, patch) => {
        calls.push({ owner, patch })
        if (shouldFail) {
          shouldFail = false
          throw new Error("temporary write failure")
        }
        const permissionPatch = (patch as Record<string, Record<string, boolean | null>>)[PERMISSION_AUTO_ACCEPT_STATE_KEY]
        for (const [key, value] of Object.entries(permissionPatch)) {
          if (value === null) {
            delete serverState[key]
          } else {
            serverState[key] = value
          }
        }
        return { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { ...serverState } }
      },
      applyPersistedBucket: (bucket) => {
        appliedBuckets.push(bucket)
      },
      logError: () => {},
    })

    persistence.persistToServer(new Map([[firstKey, true]]))
    await waitForPatchCount(calls, 1)

    persistence.persistToServer(
      new Map([
        [firstKey, true],
        [secondKey, true],
      ]),
      new Map([[firstKey, true]]),
    )
    await waitForPatchCount(calls, 2)
    await waitForPatchCount(appliedBuckets, 1)

    assert.deepEqual(calls[1], {
      owner: "ui",
      patch: { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { [firstKey]: true, [secondKey]: true } },
    })
    assert.deepEqual(appliedBuckets[0], { [PERMISSION_AUTO_ACCEPT_STATE_KEY]: { [firstKey]: true, [secondKey]: true } })
  })

  it("uses registered workspace scopes through the store API and migrates legacy local keys", async () => {
    const browserMocks = installLocalStorage({
      "codenomad:permission-auto-accept:v1": JSON.stringify({ "instance-a:parent-session": true }),
    })
    const localStorageValues = browserMocks.values
    const patchCalls: unknown[] = []
    const { storage } = await import("../lib/storage.ts")
    const originalPatchStateOwner = storage.patchStateOwner.bind(storage)

    storage.patchStateOwner = async (_owner, patch) => {
      patchCalls.push(patch)
      return patch as Record<string, unknown>
    }

    try {
      const store = await import("./permission-auto-accept.ts")
      const scope = makePermissionAutoAcceptScope("/tmp/workspace")
      const parentKey = makePermissionAutoAcceptStateKey(scope, "parent-session")
      const childKey = makePermissionAutoAcceptStateKey(scope, "child-session")

      store.registerPermissionAutoAcceptScope("instance-a", "/tmp/workspace")

      assert.equal(store.isPermissionAutoAcceptEnabled("instance-a", "parent-session"), true)
      assert.equal(store.isPermissionAutoAcceptEnabled("unknown-instance", "parent-session"), false)
      assert.deepEqual(
        JSON.parse(localStorageValues.get("codenomad:permission-auto-accept:v1") ?? "{}"),
        { [parentKey]: true },
      )

      store.setPermissionAutoAcceptEnabled("instance-a", "child-session", true)
      await waitForPatchCount(patchCalls, 2)

      assert.equal(store.isPermissionAutoAcceptEnabled("instance-a", "child-session"), true)
      assert.deepEqual(
        JSON.parse(localStorageValues.get("codenomad:permission-auto-accept:v1") ?? "{}"),
        { [parentKey]: true, [childKey]: true },
      )

      assert.deepEqual(patchCalls.at(-1), {
        [PERMISSION_AUTO_ACCEPT_STATE_KEY]: {
          [parentKey]: true,
          [childKey]: true,
        },
      })
    } finally {
      storage.patchStateOwner = originalPatchStateOwner
      browserMocks.restore()
    }
  })

  it("keeps local toggles made before workspace scope registration and migrates them later", async () => {
    const browserMocks = installLocalStorage()
    const localStorageValues = browserMocks.values
    const patchCalls: unknown[] = []
    const { storage } = await import("../lib/storage.ts")
    const originalPatchStateOwner = storage.patchStateOwner.bind(storage)

    storage.patchStateOwner = async (_owner, patch) => {
      patchCalls.push(patch)
      return patch as Record<string, unknown>
    }

    try {
      const store = await import("./permission-auto-accept.ts")
      const scope = makePermissionAutoAcceptScope("/tmp/later-workspace")
      const sessionKey = makePermissionAutoAcceptStateKey(scope, "early-session")

      store.setPermissionAutoAcceptEnabled("late-instance", "early-session", true)

      assert.equal(store.isPermissionAutoAcceptEnabled("late-instance", "early-session"), true)
      const localBeforeRegistration = JSON.parse(localStorageValues.get("codenomad:permission-auto-accept:v1") ?? "{}")
      assert.equal(localBeforeRegistration["late-instance:early-session"], true)
      assert.deepEqual(patchCalls, [])

      store.registerPermissionAutoAcceptScope("late-instance", "/tmp/later-workspace")
      await waitForPatchCount(patchCalls, 1)

      assert.equal(store.isPermissionAutoAcceptEnabled("late-instance", "early-session"), true)
      const localAfterRegistration = JSON.parse(localStorageValues.get("codenomad:permission-auto-accept:v1") ?? "{}")
      assert.equal(localAfterRegistration["late-instance:early-session"], undefined)
      assert.equal(localAfterRegistration[sessionKey], true)
      const latestPatch = patchCalls.at(-1) as Record<string, Record<string, boolean>> | undefined
      const latestPermissionPatch = latestPatch?.[PERMISSION_AUTO_ACCEPT_STATE_KEY] ?? {}
      assert.equal(latestPermissionPatch[sessionKey], true)
    } finally {
      storage.patchStateOwner = originalPatchStateOwner
      browserMocks.restore()
    }
  })

  it("live-updates inherited child YOLO from parent state", async () => {
    const browserMocks = installLocalStorage()
    try {
      const store = await import("./permission-auto-accept.ts")
      const instanceId = "inheritance-instance"
      const parentId = "master-session"
      const childId = "child-session"
      const siblingId = "sibling-session"
      const sessions: Array<Pick<Session, "id" | "parentId" | "revert">> = [
        { id: parentId, parentId: null, revert: undefined },
        { id: childId, parentId, revert: undefined },
        { id: siblingId, parentId, revert: undefined },
      ]
      const drained: string[] = []
      const syncChildren = () =>
        store.syncInheritedPermissionAutoAcceptForChildren(instanceId, parentId, sessions, (_instanceId, sessionId) => {
          drained.push(sessionId)
        })

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, true)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)
      assert.deepEqual(drained, [childId, siblingId])

      store.setPermissionAutoAcceptEnabled(instanceId, childId, false)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, parentId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), false)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, false)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), false)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), false)

      store.setPermissionAutoAcceptEnabled(instanceId, parentId, true)
      syncChildren()

      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, childId), true)
      assert.equal(store.isPermissionAutoAcceptEnabled(instanceId, siblingId), true)
    } finally {
      browserMocks.restore()
    }
  })
})
