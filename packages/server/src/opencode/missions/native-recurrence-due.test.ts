import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Context, Effect, Exit, Fiber, RcMap, Schema, Scope } from "effect"
import { authorityDigest, authoritySignerDigest } from "../../missions/authority-protocol"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY } from "../../missions/recurrence-authority-contract"
import { physical } from "../../missions/host-authority/private-files"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { nativeDatabaseStorageID } from "./native-database-identity"
import { nativeRecurrenceDue, type ReconcileNativePending } from "./native-recurrence-due"
import { readNativeRecurrenceClock, startNativeRecurrenceClock } from "./native-service-clock"

const tag = (name: string) => Context.Service<never, unknown>(name)
const dbTag = tag("@opencode/storage/Database"), locationTag = tag("@opencode/Location"), sessionTag = tag("@opencode/Session")
const jobTag = tag("@opencode/Job"), mapTag = tag("@opencode/example/LocationServiceMap")
const encoded = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

test("signed Play admits one native due passage after desktop detach and Location eviction; Pause and restart do not rearm", async () => {
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir(), "missions-due-"))
  const db = new DatabaseSync(path.join(root, "service.sqlite"))
  const lifetime = await Effect.runPromise(Scope.make())
  let fiber: Fiber.Fiber<string, unknown> | undefined
  try {
    execFileSync("git", ["init", "-q", root])
    const directory = realpathSync(root), location = Schema.decodeUnknownSync(Location.Info)({ directory,
      project: { id: "project", directory, canonical: directory } })
    const ref = Schema.decodeUnknownSync(Location.Ref)({ directory })
    db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL)")
    let beforeTransaction: (() => void) | undefined
    const transactionService = tag("@test/TransactionService")
    const client = Object.assign(() => {}, { transactionService,
      unsafe: (sql: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => {
        const statement = db.prepare(sql)
        if (sql.startsWith("UPDATE kv SET value=?") && failFinishOnce && typeof params[0] === "string"
          && JSON.parse(params[0]).pending === null) {
          failFinishOnce = false
          throw new Error("Simulated crash after authority archive")
        }
        if (/^(INSERT|UPDATE)/.test(sql)) { statement.run(...params as []); return [] }
        return statement.all(...params as [])
      }) }),
    })
    const database = { db: { $client: client, transaction: <A>(callback: () => Effect.Effect<A, unknown>) =>
      Effect.promise(async () => {
        beforeTransaction?.()
        db.exec("BEGIN IMMEDIATE")
        try {
          const result = await Effect.runPromise(callback().pipe(Effect.provideService(transactionService, {}), Effect.provide(base)))
          db.exec("COMMIT")
          return result
        } catch (error) { db.exec("ROLLBACK"); throw error }
      }) } }
    const base = Context.make(dbTag, database).pipe(Context.add(locationTag, location))
    const get = (key: string) => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(encoded(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) as unknown : undefined
    }
    const put = (key: string, value: unknown) => db.prepare("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,time_updated=excluded.time_updated")
      .run(encoded(key), JSON.stringify(value), Date.now(), Date.now())
    const storage = { get: (key: string) => Effect.sync(() => get(key)), set: (key: string, value: unknown) => Effect.sync(() => { put(key, value) }),
      scan: ({ prefix, after, limit }: { prefix: string; after?: string; limit: number }) => Effect.sync(() => {
        const found = db.prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?")
          .all(encoded(prefix).length, encoded(prefix), encoded(after ?? prefix), limit + 1) as { key: string; value: string }[]
        const entries = found.slice(0, limit).map(row => ({ key: row.key.slice(encoded("").length), value: JSON.parse(row.value) }))
        return { entries, ...(found.length > limit ? { next: entries.at(-1)!.key } : {}) }
      }) }
    const ctx = { storage, location } as unknown as Parameters<typeof nativeRecurrenceDue>[0]
    const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
    const family = await readFamilyAuthorityIdentity(directory)
    const config = { consigne: "Review", clock: { time: "00:00", zone: "UTC" }, profileID: "profile", executionHost: "native",
      roots: [{ mode: "git" as const, directory, checkout: physical(directory), family }],
      profiles: { coordinator: selection, roles: { specialist: selection } }, taskMode: "native" as const,
      watchedConversationIDs: [], publication: { policy: "disabled" as const, conversationIDs: [] } }
    const store = await Effect.runPromise(Effect.scoped(acquireNativeRecurrenceStore(ctx).pipe(Effect.provide(base))))
    let now = Date.now(), failFinishOnce = false, terminal = false
    let document = await store.create("schedule", config, now - 2 * 86_400_000, () => true)
    document = await store.setState("schedule", document.revision, "running", () => true)
    const namespace = "9f6f590e-271d-477f-8c02-7a6a119d63b9", daemonStorageID = nativeDatabaseStorageID(path.join(root, "service.sqlite"))
    const scope = { namespace, daemonStorageID, projectID: "project", projectCanonical: directory,
      profileID: "profile", executionHost: "native", scheduleID: "schedule" }
    const keys = generateKeyPairSync("ed25519"), digest = authoritySignerDigest(keys.publicKey)
    const profile = { profileID: "profile", executionHost: "native", configYamlPath: path.join(root, "config.yaml") }
    await writeFile(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: old\n")
    const body = { ...scope, version: 1 as const, policy: RECURRENCE_AUTHORITY_POLICY,
      action: "authorize" as const, epoch: 1, expectedRevision: null, requestID: recurrenceHumanRequestID("schedule", 1, "authorize"),
      scheduleRevision: document.scheduleRevision, authorityID: `rec_${digest.slice(0, 40)}`,
      keyID: `key_${digest.slice(0, 40)}`, provisioningGeneration: digest, signerDigest: digest,
      roots: config.roots, config: document.config, configDigest: authorityDigest(document.config), profileSource: profile,
      budgets: { effects: 3, nativeCalls: 0, inboxMessages: 0, publications: 0 } }
    const parent = { body, signature: sign(null, recurrenceStandingSigningBytes(body), keys.privateKey).toString("base64") }
    const { stableToken } = await import("../../missions/journal")
    const ledgerKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${stableToken(`project\0${directory}`, 24)}/${stableToken("profile\0native\0schedule", 40)}`
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, namespace)
    put(`${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence-signer/profile`, keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"))
    put(`${ledgerKey}/parents/1`, parent)
    put(`${ledgerKey}/live`, { version: 1, scope, revision: 0, parent, settledSequence: 0, lastArchiveDigest: null, child: null })

    let loads = 0, creations = 0, sends = 0, environment = ""
    let afterNativeCreate: (() => void) | undefined
    let rootSession: unknown
    const native = { get: () => Effect.sync(() => { if (!rootSession) throw new Error("Root missing"); return rootSession }),
      create: (request: Record<string, unknown>) => Effect.sync(() => {
        creations++; rootSession = Schema.decodeUnknownSync(Session.Info)({ ...request, projectID: "project",
          time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
        afterNativeCreate?.()
        return rootSession
      }), inbox: () => Effect.succeed([]), prompt: () => Effect.die("Raw prompt forbidden"),
      environment: (input: { variables: Record<string, string> }) => Effect.sync(() => { environment = input.variables.MARKER; return input.variables }),
      synthetic: (input: { sessionID: string; id: string; text: string; metadata: unknown; delivery: string; description: string }) => Effect.sync(() => {
        sends++
        return Schema.decodeUnknownSync(SessionInbox.Info)({ id: input.id, sessionID: input.sessionID, type: "synthetic",
          payload: { text: input.text, description: input.description, metadata: input.metadata },
          delivery: input.delivery, time: { created: Date.now() } })
      }) }
    const map = await Effect.runPromise(RcMap.make({ idleTimeToLive: Infinity, lookup: () => Effect.sync(() => {
      loads++
      return base
    }) }).pipe(Effect.provideService(Scope.Scope, lifetime)))
    const locations = { rcMap: map, contextEffect: (key: Location.Ref) => RcMap.get(map, key),
      contextEffectOption: (key: Location.Ref) => RcMap.getOption(map, key) }
    const jobs = new Map<string, { status: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }>()
    const job = { get: (id: string) => Effect.sync(() => {
      const record = jobs.get(id)
      return record && { id, type: "codenomad.missions.recurrence", status: record.status, metadata: record.metadata }
    }), start: (input: { id: string; metadata: Record<string, unknown>; run: Effect.Effect<string, unknown> }) => Effect.sync(() => {
      jobs.set(input.id, { status: "running", metadata: input.metadata, run: input.run })
      return { id: input.id, type: "codenomad.missions.recurrence", status: "running", metadata: input.metadata }
    }), cancel: (id: string) => Effect.sync(() => { const found = jobs.get(id); if (found) found.status = "cancelled" }) }
    const app = base.pipe(Context.add(sessionTag, native), Context.add(jobTag, job), Context.add(mapTag, locations))
    const placement = { projectID: "project", projectCanonical: directory, directory, scheduleID: "schedule",
      profileID: "profile", executionHost: "native", epoch: 1 }
    const tornDocument = await store.create("torn_schedule", config, now - 2 * 86_400_000, () => true)
    const tornRunning = await store.setState(tornDocument.id, tornDocument.revision, "running", () => true)
    const tornScope = { ...scope, scheduleID: tornDocument.id }
    const tornBody = { ...body, ...tornScope, requestID: recurrenceHumanRequestID(tornDocument.id, 1, "authorize") }
    const tornParent = { body: tornBody, signature: sign(null, recurrenceStandingSigningBytes(tornBody), keys.privateKey).toString("base64") }
    const tornKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${store.projectToken}/${stableToken(`profile\0native\0${tornDocument.id}`, 40)}`
    const tornHead = { version: 1, scope: tornScope, revision: 0, parent: tornParent,
      settledSequence: 0, lastArchiveDigest: null, child: null }
    put(`${tornKey}/parents/1`, tornParent)
    put(`${tornKey}/live`, tornHead)
    const denialBody = { ...tornBody, action: "pause" as const, epoch: 2, expectedRevision: 0,
      requestID: recurrenceHumanRequestID(tornDocument.id, 2, "pause") }
    const denial = { body: denialBody, signature: sign(null, recurrenceStandingSigningBytes(denialBody), keys.privateKey).toString("base64") }
    const tornDue = nativeRecurrenceDue(ctx, { ...placement, scheduleID: tornDocument.id })
    let transactions = 0
    beforeTransaction = () => {
      // Provider acquisition verifies its native frame first. Publish the torn
      // denial only at calendar reserve entry, AFTER authorize's async reads.
      if (++transactions === 2) put(`${tornKey}/parents/2`, denial)
    }
    await assert.rejects(tornDue(app, () => true, new AbortController().signal))
    beforeTransaction = undefined
    assert.equal(transactions, 2, "late denial reaches the synchronous calendar CAS fence")
    assert.deepEqual(await store.read(tornDocument.id), tornRunning, "late torn denial vetoes calendar reservation")
    await assert.rejects(tornDue(app, () => true, new AbortController().signal),
      (error: unknown) => error instanceof Error
        && (error as Error & { cause?: { code?: string } }).cause?.code === "authorization-blocked")
    assert.deepEqual(await store.read(tornDocument.id), tornRunning, "torn denial cannot reserve the calendar")
    assert.deepEqual([creations, sends, environment], [0, 0, ""], "zero native create/environment/message effects")
    // Exact original denial reconciliation remains possible; it grants no replay.
    put(`${tornKey}/live`, { ...tornHead, revision: 1, parent: denial })
    await store.setState(tornDocument.id, tornRunning.revision, "paused", () => true)
    assert.equal(await tornDue(app, () => true, new AbortController().signal), "inactive")
    assert.equal((await store.read(tornDocument.id))?.pending, null)
    assert.deepEqual([creations, sends, environment], [0, 0, ""])
    const observer: ReconcileNativePending = async (provider, nativeStorage, child, signal) => {
      signal.throwIfAborted()
      const doc = (await store.read("schedule"))!
      const journal = recurrencePassage(nativeStorage, doc, () => true).journal
      const snapshot = await journal.snapshot()
      if (!terminal || snapshot.missions.length !== 1 || snapshot.missions[0]?.status !== "completed"
        || snapshot.missions[0].id !== child.grant.missionID
        || child.effects.length !== 3 || child.effects.some(effect => effect.receipt?.outcome !== "applied")) {
        throw new Error("Native terminal evidence incomplete")
      }
      return { settlement: { grantID: child.grant.grantID, evidenceID: "evt_native_terminal", outcome: "completed",
        effects: child.effects.map(effect => effect.receipt!), nativeIdle: true,
        controlsSettled: true, notificationsSettled: true, derivedCallsEnded: true },
      assertCurrent: () => { signal.throwIfAborted(); provider.assertCurrent()
        if (!terminal) throw new Error("Native terminal evidence withdrawn")
        return true as const },
      }
    }
    const originLocation = { directory: location.directory, workspaceID: location.workspaceID, project: { ...location.project } }
    const origin = Proxy.revocable({ storage, location: originLocation, session: { staleGraph: "must not be captured" } }, {})
    const due = nativeRecurrenceDue(origin.proxy as unknown as Parameters<typeof nativeRecurrenceDue>[0], placement, observer, () => now)
    origin.revoke() // Retired full plugin context is inaccessible after construction.
    originLocation.directory = `${directory}-retired` as typeof location.directory
    originLocation.project.canonical = `${directory}-retired` as typeof location.project.canonical
    await Effect.runPromise(Effect.scoped(RcMap.get(map, ref)))
    await Effect.runPromise(RcMap.invalidate(map, ref))
    await writeFile(profile.configYamlPath, "server:\n  environmentVariables:\n    MARKER: fresh\n")
    await Effect.runPromiseWith(app)(startNativeRecurrenceClock(placement, due))
    fiber = Effect.runForkWith(app)([...jobs.values()][0]!.run)
    // The Job sleeps after accepted. Its native synthetic is the bounded entry receipt.
    await Promise.race([new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(interval); reject(new Error("Due admission did not complete")) }, 30_000)
      const interval = setInterval(() => { if (sends) { clearTimeout(timeout); clearInterval(interval); resolve() } }, 5)
    }), Effect.runPromise(Fiber.await(fiber)).then(exit => { throw new Error(`Due Job ended: ${JSON.stringify(exit)}`) })])
    const deadline = Date.now() + 30_000
    while ((await store.read("schedule"))?.pending?.admission?.kind !== "accepted" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(loads, 2)
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    assert.equal(environment, "fresh")
    const pending = await store.read("schedule")
    assert.equal(pending?.pending?.admission?.kind, "accepted")
    assert.equal(pending.pending.admission.conversationID, (rootSession as { id: string }).id)
    assert.equal(pending.pending.admission.messageID, pending.pending.passage.messageID)
    assert.equal(pending.history.length, 0, "native admission is not terminal archival")
    const acceptedLedger = get(`${ledgerKey}/live`) as { child: { grant: { coordinatorSessionID: string; messageID: string };
      effects: { receipt: { outcome: string } | null }[] } }
    assert.equal(acceptedLedger.child.grant.coordinatorSessionID, (rootSession as { id: string }).id)
    assert.equal(acceptedLedger.child.grant.messageID, pending.pending.passage.messageID)
    assert.deepEqual(acceptedLedger.child.effects.map(effect => effect.receipt?.outcome), ["applied", "applied", "applied"])
    // The first Job invocation is complete. Drive subsequent minute/day ticks
    // through its SAME callback without a competing fixture fiber acquiring a
    // newer native nonce while the earlier check is still in flight.
    await Effect.runPromise(Fiber.interrupt(fiber))
    assert.equal(await nativeRecurrenceDue(ctx, placement)(app, () => true, new AbortController().signal), "pending",
      "the real observer refuses unfinished native work; no invented completed receipt")
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    const journalStorage = { get: async (key: string) => get(key) as never,
      set: async (key: string, value: unknown) => { put(key, value) },
      scan: async (options: { prefix: string; after?: string; limit?: number }) =>
        Effect.runPromise(storage.scan({ ...options, limit: options.limit ?? 100 })) as never }
    await recurrencePassage(journalStorage, pending, () => true).journal.append({ version: 1, id: "evt_finished",
      type: "mission.finished", missionID: pending.pending.admission.missionID, projectID: "project",
      createdAt: now, outcome: "completed", summary: "Native terminal evidence" })
    terminal = true
    assert.equal(await nativeRecurrenceDue(ctx, placement)(app, () => true, new AbortController().signal), "pending",
      "a completed journal without native execution/event evidence cannot settle")
    failFinishOnce = true
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal((await store.read("schedule"))?.pending?.passage.id, pending.pending.passage.id,
      "a crash after authority archive cannot silently clear the calendar")
    assert.equal((get(`${ledgerKey}/live`) as { child: unknown }).child, null)
    assert.equal(await due(app, () => true, new AbortController().signal), "not-due",
      "the exact immutable archive completes metadata without observing or replaying native effects")
    const finished = (await store.read("schedule"))!
    assert.equal(finished.pending, null)
    assert.equal(finished.history.length, 1)
    assert.equal(creations, 1)
    assert.equal(sends, 1)
    now += 86_400_000
    assert.equal(await due(app, () => true, new AbortController().signal), "accepted")
    assert.equal(creations, 2)
    assert.equal(sends, 2)
    const next = (await store.read("schedule"))!
    assert.equal(next.pending?.admission?.kind, "accepted")
    assert.notEqual(next.pending.passage.id, pending.pending.passage.id)
    await recurrencePassage(journalStorage, next, () => true).journal.append({ version: 1, id: "evt_finished",
      type: "mission.finished", missionID: next.pending.admission.missionID, projectID: "project",
      createdAt: now, outcome: "completed", summary: "Next native terminal evidence" })
    assert.equal(await due(app, () => true, new AbortController().signal), "not-due")
    assert.equal((await store.read("schedule"))?.settledCount, 2)
    now += 86_400_000
    const cancelledDispatch = new AbortController()
    afterNativeCreate = () => {
      // This native create already passed its single-use call-entry fence.
      // Commit signed Pause BEFORE returning its typed positive native ACK.
      const hot = get(`${ledgerKey}/live`) as Record<string, unknown>
      const paused = { ...body, action: "pause" as const, epoch: 2, expectedRevision: hot.revision as number,
        requestID: recurrenceHumanRequestID("schedule", 2, "pause") }
      const pausedParent = { body: paused, signature: sign(null, recurrenceStandingSigningBytes(paused), keys.privateKey).toString("base64") }
      const sourceKey = `${"codenomad-missions/recurrence-v1"}/project/${store.projectToken}/schedule`
      const fresh = get(sourceKey) as Record<string, unknown>
      db.exec("BEGIN IMMEDIATE")
      try {
        put(`${ledgerKey}/parents/2`, pausedParent)
        put(`${ledgerKey}/live`, { ...hot, revision: (hot.revision as number) + 1, parent: pausedParent })
        put(sourceKey, { ...fresh, revision: (fresh.revision as number) + 1, state: "paused" })
        db.exec("COMMIT")
      } catch (error) { db.exec("ROLLBACK"); throw error }
      queueMicrotask(() => cancelledDispatch.abort("Pause cancelled the due Job"))
    }
    assert.equal(await due(app, () => true, cancelledDispatch.signal), "unknown",
      "Pause after native entry blocks subsequent start/message, not the positive create ACK")
    assert.equal(cancelledDispatch.signal.aborted, true)
    afterNativeCreate = undefined
    const pausedSource = (await store.read("schedule"))!
    assert.equal(pausedSource.state, "paused")
    assert.equal(pausedSource.pending?.admission, null)
    const pausedLedger = get(`${ledgerKey}/live`) as { child: { effects: { effect: { kind: string }; receipt: { outcome: string } | null }[] } }
    assert.deepEqual(pausedLedger.child.effects.map(effect => [effect.effect.kind, effect.receipt?.outcome ?? null]),
      [["create", "applied"]], "the original positive native return is committed under the advanced signed epoch")
    terminal = false
    assert.equal(await due(app, () => true, new AbortController().signal), "pending")
    assert.equal(creations, 3)
    assert.equal(sends, 2)
    await Effect.runPromise(Fiber.interrupt(fiber))
    jobs.clear() // The native service restarted: in-memory Job is gone; no startup auto-arm.
    assert.equal(await Effect.runPromiseWith(app)(readNativeRecurrenceClock(placement)), false)
    assert.equal(jobs.size, 0)
  } finally {
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
    await Effect.runPromise(Scope.close(lifetime, Exit.void))
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
