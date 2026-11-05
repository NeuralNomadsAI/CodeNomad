// prototype-1236: folder browsing on an explicit OpenCode server (R14).
import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { listServerFolders, parseServerFolderPath } from "./folders"
import { registerOpenCodeFolderRoutes } from "../../server/routes/opencode-folders"
import { ServerConnectionError } from "./connections"

const native = (directory: string, data: Array<{ path: string; type: "file" | "directory" }>) => {
  const calls: unknown[] = []
  return { calls, list: async (input?: unknown) => { calls.push(input); return { location: { directory }, data } } }
}

test("lists only folders of an absolute path, named from native relative entries, with its parent", async () => {
  const server = native("/home/me", [
    { path: "../../srv/app", type: "directory" }, { path: "../../srv/notes.txt", type: "file" },
    { path: "../../srv/.git", type: "directory" }, { path: "../../srv/app", type: "directory" },
  ])
  const answer = await listServerFolders(server.list, "/srv/")
  assert.deepEqual(server.calls, [{ path: "/srv/" }])
  assert.deepEqual(answer.entries.map(entry => [entry.name, entry.path, entry.absolutePath]), [["app", "/srv/app", "/srv/app"], [".git", "/srv/.git", "/srv/.git"]])
  assert.deepEqual(answer.metadata, { scope: "unrestricted", currentPath: "/srv", parentPath: "/", rootPath: "/",
    homePath: "/home/me", displayPath: "/srv", pathKind: "absolute" })
})

test("opens the default location without a path, and stops at the root", async () => {
  const home = native("/home/me", [{ path: "work", type: "directory" }])
  const opened = await listServerFolders(home.list, undefined)
  assert.deepEqual(home.calls, [undefined])
  assert.equal(opened.metadata.currentPath, "/home/me")
  assert.equal(opened.entries[0]?.path, "/home/me/work")
  const root = await listServerFolders(native("/home/me", []).list, "/")
  assert.equal(root.metadata.parentPath, undefined)
  const drive = await listServerFolders(native("C:\\Users\\me", [{ path: "..\\..\\Projects", type: "directory" }]).list, "C:\\")
  assert.equal(drive.metadata.parentPath, undefined)
  assert.equal(drive.metadata.rootPath, "C:\\")
  assert.equal(drive.entries[0]?.path, "C:\\Projects")
})

test("a server refusing a path outside its location is asked for that folder as a location", async () => {
  const calls: unknown[] = []
  const list = async (input?: any) => {
    calls.push(input)
    if (input?.path) throw new Error("outside location")
    return { location: { directory: input.location.directory }, data: [{ path: "api", type: "directory" as const }] }
  }
  const answer = await listServerFolders(list, "/srv")
  assert.deepEqual(calls, [{ path: "/srv" }, { location: { directory: "/srv" } }])
  assert.equal(answer.entries[0]?.path, "/srv/api")
})

test("only absolute bounded paths are accepted", () => {
  assert.equal(parseServerFolderPath(undefined), undefined)
  assert.equal(parseServerFolderPath(""), undefined)
  assert.equal(parseServerFolderPath("/srv"), "/srv")
  assert.equal(parseServerFolderPath("D:/work"), "D:/work")
  for (const value of ["relative", "../up", "~/home", "/a\0b", "x".repeat(5_000)]) assert.throws(() => parseServerFolderPath(value))
})

test("the route lists through the server's shared connection and maps refusals to fixed codes", async t => {
  const app = Fastify()
  t.after(() => app.close())
  const connected: string[] = []
  const server = native("/home/me", [{ path: "app", type: "directory" }])
  registerOpenCodeFolderRoutes(app, { connections: () => ({
    connect: async (id: string) => {
      connected.push(id)
      if (id === "gone") throw new ServerConnectionError("unknown_server")
      if (id === "offline") throw new ServerConnectionError("disconnected")
      return { client: { file: { list: server.list } } }
    },
  }) as never })
  const ok = await app.inject({ method: "GET", url: "/api/opencode-folders?serverId=oc-1&path=/home/me" })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json().entries.map((entry: any) => entry.path), ["/home/me/app"])
  assert.equal((await app.inject({ method: "GET", url: "/api/opencode-folders?serverId=oc-1&path=relative" })).statusCode, 400)
  assert.equal((await app.inject({ method: "GET", url: "/api/opencode-folders?serverId=local-shared" })).statusCode, 400)
  assert.equal((await app.inject({ method: "GET", url: "/api/opencode-folders?serverId=gone" })).statusCode, 404)
  assert.equal((await app.inject({ method: "GET", url: "/api/opencode-folders?serverId=offline" })).statusCode, 503)
  assert.deepEqual(connected, ["oc-1", "gone", "offline"])
})
