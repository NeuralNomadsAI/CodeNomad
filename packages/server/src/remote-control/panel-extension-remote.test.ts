import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"
import { PanelExtensionStore } from "../panel-extensions/store"
import { readPanelExtensionArchive } from "../panel-extensions/archive"
import { fixtureArchive } from "../panel-extensions/archive-fixture"

const ORIGIN = `https://${FAKE_TUNNEL_HOST}`

function send(target: string, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const [hostname, port] = target.split(":")
  return new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
    const request = http.request({ hostname, port: Number(port), path: pathname, method: options.method ?? "GET",
      headers: { host: FAKE_TUNNEL_HOST, ...options.headers } }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] }))
    })
    request.on("error", reject)
    request.end(options.body)
  })
}

test("API 4 POSTs from a paired device need the public Origin; paired GETs pass; local-only prefixes stay 404", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-remote-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new PanelExtensionStore(directory)
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion: 4, permissions: ["session.context", "panel.preferences"] }))
  await store.install(pkg)
  await store.activate(pkg.manifest.id, pkg.digest, true)
  const manager = new Proxy({ get: (id: string) => id === "i" ? { id, path: "/repo" } : undefined } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? (() => undefined) })
  const { target, code } = await startRemoteSurface(t, { panelExtensions: { store, workspaceManager: manager } })
  const paired = await send(target(), "/api/remote-control/pair", { method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ code }) })
  assert.equal(paired.status, 200, paired.body)
  const cookie = paired.cookie!
  const body = JSON.stringify({ instanceId: "i", digest: pkg.digest, value: { imagesPerTurn: 2 } })
  const set = (headers: Record<string, string>) => send(target(), `/api/panel-extensions/${pkg.manifest.id}/preferencesSet`,
    { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body })

  assert.equal((await set({})).status, 403, "no Origin")
  assert.equal((await set({ origin: "https://other.tunnel.test" })).status, 403, "foreign Origin")
  const accepted = await set({ origin: ORIGIN })
  assert.equal(accepted.status, 200, accepted.body)
  assert.deepEqual(JSON.parse(accepted.body), { status: "saved" })
  assert.equal((await send(target(), "/api/panel-extensions", { headers: { cookie } })).status, 200)
  assert.equal((await send(target(), `/api/panel-extensions/${pkg.manifest.id}/preferencesGet`, { method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN }, body })).status, 401, "unpaired")
  for (const [method, pathname] of [["GET", "/api/remote-control/devices"], ["POST", "/api/opencode-plugin/automation"]] as const) {
    assert.equal((await send(target(), pathname, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}" })).status, 404, pathname)
  }
})
