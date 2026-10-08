import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Ajv from "ajv"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Schema } from "effect"
import { authorityDigest, authoritySignerDigest } from "../../missions/authority-protocol"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceHumanRequestID, deriveRecurrenceChild, recurrenceEffectID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY } from "../../missions/recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore, type RecurrenceAuthorityDocument } from "../../missions/recurrence-authority-store"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { recurrenceInput } from "../../missions/recurrence-input"
import type { MissionStorage } from "../../missions/journal"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { withNativeRecurrenceRpc } from "./managed-owner-plugin"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"

test("native current RPC authenticates exact admitted passage, pages isolated journal, and never writes", async () => {
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir(), "missions-current-"))
  try {
    const directory = realpathSync(root), database = path.join(directory, "offline.sqlite")
    await writeFile(database, "offline identity only; no daemon")
    const location = Schema.decodeUnknownSync(Location.Info)({ directory, workspaceID: "wrk_native_location",
      project: { id: "project", directory, canonical: directory } })
    const values = new Map<string, unknown>(), writes: string[] = [], scans: string[] = []
    const plain: MissionStorage = { get: async key => values.get(key) as never,
      set: async (key, value) => { values.set(key, value) }, scan: async ({ prefix, after, limit = 100 }) => {
        scans.push(prefix)
        const all = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a < b ? -1 : 1)
        const entries = all.slice(0, limit).map(([key, value]) => ({ key, value: value as never }))
        return { entries, ...(all.length > limit ? { next: entries.at(-1)!.key } : {}) }
      } }
    const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
    const config = { template: "custom" as const, consigne: "x".repeat(12_000), clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "native",
      profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const,
      roots: [{ mode: "directory-only" as const, directory }], watchedConversationIDs: [], publication: { policy: "disabled" as const, conversationIDs: [] } }
    const source = new NativeMissionRecurrenceStore(plain, "project", directory)
    let doc = await source.create("schedule", config, 1, () => true)
    doc = await source.reserve(doc.id, doc.revision, { kind: "manual", requestID: "manual", expectedRevision: doc.revision, at: 2 }, 2, () => true)
    const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9", scope = { namespace, daemonStorageID: nativeDatabaseStorageID(database),
      projectID: "project", projectCanonical: directory, scheduleID: doc.id, profileID: "profile", executionHost: "native" }
    const keys = generateKeyPairSync("ed25519"), digest = authoritySignerDigest(keys.publicKey)
    const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY, action: "authorize" as const,
      epoch: 1, expectedRevision: null, requestID: recurrenceHumanRequestID(doc.id, 1, "authorize"), scheduleRevision: 0,
      authorityID: `rec_${digest.slice(0, 40)}`, keyID: `key_${digest.slice(0, 40)}`, provisioningGeneration: digest, signerDigest: digest,
      roots: config.roots, config, configDigest: authorityDigest(config), profileSource: { profileID: "profile", executionHost: "native", configYamlPath: "/not-read" },
      budgets: { effects: 3, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
    const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    const grant = deriveRecurrenceChild(parent, doc, 1)
    const child = { parent, grant, effects: [{ kind: "create" as const }, { kind: "start" as const },
      { kind: "coordinator-message" as const, messageID: grant.messageID, contentDigest: authorityDigest(recurrenceInput({ parent, grant, effects: [] }).text) }].map(effect => {
        const operationID = recurrenceEffectID(grant, effect)
        return { operationID, effect, receipt: { operationID, outcome: "applied" as const,
          evidenceID: effect.kind === "coordinator-message" ? grant.messageID : grant.coordinatorSessionID } }
      }) }
    const authority = new NativeRecurrenceAuthorityStore(plain, scope)
    const ledger: RecurrenceAuthorityDocument = { version: 1, scope, revision: 0, parent, child, settledSequence: 0, lastArchiveDigest: null }
    values.set(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace)
    const signerKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`
    values.set(signerKey, keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    values.set(`${authority.parentKey}/parents/1`, parent); values.set(authority.key, ledger)
    const passage = recurrencePassage(plain, doc, () => true)
    await passage.journal.append({ version: 1, type: "mission.created", id: "evt_created", missionID: grant.missionID,
      projectID: "project", projectCanonical: directory, objective: config.consigne, template: "custom", requestID: grant.passage.id,
      profiles: config.profiles, taskMode: "native", prepared: true,
      coordinator: { sessionID: grant.coordinatorSessionID, title: "Coordinator", location: { directory, workspaceID: location.workspaceID } }, createdAt: 2 })
    doc = await source.recordAdmission(doc.id, { kind: "accepted", passageID: grant.passage.id, messageID: grant.messageID,
      missionID: grant.missionID, conversationID: grant.coordinatorSessionID }, 3, () => true)
    const dbTag = Context.Service<never, unknown>("@opencode/storage/Database"), locationTag = Context.Service<never, unknown>("@opencode/Location")
    const encodedPrefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
    const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[] = []) => ({ withoutTransform: Effect.sync(() => {
      if (sql === "PRAGMA database_list") return [{ name: "main", file: database }]
      assert.equal(sql, "SELECT value FROM kv WHERE key=?", "read cannot issue a mutation/Session query")
      const value = values.get(String(params[0]).slice(encodedPrefix.length))
      return value === undefined ? [] : [{ value: JSON.stringify(value) }]
    }) }) })
    const graph = Context.make(dbTag, { db: { $client: client, transaction: () => Effect.die("Unexpected transaction") } }).pipe(Context.add(locationTag, location))
    let afterScan: (() => void) | undefined
    const storage = { get: (key: string) => Effect.sync(() => values.get(key)),
      set: (key: string) => Effect.sync(() => { writes.push(key); throw new Error("Read attempted write") }),
      scan: (input: Parameters<MissionStorage["scan"]>[0]) => Effect.promise(async () => { const page = await plain.scan(input); afterScan?.(); return page }) }
    const ctx = { location, storage } as unknown as Parameters<typeof readNativeRecurrenceCurrent>[0]
    let handlers!: { recurrenceCurrent: typeof readNativeRecurrenceCurrent; recurrenceCurrentContent: typeof readNativeRecurrenceCurrentContent }
    const rpc = Object.assign(() => ({}), { register: (_: unknown, supplied: typeof handlers) => Effect.sync(() => { handlers = supplied }) })
    await Effect.runPromiseWith(graph)(Effect.scoped(withNativeRecurrenceRpc({ ...ctx, rpc } as never).register(CODENOMAD_MISSIONS_RPC, {} as never)))
    const read = (input: unknown = { scheduleID: doc.id }) => Effect.runPromiseWith(graph)((handlers.recurrenceCurrent as never as (input: unknown) => ReturnType<typeof readNativeRecurrenceCurrent>)(input))
    const content = (input: Record<string, unknown>) => Effect.runPromiseWith(graph)((handlers.recurrenceCurrentContent as never as (input: unknown) => ReturnType<typeof readNativeRecurrenceCurrentContent>)({ kind: "overview", section: "objective", ...input }))
    const result = await read()
    assert("mission" in result && result.mission)
    assert.equal(result.mission.id, grant.missionID)
    assert.equal(result.passageID, grant.passage.id)
    const ajv = new Ajv({ allErrors: true })
    const validCurrent = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrent.output)
    assert(validCurrent(result), JSON.stringify(validCurrent.errors))
    const validInput = ajv.compile(CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrent.input)
    assert(!validInput({ scheduleID: doc.id, missionID: grant.missionID }))
    assert(!validInput({ scheduleID: doc.id, sessionID: grant.coordinatorSessionID }))
    const pages = []
    for (let page = 0; page < 2; page++) {
      const selected = await content({ scheduleID: doc.id, passageID: grant.passage.id, page })
      assert("sourceText" in selected)
      assert(ajv.compile(CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrentContent.output)(selected))
      pages.push(selected.sourceText)
    }
    assert.equal(pages.join(""), config.consigne)
    assert(scans.filter(key => key.includes("/passages/")).every(key => key.includes(`/${doc.id}/${grant.passage.id}/`)))
    await assert.rejects(content({ scheduleID: doc.id, passageID: "rcp_foreign" }), /passage changed/)
    await assert.rejects(content({ scheduleID: doc.id, passageID: grant.passage.id, revision: 999 }), /revision changed/)
    await assert.rejects(read({ scheduleID: doc.id, missionID: grant.missionID }))
    const originalSigner = values.get(signerKey)
    values.set(signerKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    await assert.rejects(read(), /signer differs/); values.set(signerKey, originalSigner)
    values.set(authority.key, { ...ledger, child: { ...child, parent: { ...parent, signature: "A".repeat(86) + "==" } } })
    await assert.rejects(read()); values.set(authority.key, ledger)
    values.set(authority.key, { ...ledger, child: { ...child, effects: child.effects.map(effect => effect.effect.kind === "coordinator-message" ? { ...effect, receipt: null } : effect) } })
    await assert.rejects(read(), /observation-unavailable/); values.set(authority.key, ledger)
    afterScan = () => values.set(signerKey, "changed")
    await assert.rejects(read(), /authority changed/); afterScan = undefined; values.set(signerKey, originalSigner)
    doc = await source.finish(doc.id, { passageID: grant.passage.id, messageID: grant.messageID, missionID: grant.missionID,
      conversationID: grant.coordinatorSessionID, outcome: "completed", artifactMessageIDs: [], cursors: [] }, 4, () => true)
    assert.equal((await read()).passageID, null)
    await assert.rejects(content({ scheduleID: doc.id, passageID: grant.passage.id }), /passage unavailable/)
    assert.deepEqual(writes, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
