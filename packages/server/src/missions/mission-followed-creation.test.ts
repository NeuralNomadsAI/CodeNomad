import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { followedPreparationFixture } from "./mission-preparation-test-fixture"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { missionCreationRequestSchema, prepareMissionCreation } from "../server/routes/mission-creation-pipeline"
import { setupMissionsPlugin, type MissionsPluginContext } from "../opencode/missions-plugin"

test("immediate creation carries exact followed identities through HTTP preparation and the registered plugin RPC", async t => {
  const f = await followedPreparationFixture("/fixture", true)
  const request = { requestId: "http_followed", objective: "Read this context", template: "custom", watchedConversationIDs: [f.source.id] }
  assert.equal(missionCreationRequestSchema.safeParse(request).success, true)
  let create!: Parameters<MissionsPluginContext["rpc"]["register"]>[1]["create"]
  let roots = 0
  const cleanup = await setupMissionsPlugin({
    location: { directory: "/fixture", project: { id: "project", canonical: "/fixture" } }, storage: f.storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const session = f.sessions.get(sessionID); assert.ok(session); return session },
      create: async (input: Parameters<MissionsPluginContext["session"]["create"]>[0]) => {
        roots++; const session = { ...input, projectID: "project" }; f.sessions.set(session.id, session); return session
      },
      prompt: async () => assert.fail("No creation prompt"), synthetic: async () => assert.fail("No creation admission"),
    },
    rpc: { register: async (_definition: unknown, handlers: { create: typeof create }) => {
      create = handlers.create; return { dispose: async () => {}, events: { emit: async () => {} } }
    } },
  } as never, undefined, undefined, undefined, undefined, false, undefined, use => use(f.store))
  t.after(cleanup)
  const context = { error: (_type: string, message: string, data: unknown) => { throw Object.assign(new Error(message), data) } }
  const location = { directory: "/fixture" }, client = {
    location: { get: async () => ({ ...location, project: { id: "project" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ documentCapabilities: async () => ({ version: 1 }), create: async (input: any) => {
      assert.deepEqual(input.watchedConversationIDs, request.watchedConversationIDs)
      return create(input, context)
    } }),
  }
  const { WorktreeDeletionFence } = await import("../workspaces/worktree-session-evacuation")
  const prepared = await prepareMissionCreation({ request, workspaceID: "fixture", signal: new AbortController().signal,
    fence: new WorktreeDeletionFence(), manager: {
      get: () => ({}) as any, getServiceLocation: () => location,
      getSharedServiceConnection: async () => ({ client, assertCurrent() {} }) as any,
      ownsLocation: async () => true, getServiceDirectoryForPath: async () => location.directory,
      getWorktreeIdentityForPath: async () => "/fixture",
    } })
  const native = prepared.request
  const validate = new Ajv().compile(CODENOMAD_MISSIONS_RPC.methods.create.input)
  assert.ok(validate(native), JSON.stringify(validate.errors))
  const result = await prepared.execute()
  const doc = await f.store.read(result.mission.id)
  assert.ok(doc && !("deletedAt" in doc))
  assert.deepEqual(doc.configuration.watchedConversationIDs, [f.source.id])
  assert.equal(roots, 1)
  assert.deepEqual(await create(native, context), { ...result, acknowledgement: "recovered" },
    "a lost reply recovers the same creation through the actual parser")
  await assert.rejects(create({ ...native, watchedConversationIDs: ["ses_other"] }, context), { code: "request-conflict" })
  assert.equal(roots, 1); assert.equal(f.reads, 0)
  for (const watchedConversationIDs of [[f.source.id, f.source.id], ["bad/id"], [" ses_followed "], Array.from({ length: 33 }, (_, i) => `ses_${i}`)]) {
    assert.equal(missionCreationRequestSchema.safeParse({ ...request, watchedConversationIDs }).success, false)
    if (watchedConversationIDs.length > 1) assert.equal(validate({ ...native, watchedConversationIDs }), false)
    await assert.rejects(f.control.create({ ...f.creation, requestID: "invalid", watchedConversationIDs }), /Invalid or unavailable/)
    await assert.rejects(create({ ...native, requestID: "invalid_rpc", watchedConversationIDs }, context))
  }
  assert.equal(roots, 1)
  await f.control.lifecycle({ missionID: result.mission.id, requestID: "play_rpc_sources",
    expectedRevision: result.mission.revision, action: "start" })
  assert.equal(f.reads, 1); assert.equal(f.admissions.length, 1)
  assert.match(f.admissions[0].text, /Context present at Play/)
  assert.ok(f.admissions[0].text.length <= 16384)
})

test("direct followed creation freezes one bounded first-Play read across lost acknowledgement", async () => {
  const f = await followedPreparationFixture("/fixture", true)
  assert.deepEqual((await f.read()).configuration.watchedConversationIDs, [f.source.id])
  assert.equal(f.reads, 0)
  assert.equal((await f.control.create(f.creation)).mission.id, f.mission.id)
  assert.equal(f.sessions.size, 1)
  await assert.rejects(f.control.create({ ...f.creation, watchedConversationIDs: ["ses_different"] }), /different|conflict/i)
  const play = { missionID: f.mission.id, requestID: "play_direct", expectedRevision: f.mission.revision, action: "start" as const }
  f.fail("admission-after")
  await assert.rejects(f.control.lifecycle(play), /retry the remaining/)
  const frozen = (await f.read()).oneTime!.firstPlay!.inputText!
  assert.match(frozen, /Context present at Play/)
  assert.ok(frozen.length <= 16384)
  f.messages[0].text = "Changed after first Play"; f.available(false)
  await f.control.lifecycle(play); await f.control.lifecycle(play)
  assert.equal(f.reads, 1); assert.equal(f.admissions.length, 1)
  assert.equal(f.admissions[0].text, frozen)
  assert.equal((await f.read()).launchedCount, 1)
})

test("a lost creation publication acknowledgement recovers the same document and root with its original sources", async t => {
  const f = await followedPreparationFixture("/fixture", true)
  const create = { ...f.creation, requestID: "lost_creation_ack" }, write = f.storage.set
  let lost = false
  t.mock.method(f.storage, "set", async (...args: Parameters<typeof write>) => {
    await write(...args)
    if (!lost && (args[1] as { type?: string }).type === "mission.created") {
      lost = true; throw new Error("Creation reply lost")
    }
  })
  await assert.rejects(f.control.create(create), /Creation reply lost/)
  const saved = (await f.control.snapshot()).missions.find(row => row.id !== f.mission.id)!
  assert.equal((await f.control.create(create)).mission.id, saved.id)
  const doc = await f.store.read(saved.id)
  assert.ok(doc && !("deletedAt" in doc))
  assert.deepEqual(doc.configuration.watchedConversationIDs, [f.source.id])
  await assert.rejects(f.control.create({ ...create, watchedConversationIDs: ["ses_other"] }), /different|conflict/i)
  assert.equal(f.sessions.size, 2); assert.equal(f.reads, 0); assert.equal(f.admissions.length, 0)
})

for (const failure of ["moved", "capacity"] as const) test(`direct followed ${failure} blocks before reservation or admission`, async () => {
  const f = await followedPreparationFixture("/fixture", true), before = await f.read()
  if (failure === "moved") f.source.location.directory = "/other"
  else f.messages[0].text = "x".repeat(16384)
  await assert.rejects(f.control.lifecycle({ missionID: f.mission.id, requestID: "blocked", expectedRevision: f.mission.revision, action: "start" }), /context is incomplete/)
  assert.deepEqual(await f.read(), before); assert.equal(f.admissions.length, 0)
})
