import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readOpenCodeLogs } from "../opencode/logs"
import { backendAdmissionFixture, backendAuthorityHeader, backendBootstrap } from "./test-support/backend-admission"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "./test-support/surface"

const HTTPS = "https://logs.example.test"
const LAN = "http://logs-lan.example.test"
const REMOTE = `https://${FAKE_TUNNEL_HOST}`
type Caller = { target: string; headers: Record<string, string> }

function send(caller: Caller, pathname: string, payload?: unknown) {
  const url = new URL(`http://${caller.target}`)
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: pathname, agent: false,
      method: payload ? "POST" : "GET",
      headers: { host: url.host, ...caller.headers, ...(payload ? { "content-type": "application/json" } : {}) },
    }, response => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", chunk => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }))
      response.on("error", reject)
    })
    request.setTimeout(5_000, () => request.destroy(new Error("Logs request timed out")))
    request.on("error", reject)
    request.end(payload ? JSON.stringify(payload) : undefined)
  })
}

test("raw OpenCode logs stay host-only across authenticated remote channels before resolution, reads or relay IO",
  { timeout: 30_000 }, async t => {
    const backend = await backendAdmissionFixture(t)
    const directory = path.join(backend.directory, "private-logs")
    fs.mkdirSync(directory)
    const file = path.join(directory, "opencode.log")
    const marker = path.join(directory, "discoveries")
    const privatePath = path.join(directory, "private-workspace", "private-source.ts")
    const sentinels = ["Bearer synthetic-log-token", "password=synthetic-log-password", privatePath]
    const text = `${sentinels.join("\n")}\n`
    fs.writeFileSync(file, text)
    // The production route uses its real reader and documented CLI discovery.
    // A synthetic CLI keeps the check independent of an installed daemon.
    const binary = path.join(directory, process.platform === "win32" ? "opencode.cmd" : "opencode")
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    fs.writeFileSync(binary, process.platform === "win32"
      ? `@echo off\r\necho read>>"${marker}"\r\necho ${directory}\r\n`
      : `#!/bin/sh\nprintf 'read\\n' >> ${quote(marker)}\nprintf '%s\\n' ${quote(directory)}\n`,
    { mode: 0o700 })
    assert.deepEqual(await readOpenCodeLogs(binary), { path: file, text, truncated: false })
    const discoveries = () => fs.readFileSync(marker, "utf8")
    let resolutions = 0
    const surface = await startRemoteSurface(t, {
      settings: backend.settings, bindHost: "0.0.0.0", allowedOrigins: [HTTPS, LAN],
      workspaceManager: { resolveBinaryPath: () => { resolutions++; return binary } },
    })
    for (const remote of backend.remotes) {
      remote.state.overrides.set("/api/opencode/logs", { status: 200, body: { path: file, text, truncated: false } })
    }
    const session = (origin: string): Caller => ({
      target: surface.local, headers: { host: new URL(origin).host, origin,
        cookie: `${surface.authManager.getCookieName()}=${surface.authManager.createSession("codenomad").id}` },
    })
    const paired = await send({ target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE } },
      "/api/remote-control/pair", { code: surface.code })
    assert.equal(paired.status, 200, paired.body)
    const rc: Caller = { target: surface.target(), headers: { host: FAKE_TUNNEL_HOST, origin: REMOTE,
      cookie: paired.headers["set-cookie"]![0]!.split(";")[0]! } }
    const pairing = surface.manager.createDirectPairing(HTTPS)
    const directReply = await send({ target: surface.local, headers: { host: new URL(HTTPS).host, origin: HTTPS } },
      "/api/remote-control/pair", { code: new URL(pairing.url).hash.slice(1) })
    assert.equal(directReply.status, 200, directReply.body)
    const direct: Caller = { target: surface.local, headers: { host: new URL(HTTPS).host, origin: HTTPS,
      cookie: directReply.headers["set-cookie"]![0]!.split(";")[0]! } }
    const address = Object.values(os.networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)?.address
    assert.ok(address, "a real non-loopback interface is required")
    const lan: Caller = { ...session(LAN), target: `${address}:${new URL(`http://${surface.local}`).port}` }
    const noSource = session(HTTPS)
    delete noSource.headers.origin
    const callers = [
      ["RC browser", rc],
      ["RC server device", { ...rc, headers: { host: FAKE_TUNNEL_HOST, cookie: rc.headers.cookie!,
        "x-codenomad-server-request": "1" } }],
      ["HTTPS password session through loopback proxy", session(HTTPS)],
      ["HTTPS password session through loopback proxy without source headers", noSource],
      ["HTTPS origin-bound device through loopback proxy", direct],
      ["LAN password session", lan],
    ] as const
    for (const [label, caller] of callers) {
      // A valid proof prevents missing relay authority from hiding a logs admission regression.
      const bootstrap = await send({ ...caller, headers: { ...caller.headers,
        [backendAuthorityHeader]: backendBootstrap } }, "/api/backends/A/api/meta")
      const proof = bootstrap.headers[backendAuthorityHeader]
      if (label !== "RC server device") assert.equal(bootstrap.status, 200, bootstrap.body)
      for (const pathname of ["/api/opencode/logs", "/api/backends/A/api/opencode/logs"]) {
        await t.test(`${label}: ${pathname}`, async () => {
          const before = { resolutions, discoveries: discoveries(), io: backend.io() }
          const response = await send({ ...caller, headers: { ...caller.headers,
            ...(proof ? { [backendAuthorityHeader]: String(proof) } : {}) } }, pathname)
          assert.ok([403, 404].includes(response.status), `${response.status}: ${response.body}`)
          assert.equal(resolutions, before.resolutions, "refuse before resolving the host binary")
          assert.equal(discoveries(), before.discoveries, "refuse before discovering/reading the host log")
          assert.equal(backend.io(), before.io, "refuse before any upstream IO")
          for (const sentinel of [...sentinels, file]) {
            assert.equal(`${response.body}${JSON.stringify(response.headers)}`.includes(sentinel), false, sentinel)
          }
        })
      }
    }
    await t.test("authenticated originless native loopback retains direct raw logs", async () => {
      const local = session("http://localhost:0")
      const response = await send({ target: surface.local, headers: { cookie: local.headers.cookie! } }, "/api/opencode/logs")
      assert.equal(response.status, 200, response.body)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.deepEqual(JSON.parse(response.body), { path: file, text, truncated: false })
      assert.ok(resolutions >= 2, "the real route resolves and fences its source")
    })
  })
