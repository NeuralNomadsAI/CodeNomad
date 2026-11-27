import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { ROUTER_OPTIONS } from "../routed-path"
import { registerSessionAutomationsRoutes } from "./session-automations"

const rawAutomation = (overrides: Record<string, unknown> = {}) => ({
  id: "aut_1",
  name: "Check CI status",
  projectID: "proj_1",
  directory: "/repo/worktree",
  sessionID: "ses_a",
  trigger: { type: "every", every: "5 minutes", tz: "Europe/Paris" },
  tz: "Europe/Paris",
  action: { type: "prompt", prompt: "Check the workflow status", to: { session: "ses_a" } },
  status: "active",
  nextDueAt: 1_800_000_000_000,
  runCount: 2,
  lastRunAt: 1_799_999_700_000,
  lastOutcome: "fired",
  lastOutput: "All green",
  state: { attempts: 2 },
  time: { created: 1_799_990_000_000, updated: 1_799_999_700_000 },
  extraInternalField: "dropped",
  ...overrides,
})

function fixture() {
  const app = Fastify({ routerOptions: ROUTER_OPTIONS })
  const calls: Array<{ method: string; url: string; directoryHeader?: string }> = []
  const state = {
    owned: true,
    missing: false,
    carrierOwned: false,
    carrierError: undefined as unknown,
    session: { id: "ses_a", projectID: "proj_1", location: { directory: "/repo/worktree" } } as any,
    current: () => {},
    fetch: async (url: URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? "GET", url: url.toString(), directoryHeader: headers.get("x-opencode-directory") ?? undefined })
      if (url.pathname === "/api/experimental/automation" && (init?.method ?? "GET") === "GET") {
        return Response.json({
          data: [
            rawAutomation(),
            rawAutomation({ id: "aut_foreign", sessionID: "ses_other", name: "Foreign" }),
          ],
        })
      }
      if (url.pathname === "/api/experimental/automation/aut_1" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: rawAutomation() })
      }
      if (url.pathname === "/api/experimental/automation/aut_foreign" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: rawAutomation({ id: "aut_foreign", sessionID: "ses_other" }) })
      }
      if (url.pathname === "/api/experimental/automation/aut_1/pause" && init?.method === "POST") {
        return Response.json({ data: rawAutomation({ status: "paused" }) })
      }
      if (url.pathname === "/api/experimental/automation/aut_1/resume" && init?.method === "POST") {
        return Response.json({ data: rawAutomation({ status: "active" }) })
      }
      if (url.pathname === "/api/experimental/automation/aut_1" && init?.method === "DELETE") {
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    },
  }
  const workspace = { id: "w" }
  const location = { directory: "/repo/worktree" }
  const client = {
    session: { get: async () => { if (state.missing) throw new Error("not found"); return structuredClone(state.session) } },
    rpc: () => ({
      scheduleCarrierRead: async () => {
        if (state.carrierError !== undefined) throw state.carrierError
        return { owned: state.carrierOwned }
      },
    }),
  }
  registerSessionAutomationsRoutes(app, {
    workspaceManager: {
      get: () => workspace,
      getServiceLocation: () => location,
      ownsLocation: async () => state.owned,
      getSharedServiceConnection: async () => ({
        client,
        endpoint: { url: "http://localhost:3000", password: "fixture" },
        assertCurrent: () => state.current(),
        fetch: (url: URL, init?: RequestInit) => state.fetch(url, init),
      }) as any,
    } as any,
  })
  return { app, state, calls }
}

test("lists only the Session's own automations in its Location and strips internal fields", async () => {
  const f = fixture()
  try {
    const response = await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    const body = response.json()
    assert.equal(body.status, "ok")
    assert.equal(body.automations.length, 1)
    assert.deepEqual(body.automations[0], {
      id: "aut_1",
      name: "Check CI status",
      status: "active",
      trigger: { type: "every", every: "5 minutes", tz: "Europe/Paris" },
      tz: "Europe/Paris",
      action: { type: "prompt", prompt: "Check the workflow status", target: { session: "ses_a" } },
      runCount: 2,
      nextDueAt: 1_800_000_000_000,
      lastRunAt: 1_799_999_700_000,
      lastOutcome: "fired",
      lastOutput: "All green",
      stateJson: JSON.stringify({ attempts: 2 }, null, 2),
      createdAt: 1_799_990_000_000,
      updatedAt: 1_799_999_700_000,
    })
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0]!.url, /\/api\/experimental\/automation\?directory=%2Frepo%2Fworktree&sessionID=ses_a$/)
    assert.equal(f.calls[0]!.directoryHeader, "%2Frepo%2Fworktree")
  } finally { await f.app.close() }
})

test("maps 404/405/501 to unsupported and invalid or failed responses to unavailable", async () => {
  const f = fixture()
  try {
    for (const status of [404, 405, 501]) {
      f.state.fetch = async () => new Response(null, { status })
      assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).json(), { status: "unsupported" })
    }
    for (const responder of [
      async () => new Response(null, { status: 500 }),
      async () => Response.json({ data: [{ id: "bad" }] }),
      async () => { throw new Error("socket hang up") },
    ]) {
      f.state.fetch = responder
      const response = await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { status: "unavailable" })
    }
  } finally { await f.app.close() }
})

test("rejects invalid, missing, or foreign sessions before calling OpenCode", async () => {
  const f = fixture()
  try {
    for (const id of ["abc", "ses", "ses a"]) {
      assert.equal((await f.app.inject({ method: "GET", url: `/api/workspaces/w/sessions/${encodeURIComponent(id)}/automations` })).statusCode, 400)
    }
    f.state.missing = true
    assert.equal((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).statusCode, 404)
    f.state.missing = false
    f.state.owned = false
    assert.equal((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).statusCode, 403)
    assert.equal(f.calls.length, 0)
  } finally { await f.app.close() }
})

