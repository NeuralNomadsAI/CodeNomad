import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import Fastify from "fastify"
import { DEVICE_COOKIE_NAME, gateRemoteRequest } from "./gate"
import { isLocalRequest, markRemoteSocket, remoteDeviceOf } from "./request-origin"
import { SERVER_PAIR_PATH } from "./server-pairing"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const origin = `https://${FAKE_TUNNEL_HOST}`
const headers = { host: FAKE_TUNNEL_HOST, cookie: `${DEVICE_COOKIE_NAME}=credential`, "x-codenomad-server-request": "1" }

test("memory stays host-only on Remote Control ingress and requires authenticated device protocol on direct transport", async t => {
  for (const ingress of [false, true]) {
    const app = Fastify()
    t.after(() => app.close())
    app.addHook("onRequest", (request, reply, done) => {
      if (ingress) markRemoteSocket(request.raw.socket)
      if (!gateRemoteRequest(request, reply, {
        publicHost: () => FAKE_TUNNEL_HOST,
        authenticate: token => token === "credential" ? { id: "device" } as never : null,
        assignDevice() {}, servesPreview: () => false,
      })) done()
    })
    app.all("/*", async () => ({ admitted: true }))
    for (const [method, url] of [["POST", "/api/memory"], ["GET", "/api/memory/settings"], ["PUT", "/api/memory/settings"]]) {
      assert.equal((await app.inject({ method: method as "GET", url, headers })).statusCode, ingress ? 404 : 200)
      assert.equal((await app.inject({ method: method as "GET", url, headers: { ...headers, cookie: "" } })).statusCode, ingress ? method === "GET" ? 404 : 403 : method === "GET" ? 401 : 403)
      if (ingress) assert.equal((await app.inject({ method: method as "GET", url, headers: { host: FAKE_TUNNEL_HOST, origin, cookie: headers.cookie } })).statusCode, 404)
    }
  }
})

function send(target: string, path: string, requestHeaders: Record<string, string>, body: unknown) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request(`http://${target}${path}`, { method: "POST", agent: false, headers: requestHeaders }, response => {
      let text = ""
      response.setEncoding("utf8").on("data", chunk => { text += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: text }))
    })
    request.on("error", reject)
    request.end(JSON.stringify(body))
  })
}

test("R3 browser pairing stays ingress-only with a valid device, server marker and public Origin", async t => {
  const f = await startRemoteSurface(t)
  const paired = await send(f.target(), SERVER_PAIR_PATH, {
    host: FAKE_TUNNEL_HOST, "x-codenomad-server-pairing": "1", "content-type": "application/json",
  }, { code: f.code, hostName: "review" })
  assert.equal(paired.status, 200)
  const credential = JSON.parse(paired.body).credential
  const next = f.manager.createPairing()
  const body = { code: new URL(next.url).hash.slice(1), name: "second" }
  const direct = await send(f.local, "/api/remote-control/pair", {
    cookie: `${DEVICE_COOKIE_NAME}=${credential}`, "x-codenomad-server-request": "1",
    origin, "content-type": "application/json",
  }, body)
  assert.equal(direct.status, 404)
  assert.equal(direct.headers["set-cookie"], undefined)
  // The refused direct request neither consumes the code nor breaks browser ingress.
  const browser = await send(f.target(), "/api/remote-control/pair", {
    host: FAKE_TUNNEL_HOST, origin, "content-type": "application/json",
  }, body)
  assert.equal(browser.status, 200)
  assert.ok(browser.headers["set-cookie"])
})

