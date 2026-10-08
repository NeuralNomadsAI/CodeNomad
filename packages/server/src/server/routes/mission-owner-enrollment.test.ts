import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { rememberRuntime } from "../../opencode/compatibility/runtime"
import { MANAGED_OWNER_RPC_ID } from "../../opencode/missions/managed-owner-plugin"
import { registerMissionOwnerEnrollment, resolveEnrollmentPlacement } from "./mission-owner-enrollment"

test("enrollment never accepts an authority descriptor from the caller", async () => {
  const app = Fastify()
  registerMissionOwnerEnrollment(app, {
    privateRoot: "unused",
    manager: {
      get: () => { throw new Error("Should not inspect workspace") },
      getServiceLocation: () => { throw new Error("Should not inspect workspace") },
      getSharedServiceConnection: async () => { throw new Error("Should not connect") },
      getHostPathForServicePath: async () => { throw new Error("Should not read paths") },
      getServiceDirectoryForPath: async () => { throw new Error("Should not resolve Location") },
      getWorktreeIdentityForPath: async () => { throw new Error("Should not inspect Git") },
      getServiceWslDistro: () => { throw new Error("Should not resolve WSL") },
      ownsLocation: async () => { throw new Error("Should not authorize caller data") },
    },
  })
  try {
    const reply = await app.inject({ method: "POST", url: "/api/workspaces/w/missions/managed-owner/enroll",
      payload: { namespace: "caller-chosen" } })
    assert.equal(reply.statusCode, 400)
  } finally { await app.close() }
})

