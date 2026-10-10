import assert from "node:assert/strict"
import test from "node:test"
import type { FastifyRequest } from "fastify"
import { HUMAN_ANSWER_HEADER } from "../../missions/human-answer"
import { replyMissionHumanAnswer } from "./mission-human-answer"
import { Socket } from "node:net"
import { markRemoteSocket } from "../../remote-control/request-origin"

type Deps = Parameters<typeof replyMissionHumanAnswer>[4]
type Connection = Parameters<typeof replyMissionHumanAnswer>[5]
const directory = "/project"

function harness(options: { mission: boolean; auth: boolean; replyError?: boolean; remote?: boolean }) {
  const calls = { binding: 0, reply: 0 }
  const sessions: Record<string, object> = {
    ses_child: { id: "ses_child", parentID: "ses_root", location: { directory } },
    ses_root: { id: "ses_root", location: { directory },
      metadata: options.mission ? { "codenomad.mission": { version: 1, missionID: "msn_1" } } : {} },
  }
  const client = {
    session: { get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] },
    rpc: () => ({
      binding: async (input: { sessionID: string; formID: string; profileID: string; executionHost: string }) => {
        calls.binding++
        return { ...input, projectID: "project", location: { directory } }
      },
      reply: async () => {
        calls.reply++
        if (options.replyError) throw new Error("lost reply")
        return { status: "answered" }
      },
    }),
  }
  const workspace = { id: "workspace" }
  const human = options.remote ? { sessionId: "remote-device:phone", username: "person" }
    : options.auth ? { sessionId: "cookie", username: "person" } : { sessionId: "auth-disabled", username: "local" }
  const socket = new Socket()
  if (options.remote) markRemoteSocket(socket)
  const deps = {
    auth: { isAuthEnabled: () => options.auth, getSessionFromRequest: () => human },
    manager: { get: () => workspace, getServiceWslDistro: () => undefined, ownsLocation: async () => true },
    settings: { getProfileScope: () => ({ key: "profile", channel: "c", configIdentity: "i" }) },
    bridgeToken: "token",
  } as unknown as Deps
  const connection = { client, assertCurrent: () => true } as unknown as Connection
  const request = { headers: { [HUMAN_ANSWER_HEADER]: "1" }, body: { answer: { q0: "yes" } }, raw: { socket } } as unknown as FastifyRequest
  const reply = () => replyMissionHumanAnswer(request, "workspace", "ses_child", "frm_1", deps, connection, new AbortController().signal)
  return { calls, reply }
}

test("a Form outside any Mission family uses the ordinary reply and writes no mark, with auth enabled or disabled", async () => {
  for (const auth of [true, false]) {
    const h = harness({ mission: false, auth })
    assert.equal(await h.reply(), undefined, `auth ${auth}`)
    assert.deepEqual(h.calls, { binding: 0, reply: 0 })
  }
})

test("a Mission Form takes the mark path when authenticated", async () => {
  const h = harness({ mission: true, auth: true })
  assert.deepEqual(await h.reply(), { status: "answered" })
  assert.deepEqual(h.calls, { binding: 1, reply: 1 })
})

test("a Mission Form falls back to the ordinary reply without a mark when auth is disabled", async () => {
  const h = harness({ mission: true, auth: false })
  assert.equal(await h.reply(), undefined)
  assert.deepEqual(h.calls, { binding: 0, reply: 0 })
})

test("a paired Remote Control device answers a Mission Form through the ordinary reply, never an unverifiable mark", async () => {
  const h = harness({ mission: true, auth: true, remote: true })
  assert.equal(await h.reply(), undefined)
  assert.deepEqual(h.calls, { binding: 0, reply: 0 }, "nothing dispatched, so the proxy forwards the ordinary native reply")
})

test("only a dispatched mark reply is uncertain and never falls back to a second native answer", async () => {
  const h = harness({ mission: true, auth: true, replyError: true })
  await assert.rejects(h.reply(), /lost reply/)
  assert.deepEqual(h.calls, { binding: 1, reply: 1 })
})
