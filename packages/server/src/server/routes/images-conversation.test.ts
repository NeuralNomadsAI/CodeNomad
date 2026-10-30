import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerImagesConversationRoute } from "./images-conversation"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ExcludeTarget, GitExclusion } from "../../workspaces/design-git-exclude"

const url = "/api/workspaces/w/images-conversation"
const model = { providerID: "fixture", id: "chosen" }
function fixture(options: { owned?: boolean; output?: unknown; fail?: boolean; distro?: string; exclusion?: GitExclusion; directory?: string } = {}) {
  const calls: any[] = []
  const excluded: ExcludeTarget[] = []
  const app = Fastify()
  const fence = new WorktreeDeletionFence()
  registerImagesConversationRoute(app, {
    worktreeDeletionFence: fence,
    excludeDesignFolder: async target => { excluded.push(target); return options.exclusion ?? "excluded" },
    workspaceManager: {
      getSharedServiceClient: async () => ({
        location: { get: async () => {
          if (options.directory === "") throw new Error("location not found")
          return { directory: options.directory ?? "/owned/repo", project: { id: "p" } }
        } },
        rpc: { call: async (input: unknown, opts: any) => {
          assert(opts.signal instanceof AbortSignal)
          calls.push(input)
          if (options.fail) throw new Error("method not found")
          return { output: options.output ?? { status: "found", sessionID: "ses_images", created: true } }
        } },
      }) as any,
      ownsLocation: async () => options.owned !== false,
      desktopPluginsReady: async () => {},
      getWorktreeIdentityForPath: async () => "/owned/repo",
      getServiceWslDistro: () => options.distro,
      getHostPathForServicePath: async (_id: string, servicePath: string) => `\\\\wsl.localhost\\Ubuntu${servicePath.replaceAll("/", "\\")}`,
    },
  })
  return { app, calls, excluded, fence }
}

test("open pins the fixed method, passes the caller's title, agent and model, then excludes the design folder", async () => {
  const { app, calls, excluded } = fixture()
  try {
    const payload = { directory: "/owned/repo", mode: "open", title: "Images", agent: "design", model }
    const response = await app.inject({ method: "POST", url, payload })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: "found", sessionID: "ses_images", created: true, gitExclusion: "excluded" })
    assert.deepEqual(calls, [{ rpcID: "codenomad.session-pruning", method: "imagesConversation",
      input: { mode: "open", title: "Images", agent: "design", model }, location: { directory: "/owned/repo" } }])
    assert.deepEqual(excluded.map(target => [target.directory, target.distro]), [["/owned/repo", undefined]])
  } finally { await app.close() }
})

test("a WSL location excludes through the owned distro and the host translation", async () => {
  const { app, excluded } = fixture({ distro: "Ubuntu", exclusion: "unavailable" })
  try {
    const response = await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "new", title: "Images" } })
    assert.equal(response.json().gitExclusion, "unavailable")
    assert.equal(excluded[0]!.distro, "Ubuntu")
    assert.equal(await excluded[0]!.toHost("/owned/repo/.git/info/exclude"), "\\\\wsl.localhost\\Ubuntu\\owned\\repo\\.git\\info\\exclude")
  } finally { await app.close() }
})

test("lookup, absent and unknown results never touch Git", async () => {
  for (const [mode, output] of [["lookup", { status: "found", sessionID: "s", created: false }], ["open", { status: "unknown" }], ["open", { status: "absent" }]] as const) {
    const { app, excluded } = fixture({ output })
    try {
      const response = await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode } })
      assert.deepEqual(response.json(), output)
      assert.equal(excluded.length, 0)
    } finally { await app.close() }
  }
})

test("an older plugin or malformed answer is unavailable, with no fallback", async () => {
  for (const options of [{ fail: true }, { output: { status: "found", sessionID: "s" } }]) {
    const { app, excluded } = fixture(options)
    try {
      const response = await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "open" } })
      assert.deepEqual(response.json(), { status: "blocked", reason: "unavailable" })
      assert.equal(excluded.length, 0)
    } finally { await app.close() }
  }
})

test("rejects unowned or renamed locations and caller-chosen fields before any RPC", async () => {
  for (const options of [{ owned: false }, { directory: "/elsewhere" }, { directory: "" }]) {
    const { app, calls } = fixture(options)
    try {
      assert.equal((await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "open" } })).statusCode, 403)
      assert.equal(calls.length, 0)
    } finally { await app.close() }
  }
  const { app, calls } = fixture()
  try {
    for (const extra of [{ metadata: {} }, { rpcID: "other" }, { permission: [] }, { parentID: "x" }]) {
      assert.equal((await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "open", ...extra } })).statusCode, 400)
    }
    assert.equal((await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "delete" } })).statusCode, 400)
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test("does not bypass the worktree deletion fence", async () => {
  const { app, calls, fence } = fixture()
  try {
    await fence.run("/owned/repo", ["/owned/repo"], async () => {
      assert.equal((await app.inject({ method: "POST", url, payload: { directory: "/owned/repo", mode: "open" } })).statusCode, 409)
    })
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})
