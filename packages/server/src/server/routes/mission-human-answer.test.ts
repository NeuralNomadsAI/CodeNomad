import assert from "node:assert/strict"
import test from "node:test"
import type { FastifyRequest } from "fastify"
import { HUMAN_ANSWER_HEADER, humanAnswerProofSchema } from "../../missions/human-answer"
import { replyMissionHumanAnswer, verifyMissionHumanAnswer } from "./mission-human-answer"
import { Socket } from "node:net"
import { attachRemoteDevice, markRemoteSocket } from "../../remote-control/request-origin"

type Deps = Parameters<typeof replyMissionHumanAnswer>[4]
type Connection = Parameters<typeof replyMissionHumanAnswer>[5]
const directory = "/project"

function harness(options: { mission?: boolean; journal?: boolean; auth: boolean; replyError?: boolean; bindingError?: boolean
  remote?: "paired" | "unpaired"; remoteDevices?: boolean; onBinding?(state: { authorized: boolean; current: boolean; owned: boolean }): void }) {
  const calls = { binding: [] as Array<Record<string, unknown>>, reply: [] as Array<{ body: Record<string, unknown> }> }
  const state = { authorized: true, current: true, owned: true }
  const sessions: Record<string, object> = {
    ses_child: { id: "ses_child", parentID: "ses_root", location: { directory } },
    ses_root: { id: "ses_root", location: { directory },
      metadata: options.mission ? { "codenomad.mission": { version: 1, missionID: "msn_1" } } : {} },
  }
  const client = {
    session: { get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] },
    rpc: () => ({
      binding: async (input: { sessionID: string; formID: string; profileID: string; executionHost: string; rootSessionID?: string }) => {
        calls.binding.push(input)
        options.onBinding?.(state)
        if (options.bindingError) throw new Error("plugin unavailable")
        const { rootSessionID, ...binding } = input
        // The native plugin answers null for a metadata-less root outside the durable journal.
        if (rootSessionID !== undefined && !options.journal) return null
        return { ...binding, projectID: "project", location: { directory } }
      },
      reply: async (input: { body: Record<string, unknown> }) => {
        calls.reply.push(input)
        if (options.replyError) throw new Error("lost reply")
        return { status: "answered" }
      },
    }),
  }
  const workspace = { id: "workspace" }
  const socket = new Socket()
  if (options.remote) markRemoteSocket(socket)
  const request = { headers: { [HUMAN_ANSWER_HEADER]: "1" }, body: { answer: { q0: "yes" } }, raw: { socket } } as unknown as FastifyRequest
  if (options.remote === "paired") attachRemoteDevice(request, "device-1")
  const human = options.remote ? (options.remote === "paired" ? { sessionId: "remote-device:device-1", username: "person" } : null)
    : options.auth ? { sessionId: "cookie", username: "person" } : { sessionId: "auth-disabled", username: "local" }
  const deps = {
    auth: { isAuthEnabled: () => options.auth, getSessionFromRequest: () => human },
    manager: { get: () => workspace, getServiceWslDistro: () => undefined, ownsLocation: async () => state.owned },
    settings: { getProfileScope: () => ({ key: "profile", channel: "c", configIdentity: "i" }) },
    bridgeToken: "token",
    ...(options.remoteDevices === false ? {} : { remoteDevices: { isDeviceAuthorized: (id: string) => id === "device-1" && state.authorized } }),
  } as unknown as Deps
  const connection = { client, assertCurrent: () => { if (!state.current) throw new Error("Connection replaced") } } as unknown as Connection
  const reply = () => replyMissionHumanAnswer(request, "workspace", "ses_child", "frm_1", deps, connection, new AbortController().signal)
  return { calls, reply, state }
}

test("an ordinary conversation asks the native binding once and writes no mark", async () => {
  const h = harness({ auth: true })
  assert.equal(await h.reply(), undefined)
  assert.deepEqual(h.calls.binding.map(call => call.rootSessionID), ["ses_root"])
  assert.equal(h.calls.reply.length, 0)
})

test("a Mission root with metadata takes the mark path without a journal consult", async () => {
  const h = harness({ mission: true, auth: true })
  assert.deepEqual(await h.reply(), { status: "answered" })
  assert.equal(h.calls.binding[0].rootSessionID, undefined)
  assert.deepEqual(h.calls.reply[0].body.principal, { kind: "cookie", sessionID: "cookie" })
})

test("an attached existing coordinator without metadata qualifies through durable journal membership", async () => {
  const h = harness({ journal: true, auth: true })
  assert.deepEqual(await h.reply(), { status: "answered" })
  assert.equal(h.calls.binding[0].rootSessionID, "ses_root", "the native plugin confirms exact journal membership")
  assert.equal(h.calls.reply.length, 1)
})

test("local answers without an authenticated cookie session never consult the plugin", async () => {
  for (const mission of [true, false]) {
    const h = harness({ mission, auth: false })
    assert.equal(await h.reply(), undefined)
    assert.deepEqual(h.calls, { binding: [], reply: [] })
  }
})

