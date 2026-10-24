import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { it } from "node:test"
import { routedPath } from "./routed-path"

// The path decoder of the router Fastify itself loads, wherever npm placed it.
const fastifyRequire = createRequire(createRequire(import.meta.url).resolve("fastify"))
const { safeDecodeURI } = fastifyRequire("find-my-way/lib/url-sanitizer") as {
  safeDecodeURI(path: string, useSemicolonDelimiter: boolean): { path: string }
}

it("returns exactly the path Fastify's router matches", () => {
  for (const target of [
    "/api/workspaces", "/%61pi/workspaces", "/%61%70%69/workspaces", "/%73idecars/id/", "/%77orkspaces/id/instance/api/x",
    "/api/x?y=1", "/%61pi/x?y=%2F", "/api/x;y", "/api;x/y", "/api/x%3By", "/api/auth%2Flogin", "/api%2Fauth/login",
    "/%2561pi/x", "/a%25b", "/a%2525b", "/previews/token/%2E%2E/x", "/%E2%82%AC", "/",
  ]) {
    assert.equal(routedPath(target), safeDecodeURI(target, true).path, target)
  }
})

it("refuses targets the router would reinterpret or reject", () => {
  for (const target of ["http://127.0.0.1/api/workspaces", "https://host/api", "//api/workspaces", "/api#x", "*", "", "/%E0%A4%A", "/%zz"]) {
    assert.equal(routedPath(target), null, target)
  }
})
