import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { it } from "node:test"
import type { FastifyInstance } from "fastify"
import pino from "pino"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../remote-control/test-support/surface"
import { createRemoteProxyApp } from "./remote-proxy"
import { routedPath, type RouterOptions } from "./routed-path"
import { resolveHttpsOptions } from "./tls"

// The path decoder of the router Fastify itself loads, wherever npm placed it.
const fastifyRequire = createRequire(createRequire(import.meta.url).resolve("fastify"))
const { safeDecodeURI } = fastifyRequire("find-my-way/lib/url-sanitizer") as {
  safeDecodeURI(path: string, useSemicolonDelimiter: boolean): { path: string }
}

const TARGETS = [
  "/api/workspaces", "/%61pi/workspaces", "/%61%70%69/workspaces", "/%73idecars/id/", "/%77orkspaces/id/instance/api/x",
  "/api/x?y=1", "/%61pi/x?y=%2F", "/api/x;y", "/api;x/y", "/api/x%3By", "/api/auth%2Flogin", "/api%2Fauth/login",
  "/%2561pi/x", "/a%25b", "/a%2525b", "/previews/token/%2E%2E/x", "/%E2%82%AC", "/",
  "/api/auth/status;x", "/api/x/a;b",
]

/** The semicolon setting an application's router was built with, which must be explicit. */
function semicolonDelimiter(routerOptions: RouterOptions | undefined): boolean {
  const configured = routerOptions?.useSemicolonDelimiter
  assert.equal(typeof configured, "boolean", "the application sets routerOptions.useSemicolonDelimiter")
  return configured === true
}

/** Reports the route that ran and the parameters the router extracted. */
const probe = async (request: { routeOptions: { url?: string }; params: unknown }) => ({ route: request.routeOptions.url, params: request.params })

async function assertParity(name: string, routerOptions: RouterOptions | undefined, inject: (url: string) => Promise<{ statusCode: number; body: string }>) {
  const delimiter = semicolonDelimiter(routerOptions)
  for (const target of TARGETS) assert.equal(routedPath(target), safeDecodeURI(target, delimiter).path, `${name} ${target}`)
  const probed = await inject("/api/x/a;b")
  assert.equal(probed.statusCode, 200, `${name} ${probed.body}`)
  assert.equal(`/api/x/${JSON.parse(probed.body).params.id}`, routedPath("/api/x/a;b"), name)
}

it("returns exactly the path each CodeNomad application's router matches", async (t) => {
  let main: FastifyInstance | undefined
  await startRemoteSurface(t, { skipAuth: true, routes: (app) => { main = app; app.get("/api/x/:id", probe) } })
  assert.ok(main)
  const application = main
  await assertParity("application", application.initialConfig.routerOptions, (url) => application.inject({ url }))

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-routed-path-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const tls = resolveHttpsOptions({ enabled: true, configDir: directory, host: "127.0.0.1", logger: pino({ level: "silent" }) })
  assert.ok(tls)
  const remoteProxy = createRemoteProxyApp(tls.httpsOptions)
  t.after(() => remoteProxy.close())
  remoteProxy.get("/api/auth/status", probe)
  remoteProxy.get("/api/x/:id", probe)
  await remoteProxy.ready()
  await assertParity("remote proxy", remoteProxy.initialConfig.routerOptions, (url) => remoteProxy.inject({ url }))
  const status = await remoteProxy.inject({ url: "/api/auth/status;x" })
  assert.equal(status.json().route, routedPath("/api/auth/status;x"))
  // The application's own status route answers the target admission judged public.
  const plain = await application.inject({ url: "/api/auth/status" })
  const delimited = await application.inject({ url: "/api/auth/status;x" })
  assert.equal(delimited.statusCode, 200, delimited.body)
  assert.deepEqual(delimited.json(), plain.json())
})

// Speaks plain HTTP to the Remote Control ingress, as its TLS terminator does.
function remoteGet(target: string, pathname: string): Promise<{ status: number; body: string }> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port: Number(port), path: pathname, headers: { host: FAKE_TUNNEL_HOST } }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on("error", reject)
    request.end()
  })
}

it("Remote Control admits a semicolon target only as the public route it routes to", async (t) => {
  const { target } = await startRemoteSurface(t)
  for (const pathname of ["/api/auth/status", "/api/auth/status;x"]) {
    const reply = await remoteGet(target(), pathname)
    assert.equal(reply.status, 200, `${pathname} ${reply.body}`)
    assert.deepEqual(JSON.parse(reply.body), { authenticated: false, pairingRequired: true }, pathname)
  }
  assert.equal((await remoteGet(target(), "/api/test/echo;x")).status, 401)
})

it("refuses targets the router would reinterpret or reject", () => {
  for (const target of ["http://127.0.0.1/api/workspaces", "https://host/api", "//api/workspaces", "/api#x", "*", "", "/%E0%A4%A", "/%zz"]) {
    assert.equal(routedPath(target), null, target)
  }
})
