import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { Context, Effect, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import type { Plugin } from "@opencode/plugin/effect"
import type { MissionConfiguration } from "../../missions/launch-policy"
import { MISSION_DOCUMENT_PREFIX } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import { prevalidateAgentScheduledCoordinatorCreation } from "./native-scheduled-coordinator-adoption"

test("creation Effect prevalidation is read-only, guards native state and foreign documents, and preserves human admission", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close())
  db.exec(`CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,project_id TEXT,directory TEXT,workspace_id TEXT,
      metadata TEXT,time_suspended INTEGER,agent TEXT,model TEXT);
    CREATE TABLE session_inbox(id TEXT,session_id TEXT,enqueued_seq INTEGER,type TEXT);
    CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,data TEXT);
    CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,data TEXT);
    CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER);
    INSERT INTO session_v2(id,project_id,directory,agent) VALUES('ses_root','project','/project','worker');
    INSERT INTO event_sequence VALUES('ses_root',0)`)
  const current = () => true as const, signal = new AbortController().signal
  const location = Schema.decodeUnknownSync(Location.Info)({ directory: "/project", project: { id: "project", canonical: "/project", directory: "/project" } })
  const configuration: MissionConfiguration = { title: "Scheduled", objective: "Bounded work", template: "custom", taskMode: "native",
    roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [], profileID: "profile", executionHost: "local",
    coordinatorSessionID: "ses_root", profiles: { coordinator: { agent: "worker", model: { providerID: "fixture", id: "fixture" } },
      roles: { specialist: { agent: "worker", model: { providerID: "fixture", id: "fixture" } } } },
    launch: { when: [{ kind: "cron", expression: "0 * * * *", zone: "UTC" }] } }
  const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  const storage = {
    get: (key: string) => Effect.sync(() => {
      const row = db.prepare("SELECT value FROM kv WHERE key=?").get(nativeKey(key)) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    }),
    scan: ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => Effect.sync(() => {
      const rows = db.prepare("SELECT key,value FROM kv WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?")
        .all(nativeKey(prefix), nativeKey(prefix) + "\uffff", after ? nativeKey(after) : "", limit + 1) as { key: string; value: string }[]
      const entries = rows.slice(0, limit).map(row => ({ key: row.key.slice(nativeKey("").length), value: JSON.parse(row.value) }))
      return { entries, ...(rows.length > limit ? { next: entries.at(-1)!.key } : {}) }
    }),
  }
  const session = Schema.decodeUnknownSync(Session.Info)({ id: "ses_root", projectID: "project", location: { directory: "/project" },
    agent: "worker", model: { providerID: "fixture", id: "fixture" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
  let effects = 0, authorActive = false
  const unexpected = () => Effect.sync(() => { effects++; throw new Error("Unexpected native mutation") })
  const native = { get: () => Effect.succeed(session), active: Effect.sync(() => new Set(authorActive ? ["ses_root"] : [])),
    inbox: () => Effect.succeed([]), create: unexpected, environment: unexpected, prompt: unexpected, synthetic: unexpected }
  const tag = (key: string) => Context.Service<never, unknown>(key)
  const client = { unsafe: (sql: string, args: readonly unknown[]) => ({
    withoutTransform: Effect.sync(() => db.prepare(sql).all(...args as []).map(row => ({ ...row }))),
  }) }
  let graph = Context.make(tag("@opencode/storage/Database"), { db: { $client: client } })
  graph = Context.add(graph, tag("@opencode/Location"), location)
  graph = Context.add(graph, tag("@opencode/Session"), native)
  for (const name of ["Form", "Permission", "Shell"]) graph = Context.add(graph, tag(`@opencode/${name}`), { list: () => Effect.succeed([]) })
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const ctx = { location, storage } as unknown as Plugin.Context
  const input = { missionID: "new_schedule", configuration, author: { coordinatorSessionID: "ses_author" }, current, signal }
  const guard = await run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, input))
  assert.equal(guard(), true)
  assert.equal(effects, 0)
  assert.equal(db.prepare("SELECT count(*) AS count FROM kv").get()!.count, 0)
  db.exec("INSERT INTO session_inbox VALUES('msg_queued','ses_root',1,'user')")
  assert.throws(guard, /changed during preparation/)
  await assert.rejects(run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, input)), /coordinator-busy/)
  await assert.rejects(run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, { ...input, author: undefined,
    configuration: { ...configuration, coordinatorSelectionAuthor: input.author } })), /coordinator-busy/,
  "agent configuration retains idle-root safeguards on human-created documents")
  const human = await run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, { ...input, author: undefined }))
  assert.equal(human(), true, "explicit human adoption remains allowed while busy")
  const self = { coordinatorSessionID: "ses_root" }
  await assert.rejects(run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, { ...input, author: self })), /coordinator-busy/)
  db.exec("DELETE FROM session_inbox")
  authorActive = true
  db.exec(`INSERT INTO session_message VALUES('msg_tool','ses_root',1,'assistant',
    '{"content":[{"type":"tool","state":{"status":"running"}}]}')`)
  await assert.rejects(run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, input)), /coordinator-busy/)
  assert.equal((await run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, { ...input, author: self })))(), true)
  assert.equal((await run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, { ...input, author: undefined,
    configuration: { ...configuration, coordinatorSelectionAuthor: self } })))(), true, "the author can set its own root on an existing schedule")
  db.exec("DELETE FROM session_message WHERE id='msg_tool'")
  authorActive = false
  const creation = await run(prevalidateAgentScheduledCoordinatorCreation(ctx, run, input))
  const prefix = `${MISSION_DOCUMENT_PREFIX}/project/${stableToken("project\0/project", 24)}/missions/`
  db.prepare("INSERT INTO kv VALUES(?,?)").run(nativeKey(prefix + input.missionID), '{"revision":0}')
  assert.equal(creation(), true, "the own document CAS is excluded from foreign ownership")
  db.prepare("INSERT INTO kv VALUES(?,?)").run(nativeKey(prefix + "foreign"), '{"pending":true}')
  assert.throws(creation, /changed during preparation/)
  assert.equal(effects, 0)
})