test("a paired, authorized Remote Control device answers as its own device principal", async () => {
  for (const auth of [true, false]) {
    for (const mission of [true, false]) {
      const h = harness({ mission, journal: !mission, auth, remote: "paired" })
      assert.deepEqual(await h.reply(), { status: "answered" }, `auth ${auth} mission ${mission}`)
      const body = humanAnswerProofSchema.parse(h.calls.reply[0].body)
      assert.deepEqual(body.principal, { kind: "remote-device", deviceID: "device-1" })
      assert.equal(JSON.stringify(body).includes("remote-device:"), false, "a device ID never poses as a cookie session")
    }
  }
})

test("unpaired, unauthorized or unwired remote requests fall back to the ordinary reply without dispatch", async () => {
  for (const options of [{ remote: "unpaired" as const }, { remote: "paired" as const, remoteDevices: false }]) {
    const h = harness({ mission: true, auth: true, ...options })
    assert.equal(await h.reply(), undefined)
    assert.deepEqual(h.calls, { binding: [], reply: [] })
  }
  const revoked = harness({ mission: true, auth: true, remote: "paired" })
  revoked.state.authorized = false
  assert.equal(await revoked.reply(), undefined)
  assert.deepEqual(revoked.calls, { binding: [], reply: [] })
})

test("revocation, session move or plugin error across native I/O fails closed before any mark reply", async () => {
  for (const change of [(state: { authorized: boolean }) => { state.authorized = false }]) {
    const h = harness({ mission: true, auth: true, remote: "paired", onBinding: change })
    assert.equal(await h.reply(), undefined)
    assert.equal(h.calls.binding.length, 1); assert.equal(h.calls.reply.length, 0)
  }
  const moved = harness({ mission: true, auth: true })
  moved.state.owned = false
  assert.equal(await moved.reply(), undefined)
  assert.deepEqual(moved.calls, { binding: [], reply: [] })
  const failing = harness({ mission: true, auth: true, remote: "paired", bindingError: true })
  assert.equal(await failing.reply(), undefined)
  assert.equal(failing.calls.reply.length, 0)
})

test("a connection replaced during preparation rejects without forwarding any reply", async () => {
  const h = harness({ mission: true, auth: true, remote: "paired", onBinding: state => { state.current = false } })
  await assert.rejects(h.reply(), /Connection replaced/)
  assert.equal(h.calls.reply.length, 0)
})

test("only a dispatched mark reply is uncertain and never falls back to a second native answer", async () => {
  const h = harness({ mission: true, auth: true, replyError: true })
  await assert.rejects(h.reply(), /lost reply/)
  assert.equal(h.calls.binding.length, 1); assert.equal(h.calls.reply.length, 1)
})

test("the bridge verifier revalidates the exact principal kind against live authority", async () => {
  const location = { directory }
  let authorized = true
  const workspace = { id: "workspace" }
  const connection = { client: { session: { get: async () => ({ id: "ses_child", projectID: "project", location }) } }, assertCurrent: () => {} }
  const deps = (auth: boolean) => ({
    auth: { isAuthEnabled: () => auth, getCookieName: () => "c",
      getSessionFromHeaders: ({ cookie }: { cookie: string }) => cookie === "c=cookie" ? { sessionId: "cookie", username: "person" } : null },
    manager: { get: () => workspace, getServiceWslDistro: () => undefined, getSharedServiceConnection: async () => connection, ownsLocation: async () => true },
    settings: { getProfileScope: () => ({ key: "profile" }) },
    remoteDevices: { isDeviceAuthorized: (id: string) => id === "device-1" && authorized },
  }) as never
  const body = (principal: unknown) => ({ sessionID: "ses_child", formID: "frm_1", projectID: "project", location, profileID: "profile",
    executionHost: "local", workspaceID: "workspace", principal, username: "person", answer: { q0: "yes" }, issuedAt: Date.now() })
  const signal = new AbortController().signal
  const device = { kind: "remote-device", deviceID: "device-1" }
  // Remote Control authenticates devices even when local login is skipped.
  for (const auth of [true, false]) assert.deepEqual(await verifyMissionHumanAnswer(body(device), deps(auth), signal), { admitted: true })
  assert.deepEqual(await verifyMissionHumanAnswer(body({ kind: "cookie", sessionID: "cookie" }), deps(true), signal), { admitted: true })
  await assert.rejects(verifyMissionHumanAnswer(body({ kind: "cookie", sessionID: "cookie" }), deps(false), signal))
  await assert.rejects(verifyMissionHumanAnswer(body({ kind: "remote-device", deviceID: "device-2" }), deps(true), signal))
  // A device ID presented as a cookie session is not a cookie session.
  await assert.rejects(verifyMissionHumanAnswer(body({ kind: "cookie", sessionID: "remote-device:device-1" }), deps(true), signal))
  await assert.rejects(verifyMissionHumanAnswer({ ...body(device), cookieSessionID: "cookie" }, deps(true), signal))
  authorized = false
  await assert.rejects(verifyMissionHumanAnswer(body(device), deps(true), signal), "a revoked device no longer qualifies")
})
