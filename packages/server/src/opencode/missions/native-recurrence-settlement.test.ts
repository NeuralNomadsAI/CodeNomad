import assert from "node:assert/strict"
import test from "node:test"
import { authorityDigest, canonicalAuthority } from "../../missions/authority-protocol"
import { recurrenceMessageID, recurrencePassageID, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { controlOperationID, controlReceiptID } from "../../missions/receipt-identity"
import { stableToken, type MissionStorage } from "../../missions/journal"
import type { RecurrenceChildRecord } from "../../missions/recurrence-authority-contract"
import type { NativeRecurrenceAuthorityProvider } from "./native-authority-provider"
import { observeNativeRecurrenceSettlement, observeNativeRecurrenceTerminalSettlement } from "./native-recurrence-settlement"

test("finite terminal observation keeps success strict and records bounded admitted provider execution failure", async () => {
  const projectID = "project", projectCanonical = "/owned/project", scheduleID = "schedule"
  const due = { kind: "manual" as const,
    requestID: "request", expectedRevision: 0, at: 10 }
  const passageID = recurrencePassageID(stableToken(`${projectID}\0${projectCanonical}`, 24), scheduleID, 0, due)
  const missionID = `msn_${stableToken(`${projectID}\0${passageID}`, 24)}`
  const coordinatorSessionID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
  const messageID = recurrenceMessageID(passageID)
  const config = { template: "custom" as const, consigne: "Finish", clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "host",
    roots: [{ mode: "git", directory: projectCanonical, checkout: projectCanonical, family: projectCanonical }],
    profiles: { coordinator: { agent: "build", model: { providerID: "fixture", id: "model" } },
      roles: { specialist: { agent: "build", model: { providerID: "fixture", id: "model" } } } },
    taskMode: "native", watchedConversationIDs: [], publication: { policy: "disabled", conversationIDs: [] } } as const
  const source: RecurrenceDocument = { version: 1, projectID, projectCanonical, id: scheduleID,
    revision: 2, scheduleRevision: 0, createdAt: 10, state: "running", config: config as unknown as RecurrenceDocument["config"],
    settledCount: 0, cursors: [], lastDaily: null, history: [], pending: {
      passage: { id: passageID, messageID, createdAt: 10, scheduleRevision: 0, due },
      admission: { kind: "accepted", passageID, messageID, missionID, conversationID: coordinatorSessionID },
    } }
  const grant = { grantID: "rgrant_test", missionID, coordinatorSessionID, messageID,
    passage: source.pending!.passage }
  const child = { parent: { body: { config }, signature: "test" }, grant, effects: [
    { operationID: "create", effect: { kind: "create" }, receipt: { operationID: "create", outcome: "applied", evidenceID: coordinatorSessionID } },
    { operationID: "start", effect: { kind: "start" }, receipt: { operationID: "start", outcome: "applied", evidenceID: coordinatorSessionID } },
    { operationID: "message", effect: { kind: "coordinator-message", messageID, contentDigest: authorityDigest(config.consigne) },
      receipt: { operationID: "message", outcome: "applied", evidenceID: messageID } },
  ] } as unknown as RecurrenceChildRecord
  const values = new Map<string, unknown>()
  const storage: MissionStorage = {
    get: async key => values.get(key) as never,
    set: async (key, value) => { values.set(key, value) },
    scan: async ({ prefix, after, limit }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
      .sort(([left], [right]) => left.localeCompare(right)).slice(0, limit)
      .map(([key, value]) => ({ key, value: value as never })) }),
  }
  const journal = recurrencePassage(storage, source, () => true).journal
  const operationID = controlOperationID(missionID, passageID)
  const recurrence = { grantID: grant.grantID, passageID, messageID, coordinatorSessionID }
  const metadata = { "codenomad.mission": { version: 1, missionID, kind: "lifecycle", taskMode: "native",
    operationID, recurrence } }
  await journal.append({ version: 1, id: "evt_created", type: "mission.created", projectID, missionID,
    createdAt: 10, projectCanonical, objective: "Finish", template: "custom", requestID: passageID,
    prepared: true, coordinator: { sessionID: coordinatorSessionID, title: "Root", location: { directory: projectCanonical } } })
  await journal.append({ version: 1, id: operationID, type: "mission.control-requested", projectID, missionID,
    createdAt: 10, expectedRevision: 1, requestID: passageID, action: "start", recurrence,
    targets: [{ sessionID: coordinatorSessionID, location: { directory: projectCanonical } }] })
  await journal.append({ version: 1, id: controlReceiptID(operationID, coordinatorSessionID),
    type: "mission.control-applied", projectID, missionID, createdAt: 10,
    operationID, sessionID: coordinatorSessionID,
    nativeAcknowledgement: { missionID, operationID, sessionID: coordinatorSessionID, action: "start",
      disposition: "start-admitted", admission: { id: messageID, sessionID: coordinatorSessionID, type: "synthetic",
        delivery: "queue", time: { created: 10 }, payload: { text: config.consigne, metadata } } } })
  await journal.append({ version: 1, id: "evt_finished", type: "mission.finished", projectID, missionID,
    createdAt: 11, outcome: "completed", summary: "Finished" })
  const events = [
    { type: "session.created.1", data: { sessionID: coordinatorSessionID } },
    { type: "session.inbox.enqueued.1", data: { sessionID: coordinatorSessionID, inboxID: messageID,
      item: { type: "synthetic", payload: { text: config.consigne, metadata } } } },
    { type: "session.execution.started.1", data: { sessionID: coordinatorSessionID } },
    { type: "session.inbox.delivered.1", data: { sessionID: coordinatorSessionID, inboxID: messageID } },
    { type: "session.execution.succeeded.1", data: { sessionID: coordinatorSessionID } },
  ].map((event, seq) => ({ id: `evt_${seq}`, seq, type: event.type, data: JSON.stringify(event.data) }))
  const session = { id: coordinatorSessionID, parent_id: null, project_id: projectID,
    directory: projectCanonical, workspace_id: null, metadata: JSON.stringify({ "codenomad.mission": {
      version: 1, missionID, kind: "coordinator", role: "coordinator" } }), time_suspended: null }
  let currentHead = events.length - 1, queueCount = 0, pendingCount = 0, checks = 0, children = false
  let journalHead = "first"
  let requests: { sessionID: string; kind: "form" | "permission" }[] = []
  let childRead: Record<string, unknown> | undefined
  let rootMessages: { id: string; type: string; data: string }[] = []
  const provider = { store: { scope: { projectID, projectCanonical, scheduleID } }, sourceKey: "source",
    location: { projectID, directory: projectCanonical }, readCurrent: () => source, assertCurrent: () => true as const,
    readSession: (id: string) => id !== coordinatorSessionID ? childRead : ({ session, seq: currentHead, ownerID: null, inbox: queueCount, pending: pendingCount,
      events: events.slice(0, currentHead + 1), messages: rootMessages,
      message: { id: messageID, session_id: coordinatorSessionID, type: "synthetic", data: JSON.stringify({ text: config.consigne, metadata }) } }),
    assertNoPendingRequests: async (owned: string[]) => {
      assert.equal(requests.some(request => owned.includes(request.sessionID) || request.sessionID === "global"), false, "owned pending request cannot settle")
      return true as const
    },
    readJournalWatermark: () => journalHead,
    passageStorage: () => storage,
    assertNoSessionChildren: () => { assert.equal(children, false, "unknown native family cannot settle"); return true as const },
    assertJournalWatermark: (_passageID: string, expected: string) => {
      assert.equal(expected, journalHead, "a changed Mission journal cannot borrow a completed snapshot")
      return true as const
    },
    assertSessionWatermarks: (items: { seq: number }[]) => {
      checks++
      assert.equal(items[0].seq, currentHead, "new native input before final BEGIN IMMEDIATE must veto the archive")
      if (childRead) assert.equal(items.length, 2, "a child also owns a native watermark")
      assert.equal(queueCount, 0)
      return true as const
    },
  } as unknown as NativeRecurrenceAuthorityProvider
  const observe = () => observeNativeRecurrenceSettlement(provider, storage, child, new AbortController().signal)
  let result = await observe()
  assert.equal(result.settlement.outcome, "completed")
  assert.equal(result.settlement.evidenceID, "evt_4")
  result.assertCurrent()
  assert.equal(checks, 1)
  requests = [{ sessionID: "ses_unrelated", kind: "form" }]
  assert.equal((await observe()).settlement.outcome, "completed", "unrelated human Form is not passage work")
  requests = [{ sessionID: coordinatorSessionID, kind: "permission" }]
  await assert.rejects(observe(), /owned pending request/)
  requests = []
  queueCount = 1
  assert.throws(result.assertCurrent, /native input|0/)
  queueCount = 0
  journalHead = "changed"
  assert.throws(result.assertCurrent, /Mission journal/)
  journalHead = "first"
  // A new model-owned request after the async queue read needs a new owned
  // execution/input; its native head cannot borrow the old terminal receipt.
  currentHead++
  assert.throws(result.assertCurrent, /native input/)
  currentHead--
  events[4] = { ...events[4], type: "session.execution.interrupted.1" }
  await assert.rejects(observe(), /observation-unavailable/)
  events[4] = { ...events[4], type: "session.execution.succeeded.1" }
  const original = JSON.parse((provider.readSession(coordinatorSessionID, messageID).message?.data ?? "{}") as string)
  assert.equal(canonicalAuthority(original.metadata), canonicalAuthority(metadata))
  result = await observe()
  assert.equal(result.assertCurrent(), true)

  const childID = "ses_child", prompt = "Investigate", tool = { sessionID: childID, status: "completed" }
  rootMessages = [{ id: "msg_assistant", type: "assistant", data: JSON.stringify({ content: [{ type: "tool", id: "call_child",
    name: "subagent", executed: false, state: { status: "completed", input: { prompt, agent: "build",
      description: "Investigate" }, metadata: tool } }] }) }]
  events.splice(4, 1,
    { id: "evt_4", seq: 4, type: "session.tool.called.1", data: JSON.stringify({ sessionID: coordinatorSessionID,
      assistantMessageID: "msg_assistant", id: "call_child", executed: false }) },
    { id: "evt_5", seq: 5, type: "session.tool.success.2", data: JSON.stringify({ sessionID: coordinatorSessionID,
      assistantMessageID: "msg_assistant", id: "call_child", executed: false, metadata: tool }) },
    { id: "evt_6", seq: 6, type: "session.execution.succeeded.1", data: JSON.stringify({ sessionID: coordinatorSessionID }) })
  currentHead = 6
  const childEvents = [
    { type: "session.created.1", data: { sessionID: childID, parentID: coordinatorSessionID } },
    { type: "session.inbox.enqueued.1", data: { sessionID: childID, inboxID: "msg_child",
      item: { type: "user", payload: { text: `You are a subagent spawned by another session.\n${prompt}` } } } },
    { type: "session.execution.started.1", data: { sessionID: childID } },
    { type: "session.inbox.delivered.1", data: { sessionID: childID, inboxID: "msg_child" } },
    { type: "session.execution.succeeded.1", data: { sessionID: childID } },
  ].map((event, seq) => ({ id: `evt_child_${seq}`, seq, type: event.type, data: JSON.stringify(event.data) }))
  childRead = { session: { ...session, id: childID, parent_id: coordinatorSessionID }, seq: 4,
    ownerID: null, inbox: 0, pending: 0, events: childEvents,
    messages: [{ id: "msg_child", type: "user", data: JSON.stringify({ text: `You are a subagent spawned by another session.\n${prompt}` }) }] }
  result = await observe()
  assert.equal(result.settlement.evidenceID, "evt_6")
  assert.equal(result.assertCurrent(), true)
  childEvents[4].type = "session.execution.interrupted.1"
  await assert.rejects(observe(), /observation-unavailable/)

  // The original start was admitted and all three startup effects were APPLIED.
  // Its execution failed with no native tool work. This asserts no HTTP/billing
  // claim: native retry-full requests can precede the first durable Step.
  for (const [key, value] of values) if ((value as { type?: string }).type === "mission.finished") values.delete(key)
  childRead = undefined
  events.splice(4)
  const failed = { id: "evt_failure", seq: 4, type: "session.execution.failed.1",
    data: JSON.stringify({ sessionID: coordinatorSessionID, error: { type: "provider.no-route", message: "Model unavailable" } }) }
  events.push(failed)
  currentHead = 4
  rootMessages = [{ id: messageID, type: "synthetic", data: JSON.stringify({ text: config.consigne, metadata }) }]
  const terminalObserve = () => observeNativeRecurrenceTerminalSettlement(provider, storage, child, new AbortController().signal)
  await assert.rejects(observe(), /observation-unavailable/, "the original succeeded-only observer never accepts a failure")
  for (const type of ["unknown", "tool.execution", "provider.not-native"]) {
    events[4] = { ...failed, data: JSON.stringify({ sessionID: coordinatorSessionID, error: { type, message: "Outside the deliberately supported native coded subset" } }) }
    await assert.rejects(terminalObserve(), /observation-unavailable/)
  }
  events[4] = failed
  for (const type of ["session.tool.called.1", "session.tool.input.started.1", "session.tool.failed.2",
    "session.shell.started.1", "session.step.started.1", "session.execution.interrupted.1"]) {
    events.splice(4, 1, { id: "evt_partial", seq: 4, type, data: JSON.stringify({ sessionID: coordinatorSessionID,
      assistantMessageID: "msg_running", id: "call_running", executed: false }) }, { ...failed, seq: 5 })
    currentHead = 5
    await assert.rejects(terminalObserve(), /observation-unavailable/, "partial/running work must remain pending")
    events.splice(4, 2, failed)
    currentHead = 4
  }
  assert.equal((await journal.snapshot()).missions[0].status, "active", "negative observations write no fabricated result")
  queueCount = 1
  await assert.rejects(terminalObserve(), /observation-unavailable/)
  queueCount = 0
  pendingCount = 1
  await assert.rejects(terminalObserve(), /observation-unavailable/)
  pendingCount = 0
  session.time_suspended = 1 as never
  await assert.rejects(terminalObserve(), /observation-unavailable/)
  session.time_suspended = null
  children = true
  await assert.rejects(terminalObserve(), /native family/)
  children = false
  for (const kind of ["form", "permission"] as const) {
    requests = [{ sessionID: coordinatorSessionID, kind }]
    await assert.rejects(terminalObserve(), /pending request/)
  }
  requests = [{ sessionID: "global", kind: "form" }]
  await assert.rejects(terminalObserve(), /pending request/)
  requests = []
  const receipt = child.effects[2].receipt
  child.effects[2].receipt = null
  await assert.rejects(terminalObserve(), /observation-unavailable/)
  child.effects[2].receipt = receipt
  result = await terminalObserve()
  assert.equal(result.settlement.outcome, "failed")
  assert.deepEqual(result.settlement.effects.map(effect => effect.outcome), ["applied", "applied", "applied"],
    "admitted execution failure is not rejected-before-effect")
  assert.equal(result.settlement.evidenceID, "evt_failure")
  assert.equal(result.assertCurrent(), true)
  const recorded = (await journal.events()).events.find(event => event.type === "mission.finished")
  assert.ok(recorded?.type === "mission.finished")
  assert.equal(recorded.outcome, "failed")
  assert.equal(recorded.summary, "provider.no-route", "only a bounded native code is copied; diagnostic URLs/tokens stay native")
  assert.deepEqual(recorded.nativeFailure, { operationID, sessionID: coordinatorSessionID, messageID, evidenceID: "evt_failure",
    inputDigest: authorityDigest(config.consigne) })
  assert.equal((await journal.snapshot()).missions[0].reports.length, 0, "native failure is not an invented task report")
  assert.equal((await terminalObserve()).settlement.evidenceID, "evt_failure", "journal-only tear reconciles the original failure")
  assert.equal((await journal.events()).events.length, 4)
  requests = [{ sessionID: "global", kind: "form" }]
  assert.equal(result.assertCurrent(), true, "a late global Form has no native passage session/message/call provenance")
  requests = []
  children = true
  assert.throws(result.assertCurrent, /native family/, "a late unregistered child fences publication")
  children = false
  const previousFailure = recorded.nativeFailure
  recorded.nativeFailure = { ...previousFailure!, operationID: "foreign_operation" }
  for (const [key, value] of values) if ((value as { type?: string }).type === "mission.finished") values.set(key, recorded)
  await assert.rejects(terminalObserve(), /observation-unavailable/, "a mismatched durable control identity cannot borrow native failure")
})