test("canonical, owned worktree and translated WSL Locations share one physical family without alias authority", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const base = await mkdtemp(path.join(temporary, "missions-owner-placement-"))
  const canonical = path.join(base, "canonical"), checkout = path.join(base, "checkout"), foreign = path.join(base, "foreign")
  const git = (...args: string[]) => execFileSync("git", args, { windowsHide: true, stdio: "pipe" })
  try {
    await mkdir(canonical)
    await mkdir(foreign)
    git("init", "-q", canonical)
    git("-C", canonical, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "--allow-empty", "-m", "seed")
    git("-C", canonical, "worktree", "add", "-q", "-b", "owner-test", checkout)
    git("init", "-q", foreign)
    const manager = (location: string, paths: Record<string, string>, registered: string) => ({
      getServiceLocation: () => ({ directory: location }),
      getServiceDirectoryForPath: async (_id: string, candidate: string) => candidate === location ? candidate : undefined,
      getHostPathForServicePath: async (_id: string, candidate: string) => paths[candidate],
      getWorktreeIdentityForPath: async () => registered,
    })
    const native = manager(canonical, { [canonical]: canonical }, canonical)
    const root = await resolveEnrollmentPlacement(native as never, "w", canonical, canonical)
    const worktree = manager(checkout, { [canonical]: canonical, [checkout]: checkout }, checkout)
    const owned = await resolveEnrollmentPlacement(worktree as never, "w", checkout, canonical)
    assert.equal(owned.family, root.family, "one enrollment key per project/family across owned checkouts")
    assert.notEqual(owned.host, root.host, "a valid worktree is not the canonical Location")

    const linuxRoot = "/mnt/project", linuxCheckout = "/mnt/project-worktree"
    const wsl = manager(linuxCheckout, { [linuxRoot]: canonical, [linuxCheckout]: checkout }, checkout)
    const translated = await resolveEnrollmentPlacement(wsl as never, "w", linuxCheckout, linuxRoot)
    assert.equal(translated.family, root.family)
    assert.equal(translated.host, owned.host)
    assert.equal(translated.canonicalHost, root.host)
    await assert.rejects(resolveEnrollmentPlacement(manager(linuxCheckout,
      { [linuxRoot]: foreign, [linuxCheckout]: checkout }, checkout) as never, "w", linuxCheckout, linuxRoot), /family/)
    await assert.rejects(resolveEnrollmentPlacement(manager(linuxCheckout,
      { [linuxRoot]: canonical, [linuxCheckout]: foreign }, checkout) as never, "w", linuxCheckout, linuxRoot), /family/)
    await assert.rejects(resolveEnrollmentPlacement(wsl as never, "w", linuxRoot, linuxRoot), /Registered Location/)

    // Exercise the actual HTTP route up to its fixed RPC (which deliberately
    // refuses in this offline fixture). No private/native service is started.
    async function admits(location: string, canonicalService: string, translated: boolean, foreignCanonical = false) {
      const global = translated ? "/wsl/config" : path.join(base, "config")
      const data = translated ? "/wsl/data/missions" : path.join(base, "data", "missions")
      const bytes = Buffer.from("isolated owned bundle")
      const name = `${createHash("sha256").update(bytes).digest("hex")}.mjs`
      const nativePaths = translated ? path.posix : path
      const entryService = nativePaths.join(global, "plugins", "codenomad-missions.ts")
      const bundleService = nativePaths.join(data, name)
      const entryHost = path.join(base, translated ? "wsl-config" : "config", "plugins", "codenomad-missions.ts")
      const bundleHost = path.join(base, translated ? "wsl-data" : "data", "missions", name)
      await mkdir(path.dirname(entryHost), { recursive: true })
      await mkdir(path.dirname(bundleHost), { recursive: true })
      await writeFile(bundleHost, bytes)
      await writeFile(entryHost, `// Managed by CodeNomad: missions lifecycle v1\nimport { desktopPlugin } from ${JSON.stringify(translated
        ? `file://${bundleService}` : pathToFileURL(bundleHost).href)}\nexport default desktopPlugin("/fixture/presence")\n`)
      const locationHost = location === canonical || location === linuxRoot ? canonical : checkout
      const mapped = { [location]: locationHost, [canonicalService]: foreignCanonical ? foreign : canonical,
        [entryService]: entryHost, [bundleService]: bundleHost }
      const endpoint = { url: "http://127.0.0.1:10001" }
      rememberRuntime(endpoint as never, { version: "2.0.24", pid: 101, discovery: "status" })
      let calls = 0
      const workspace = {}
      const localManager = {
        ...manager(location, mapped, locationHost), get: () => workspace,
        getSharedServiceConnection: async () => ({ endpoint, assertCurrent: () => {}, client: {
          location: { get: async () => ({ directory: location, project: { id: "owned", canonical: canonicalService } }) },
          plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" },
            source: { type: "local", path: entryService } }] }) },
          config: { get: async () => [{ type: "directory", path: global }] },
          rpc: { call: async (input: { rpcID: string; method: string; location: { directory: string } }) => {
            assert.equal(input.rpcID, MANAGED_OWNER_RPC_ID)
            assert.equal(input.method, "observe")
            assert.equal(input.location.directory, location)
            calls++
            throw new Error("No private native fixture in offline test")
          } },
        } }),
        ownsLocation: async () => true,
        getServiceWslDistro: () => translated ? "Ubuntu" : undefined,
      }
      const app = Fastify()
      registerMissionOwnerEnrollment(app, { manager: localManager as never, privateRoot: "unused" })
      try {
        const reply = await app.inject({ method: "POST", url: "/api/workspaces/w/missions/managed-owner/enroll", payload: {} })
        assert.equal(reply.statusCode, 503, "the offline fixture never publishes enrollment")
        assert.equal(calls, foreignCanonical ? 0 : 1, "foreign family never reaches the observation RPC")
      } finally { await app.close() }
    }
    await admits(canonical, canonical, false)
    await admits(checkout, canonical, false)
    await admits(linuxCheckout, linuxRoot, true)
    await admits(linuxCheckout, linuxRoot, true, true)
  } finally { await rm(base, { recursive: true, force: true }) }
})
