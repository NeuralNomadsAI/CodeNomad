// Opt-in end-to-end qualification of Remote Control through the hosted
// OpenTunnel relay. It creates a public, certificate-logged hostname under a
// throwaway profile and data directory, serves only fixture content, and
// deletes that tunnel afterwards. Never uses the device's shared identity.
//
//   CODENOMAD_REMOTE_CONTROL_LIVE=1 node --import tsx --test packages/server/scripts/remote-control-live.test.ts
import assert from "node:assert/strict"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { openRemoteTunnel } from "@codenomad/remote-tunnel"
import { startRemoteSurface } from "../src/remote-control/test-support/surface"

const live = process.env.CODENOMAD_REMOTE_CONTROL_LIVE === "1"
const PROFILE = "codenomad-live-qualify"

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method ?? "GET", headers: options.headers, agent: false }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on("error", reject)
    req.setTimeout(30_000, () => req.destroy(new Error("timed out")))
    req.end(options.body)
  })
}

async function removeThrowawayTunnel(dataHome: string): Promise<void> {
  // The facade never deletes identities; the qualification uses the SDK directly.
  // Resolved from the adapter package, wherever npm placed the SDK (nested or hoisted).
  const lookup = createRequire(new URL("../../remote-tunnel/package.json", import.meta.url)).resolve.paths("@opentunnel/client") ?? []
  const root = lookup.map((directory) => path.join(directory, "@opentunnel", "client")).find((directory) => fs.existsSync(directory))
  if (!root) throw new Error("OpenTunnel SDK not found for throwaway tunnel removal")
  const { create, OpenTunnelStorage } = await import(pathToFileURL(path.join(root, "dist", "promise", "index.js")).href)
  const client = create({ store: OpenTunnelStorage.xdg({ env: { ...process.env, XDG_DATA_HOME: dataHome } }) })
  try {
    await client.tunnel.remove({ profile: PROFILE })
  } finally {
    await client.dispose()
  }
}

test("Remote Control serves CodeNomad end to end through the hosted relay", { skip: !live && "set CODENOMAD_REMOTE_CONTROL_LIVE=1", timeout: 600_000 }, async (t) => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-remote-live-"))
  let surface: Awaited<ReturnType<typeof startRemoteSurface>> | undefined
  try {
    surface = await startRemoteSurface(t, { openTunnel: (options) => openRemoteTunnel({ ...options, profile: PROFILE, dataHome }) })
    const origin = new URL(surface.pairing.url).origin

    const unpaired = await request(`${origin}/`, { headers: { accept: "text/html" } })
    assert.equal(unpaired.status, 302)
    assert.equal(unpaired.headers.location, "/remote-pair")
    assert.equal((await request(`${origin}/remote-pair`)).status, 200)

    const paired = await request(`${origin}/api/remote-control/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code: surface.code }),
    })
    assert.equal(paired.status, 200, paired.body)
    const setCookie = String(paired.headers["set-cookie"])
    assert.match(setCookie, /^__Host-codenomad_device=.*; Secure; HttpOnly;/)
    const cookie = setCookie.split(";")[0]!

    const ui = await request(`${origin}/`, { headers: { cookie, accept: "text/html" } })
    assert.equal(ui.status, 200)
    assert.match(ui.body, /CodeNomad UI/)
    assert.deepEqual(JSON.parse((await request(`${origin}/api/test/echo`, { headers: { cookie } })).body).loopbackPrivileges, false)

    // A live stream ends when its device is revoked.
    await new Promise<void>((resolve, reject) => {
      const req = https.get(`${origin}/api/test/stream`, { headers: { cookie }, agent: false }, (res) => {
        assert.equal(res.statusCode, 200)
        res.once("data", () => surface!.manager.revokeDevice(surface!.manager.devices()[0]!.id))
        res.on("close", () => resolve())
        res.on("error", () => resolve())
        res.resume()
      })
      req.on("error", () => resolve())
      setTimeout(() => reject(new Error("stream outlived revocation")), 30_000).unref()
    })
    assert.equal((await request(`${origin}/api/test/echo`, { headers: { cookie } })).status, 401)

    await surface.manager.stop()
    await assert.rejects(request(`${origin}/api/test/echo`, { headers: { cookie } }))
  } finally {
    await surface?.manager.shutdown()
    await removeThrowawayTunnel(dataHome)
    fs.rmSync(dataHome, { recursive: true, force: true })
  }
})