test("pause, resume and delete verify automation session ownership before mutating", async () => {
  const f = fixture()
  try {
    const pause = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/pause" })
    assert.equal(pause.statusCode, 200)
    assert.equal(pause.json().status, "ok")
    assert.equal(pause.json().automation.status, "paused")

    const resume = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/resume" })
    assert.equal(resume.statusCode, 200)
    assert.equal(resume.json().automation.status, "active")

    const del = await f.app.inject({ method: "DELETE", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1" })
    assert.equal(del.statusCode, 200)
    assert.deepEqual(del.json(), { status: "ok" })

    const foreignCallsBefore = f.calls.length
    const foreign = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_foreign/pause" })
    assert.equal(foreign.statusCode, 403)
    assert.equal(f.calls.length, foreignCallsBefore + 1, "inspects once and refuses before pause")

    const invalid = await f.app.inject({ method: "DELETE", url: "/api/workspaces/w/sessions/ses_a/automations/bad_id" })
    assert.equal(invalid.statusCode, 400)
  } finally { await f.app.close() }
})

test("a moved session or revoked connection publishes unavailable on read and refuses mutation", async () => {
  const f = fixture()
  try {
    const originalFetch = f.state.fetch
    f.state.fetch = async (url, init) => {
      f.state.session.location = { directory: "/repo/moved" }
      return originalFetch(url, init)
    }
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).json(), { status: "unavailable" })

    f.state.session.location = { directory: "/repo/worktree" }
    f.state.fetch = async (url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        f.state.current = () => { throw new Error("Replaced connection") }
      }
      return originalFetch(url, init)
    }
    const callsBefore = f.calls.length
    const mutated = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/pause" })
    assert.equal(mutated.statusCode, 502)
    assert.equal(f.calls.length, callsBefore + 1, "does not dispatch pause after revocation")
  } finally { await f.app.close() }
})

test("rejects Mission schedule carriers and indeterminate carrier ownership on list and mutations", async () => {
  const f = fixture()
  try {
    f.state.carrierOwned = true
    assert.equal((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).statusCode, 403)
    assert.equal((await f.app.inject({ method: "DELETE", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1" })).statusCode, 403)
    assert.equal(f.calls.length, 0)

    f.state.carrierOwned = false
    f.state.session = {
      id: "ses_a",
      projectID: "proj_1",
      location: { directory: "/repo/worktree" },
      metadata: { "codenomad.schedule-carrier": { missionID: "msn_1" } },
    }
    assert.equal((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).statusCode, 403)
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/pause" })).statusCode, 403)
    assert.equal(f.calls.length, 0)

    f.state.session = { id: "ses_a", projectID: "proj_1", location: { directory: "/repo/worktree" } }
    f.state.carrierError = new Error("rpc transport down")
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })).json(), { status: "unavailable" })
    assert.equal((await f.app.inject({ method: "DELETE", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1" })).statusCode, 503)
    assert.equal(f.calls.length, 0)
  } finally { await f.app.close() }
})

test("blocks cross-project and cross-directory automations for the same session and flags upstream errors", async () => {
  const f = fixture()
  try {
    const crossProject = rawAutomation({ id: "aut_other_proj", sessionID: "ses_a", projectID: "proj_other", directory: "/repo/worktree" })
    const crossDir = rawAutomation({ id: "aut_other_dir", sessionID: "ses_a", projectID: "proj_1", directory: "/other/project" })
    f.state.fetch = async (url, init) => {
      f.calls.push({ method: init?.method ?? "GET", url: url.toString() })
      if (url.pathname === "/api/experimental/automation") {
        return Response.json({ data: [rawAutomation(), crossProject, crossDir] })
      }
      if (url.pathname === "/api/experimental/automation/aut_other_proj" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: crossProject })
      }
      if (url.pathname === "/api/experimental/automation/aut_other_dir" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: crossDir })
      }
      if (url.pathname === "/api/experimental/automation/aut_1" && (init?.method ?? "GET") === "GET") {
        return Response.json({ data: rawAutomation() })
      }
      if (url.pathname === "/api/experimental/automation/aut_1/pause") {
        return Response.json({ message: "Upstream lock active" }, { status: 500 })
      }
      if (url.pathname === "/api/experimental/automation/aut_1/resume") {
        return new Response(null, { status: 500 })
      }
      return new Response(null, { status: 404 })
    }

    const listed = await f.app.inject({ method: "GET", url: "/api/workspaces/w/sessions/ses_a/automations" })
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(listed.json().automations.map((a: { id: string }) => a.id), ["aut_1"])

    const callsBefore = f.calls.length
    assert.equal((await f.app.inject({ method: "DELETE", url: "/api/workspaces/w/sessions/ses_a/automations/aut_other_proj" })).statusCode, 403)
    assert.equal((await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_other_dir/pause" })).statusCode, 403)
    assert.equal(f.calls.length, callsBefore + 2, "inspects only and refuses before mutating foreign project/directory")

    const upstreamErr = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/pause" })
    assert.equal(upstreamErr.statusCode, 502)
    assert.deepEqual(upstreamErr.json(), { status: "error", error: "Upstream lock active", upstream: true })

    const fallbackErr = await f.app.inject({ method: "POST", url: "/api/workspaces/w/sessions/ses_a/automations/aut_1/resume" })
    assert.equal(fallbackErr.statusCode, 502)
    assert.equal(fallbackErr.json().upstream, undefined)
  } finally { await f.app.close() }
})