// Exercise the gate independently of endpoint handlers: an accidentally admitted
// route answers 200 here, rather than hiding behind the application's own 404.
for (const ingress of [false, true]) {
  test(`closed server-device route inventory (${ingress ? "ingress" : "direct"})`, async t => {
    const app = Fastify()
    t.after(() => app.close())
    app.addHook("onRequest", (request, reply, done) => {
      if (ingress) markRemoteSocket(request.raw.socket)
      if (!gateRemoteRequest(request, reply, {
        publicHost: () => FAKE_TUNNEL_HOST,
        authenticate: token => token === "credential" ? { id: "device" } as never : null,
        assignDevice() {}, servesPreview: () => false,
      })) done()
    })
    app.all("/*", async request => ({
      device: remoteDeviceOf(request), local: isLocalRequest(request),
      forwardedFor: request.headers["x-forwarded-for"] ?? null,
      remoteControl: request.headers["x-codenomad-remote-control"] ?? null,
    }))
    const allowed: Array<[string, string]> = [
      ["GET", "/api/auth/status"], ["HEAD", "/api/meta"], ["GET", "/api/events"],
      ["GET", "/api/remote-control/status"], ["POST", "/api/client-connections/pong"],
      ["GET", "/api/usage/openai"], ["GET", "/api/filesystem"], ["POST", "/api/filesystem/folders"],
      ["GET", "/api/filesystem/files/content"], ["GET", "/api/config-files"], ["PUT", "/api/config-files/user/content"],
      ["PATCH", "/api/storage/config/ui"], ["PATCH", "/api/storage/state/ui"], ["PUT", "/api/storage/instances/w"],
      ["POST", "/api/storage/binaries/validate"], ["POST", "/api/opencode/update"], ["POST", "/api/opencode/service"],
      ["POST", "/api/opencode/login-start"], ["GET", "/api/speech/capabilities"], ["POST", "/api/speech/transcribe"],
      ["POST", "/api/speech/synthesize/stream"], ["GET", "/api/sidecars"], ["PUT", "/api/sidecars/s"],
      ["POST", "/api/previews"], ["DELETE", "/api/previews/token"],
      ["GET", "/api/panel-extensions"], ["POST", "/api/panel-extensions/catalog/install"],
      ["PATCH", "/api/panel-extensions/org.panel"], ["GET", "/api/panel-extensions/org.panel/panel"],
      ...["assets", "assetRead", "workItems", "workItemUrl", "images", "imageRead", "imagesStatus", "prefillReferences",
        "conversationStatus", "conversationOpen", "conversationNew", "preferencesGet", "preferencesSet"]
        .map(method => ["POST", `/api/panel-extensions/org.panel/${method}`] as [string, string]),
      ["POST", "/api/workspaces"], ["DELETE", "/api/workspaces/w"], ["POST", "/api/workspaces/clone"],
      ["POST", "/api/workspaces/creation/cancel"], ["POST", "/api/workspaces/w/creation/release"],
      ["POST", "/api/workspaces/temporary"], ["POST", "/api/workspaces/temporary/abandon"],
      ...["keep", "discard", "git-init", "images-conversation"].map(path => ["POST", `/api/workspaces/w/${path}`] as [string, string]),
      ...["background-shells", "git-branches", "pending-requests", "files", "files/search", "files/preview", "files/content", "plugin-controls",
        "integrations", "service-usage", "service-usage/owner", "service-usage/cache"]
        .map(path => ["GET", `/api/workspaces/w/${path}`] as [string, string]),
      ["PUT", "/api/workspaces/w/files/content"], ["PATCH", "/api/workspaces/w/plugin-controls"],
      ["POST", "/api/workspaces/w/plugin-sources"], ["PUT", "/api/workspaces/w/provider-accounts/openai"],
      ...["websearch-settings", "image-settings", "subagent-depth"].map(path => ["PUT", `/api/workspaces/w/${path}`] as [string, string]),
      ...["hosts", "binding"].map(path => ["GET", `/api/workspaces/w/integrations/blender/${path}`] as [string, string]),
      ...["install", "attach", "detach", "install-host"].map(path => ["POST", `/api/workspaces/w/integrations/blender/${path}`] as [string, string]),
      ["POST", "/api/workspaces/w/worktrees"], ["DELETE", "/api/workspaces/w/worktrees/main"],
      ...["git-status", "git-diff", "git-history", "git-history/sha"].map(path => ["GET", `/api/workspaces/w/worktrees/main/${path}`] as [string, string]),
      ...["git-stage", "git-unstage", "git-commit"].map(path => ["POST", `/api/workspaces/w/worktrees/main/${path}`] as [string, string]),
      ["POST", "/api/workspaces/w/sessions/s/worktree"], ["GET", "/api/workspaces/w/sessions/s/goal"],
      ["GET", "/api/workspaces/w/sessions/s/permission-receipts"], ["GET", "/api/workspaces/w/session-media/s/m/p/0/digest"],
      ...["window", "outline", "outlinePreview", "query", "ranked", "prune"].map(path => ["POST", `/api/workspaces/w/session-history/${path}`] as [string, string]),
      ["POST", "/api/workspaces/w/session-pruning/prune"], ["GET", "/api/missions/playbooks"],
      ["POST", "/api/workspaces/w/missions"], ["POST", "/api/workspaces/w/missions/panel-page"],
      ["PATCH", "/api/workspaces/w/missions/m"], ["DELETE", "/api/workspaces/w/missions/m"],
      ...["content", "tasks", "admission"].map(path => ["GET", `/api/workspaces/w/missions/m/${path}`] as [string, string]),
      ...["control", "recover", "schedule", "schedule-settings"].map(path => ["POST", `/api/workspaces/w/missions/m/${path}`] as [string, string]),
      ["POST", "/api/workspaces/w/missions/scheduled"], ["GET", "/api/workspaces/w/missions/scheduled/capabilities"],
      ["GET", "/api/workspaces/w/missions/scheduled/requests/r"], ["POST", "/api/workspaces/w/missions/recurrence"],
      ...["current", "current/p/content", "run-now/status", "passages/p"].map(path => ["GET", `/api/workspaces/w/missions/recurrence/s/${path}`] as [string, string]),
      ...["current/p/page", "control", "control/status", "run-now"].map(path => ["POST", `/api/workspaces/w/missions/recurrence/s/${path}`] as [string, string]),
      ["GET", "/workspaces/w/yolo/sessions/s"], ["POST", "/workspaces/w/yolo/sessions/s/toggle"],
      ["POST", "/workspaces/w/instance/api/session/s/prompt"],
    ]
    for (const [method, url] of allowed) {
      const response = await app.inject({ method: method as "GET", url, headers: { ...headers, "x-forwarded-for": "127.0.0.1", "x-codenomad-remote-control": "0" } })
      assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`)
      if (method !== "HEAD") assert.deepEqual(response.json(), { device: "device", local: false, forwardedFor: null, remoteControl: null })
    }
    for (const url of ["/api/test/echo", "/api/unreviewed", "/api/workspaces/w/unreviewed", "/api/workspaces/w/files/delete",
      "/api/workspaces/w/missions/m/unreviewed", "/api/storage/config/ui/unreviewed", "/api/panel-extensions/org.panel/unreviewed",
      "/api/backends/nested/api/meta", "/api/auth/login", "/api/remote-control/pair", "/api/remote-control/start", "/sidecars/s/", "/unknown"]) {
      for (const method of ["GET", "POST"] as const) assert.equal((await app.inject({ method, url, headers })).statusCode, 404, `${method} ${url}`)
    }
    assert.equal((await app.inject({ method: "DELETE", url: "/api/meta", headers })).statusCode, 404)
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
      assert.equal((await app.inject({ method, url: "/api/workspaces/w/background-shells", headers })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url: "/api/workspaces/w/background-shells/unreviewed", headers })).statusCode, 404)
    assert.equal((await app.inject({ method: "POST", url: "/api/unreviewed", headers: { ...headers, "sec-fetch-mode": "cors" } })).statusCode, 403)
    assert.equal((await app.inject({ method: "DELETE", url: "/api/workspaces/w", headers: { ...headers, referer: "" } })).statusCode, 403)
    assert.equal((await app.inject({ method: "DELETE", url: "/api/workspaces/w", headers: { ...headers, origin } })).statusCode, 200)
  })
}
