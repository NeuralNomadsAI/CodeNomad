import assert from "node:assert/strict"
import test from "node:test"
import { setupMissionsPlugin } from "./missions-plugin"
import { missionPluginFixture, FIXTURE_PROJECT } from "../missions/mission-plugin-fixture"
import { NativeMissionDocumentStore } from "../missions/mission-document-store"
import { canonicalAuthority } from "../missions/authority-protocol"
import type { NativeMissionSession } from "../missions/control-types"

for (const workspaceID of [undefined, "workspace_exact"]) test(`native project location is portable JSON during unified create (${workspaceID ?? "directory only"})`, async () => {
  const f = missionPluginFixture(), created: NativeMissionSession[] = []
  const documents = new NativeMissionDocumentStore({ get: f.storage.get, compareAndSet: async (key, value, _expected, current) => {
    current()
    // The native SQL document adapter canonicalizes the original CAS value.
    await f.storage.set(key, JSON.parse(canonicalAuthority(value)))
  } }, FIXTURE_PROJECT.id, FIXTURE_PROJECT.canonical)
  let create!: (input: unknown, context: unknown) => Promise<{ mission: { document?: unknown } }>
  let update!: (input: unknown, context: unknown) => Promise<unknown>
  const registration = () => ({ dispose: async () => {} })
  const dispose = await setupMissionsPlugin({
    location: { directory: FIXTURE_PROJECT.canonical, ...(workspaceID === undefined ? {} : { workspaceID }),
      project: { id: FIXTURE_PROJECT.id, canonical: FIXTURE_PROJECT.canonical } },
    storage: f.storage,
    session: { get: async () => { throw new Error("No existing root") }, create: async (input: NativeMissionSession) => {
      canonicalAuthority(input.location)
      const session = { ...input, projectID: FIXTURE_PROJECT.id }; created.push(session); return session
    }, hook: async () => registration() },
    tool: { transform: async () => registration() },
    rpc: { register: async (_definition: unknown, handlers: { create: typeof create; update: typeof update }) => {
      create = handlers.create; update = handlers.update; return { ...registration(), events: { emit: async () => {} } }
    } },
  } as never, undefined, undefined, undefined, undefined, false, undefined, use => use(documents))
  try {
    const result = await create({ requestID: "native-create", objective: "Canonical project placement", template: "custom", prepared: true }, {
      error: (_type: string, message: string) => { throw new Error(message) },
    })
    assert.ok(result.mission.document)
    assert.equal(created.length, 1)
    assert.deepEqual(created[0].location, { directory: FIXTURE_PROJECT.canonical, ...(workspaceID === undefined ? {} : { workspaceID }) })
    await assert.rejects(update({ missionID: "msn_unknown", requestID: "unknown-edit", expectedRevision: 1, objective: "Absent" }, {
      error: (_type: string, message: string, data: { code: string }) => { throw Object.assign(new Error(message), data) },
    }), (error: unknown) => (error as { code?: string }).code === "mission-not-found")
  } finally { await dispose() }
})
