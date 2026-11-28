import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerBackgroundShellRoutes } from "./background-shells"
import { ownedShellDirectory } from "../../opencode/background-shells"

test("background inventory excludes foreground shells and authorizes the session, not its cwd", async t => {
  const app = Fastify()
  t.after(() => app.close())
  let supported = true, reads = 0
  const host = "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"
  const shells = ["foreground", "background", "foreign"].map(id => ({ id, cwd: "/tmp/build", metadata: { sessionID: id } }))
  const client = {
    experimental: {
      job: {
        list: async (input: { kind?: string; status?: string }, options?: { signal?: AbortSignal }) => {
          reads++
          assert.deepEqual(input, { kind: "shell", status: "running" })
          assert.ok(options?.signal instanceof AbortSignal)
          if (!supported) throw new Error("OpenCode background job inventory is unavailable")
          return ["background", "foreign"].map(shellID => ({ kind: "shell", shellID }))
        },
      },
    },
    shell: { list: async ({ location }: { location: { directory: string } }) => {
      assert.equal(location.directory, "/repo")
      return { location: { directory: "/repo" }, data: shells }
    } },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "foreign" ? "/private" : "/repo" } }) },
  }
  const manager = {
    get: () => ({}),
    ownsDirectory: async (_id: string, path: string) => path === "/repo" || path === host,
    getServicePathForPath: async (_id: string, path: string) => path === host ? "/repo" : path,
    getSharedServiceConnection: async () => ({
      client, endpoint: { url: "http://localhost:3000", password: "fixture" }, assertCurrent() {},
    }),
  }
  registerBackgroundShellRoutes(app, manager as any)
  const url = "/api/workspaces/project/background-shells?directory=%2Frepo"
  const result = await app.inject(url)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json().location, { directory: "/repo" })
  assert.deepEqual(result.json().data.map((s: any) => s.id), ["background"])
  const wsl = await app.inject(url.replace("%2Frepo", encodeURIComponent(host)))
  assert.equal(wsl.statusCode, 200)
  assert.deepEqual(wsl.json().location, { directory: "/repo" }, "return the native identity for WSL event matching")
  const count = reads
  assert.equal((await app.inject(url.replace("%2Frepo", "%2Fprivate"))).statusCode, 403)
  assert.equal(reads, count, "reject an unowned directory before native reads")
  supported = false
  assert.equal((await app.inject(url)).statusCode, 502, "missing job capability never falls back to foreground shells")
  assert.equal(await ownedShellDirectory({ metadata: {}, cwd: "/repo" } as any, client as any, async p => p === "/repo", new AbortController().signal), "/repo")
})
