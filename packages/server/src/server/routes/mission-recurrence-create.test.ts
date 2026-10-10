import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import { physical } from "../../missions/physical-path"
import { canonicalScope } from "../../host-lifetime/protocol"
import { SettingsService } from "../../settings/service"
import { resolveConfigLocation } from "../../config/location"
import { recurrenceConfigSchema } from "../../missions/recurrence-contract"
import { registerMissionRecurrenceCreate } from "./mission-recurrence-create"
import { resolveRecurrenceRoot, type WslGit } from "./mission-recurrence-roots"
import { assertNativeRecurrenceCreateScope } from "../../opencode/missions/native-recurrence-create"
import { canonicalWorktreeIdentity } from "../../workspaces/manager"
import { missionProfileRoles } from "../../missions/playbook-profiles"
import { resolveStandingProfileSource } from "../../missions/host-authority/profile-source"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../missions/lifecycle-input"
import { CanonicalMissionRoots } from "../../missions/mission-roots"
import { recurrenceInputBudget } from "../../missions/recurrence-read-budget"

const profile = { agent: "agent", model: { providerID: "provider", id: "model" } }
const payload = { template: "custom", requestID: "new_schedule", instructions: "Review changes each day", clock: { time: "09:30", zone: "UTC" },
  notes: "  Optional technical context\n<keep verbatim> & do not concatenate  ",
  watchedConversationIDs: [],
  profiles: { coordinator: profile, roles: { specialist: { ...profile, agent: "child" } } }, taskMode: "native" }

test("authenticated recurrence CREATE shares project identity, rejects foreign/changed payload and reconciles lost ACK", async t => {
  for (const extension of ["json", "yaml"] as const) await t.test(`${extension} profile, host and WSL`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "codenomad-recurrence-create-"))
  const main = path.join(root, "main"), sibling = path.join(root, "sibling")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" })
  const app = Fastify()
  const oldChannel = process.env.CODENOMAD_UPDATE_CHANNEL, oldIdentity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
  try {
    await import("node:fs/promises").then(fs => fs.mkdir(main))
    git("init", "-q"); git("-c", "user.email=test@example.org", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "fixture")
    git("worktree", "add", "-qb", "another", sibling)
    const canonical = await realpath(main), worktree = await realpath(sibling)
    const nested = path.join(canonical, "packages", "server")
    await mkdir(nested, { recursive: true })
    const locations = [canonical, worktree, nested, "/wsl/owned", "/wsl/owned/packages/server"]
    let active = canonical, lost = true, writes = 0, watchedDirectory = canonical, distro: string | undefined
    let createdConfig: unknown
    let afterRead: (() => void) | undefined, checkoutReadsAfterRead = -1, moveWatchAtFinalAdmission = false, redirectHost = false
    const saved = new Map<string, any>()
    const project = { id: "project", canonical }
    const connection = { assertCurrent: () => {}, client: {
      location: { get: async ({ location }: any) => ({ ...location, project }) },
      plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
      agent: { list: async () => ({ data: [{ id: "agent", mode: "primary" }, { id: "child", mode: "subagent" }] }) },
      model: { list: async () => ({ data: [{ providerID: "provider", id: "model", enabled: true,
        capabilities: { tools: true }, variants: [] }] }) },
      session: { get: async ({ sessionID }: any) => ({ id: sessionID, projectID: project.id,
        location: { directory: watchedDirectory } }) },
      rpc: () => ({ recurrenceRead: async ({ id }: any) => {
        const result = { schedule: saved.get(id) ?? null }
        afterRead?.()
        return result
      },
        recurrenceCreate: async (input: any) => {
          if (saved.size >= 64) return { schedule: null, noEffect: { code: "capacity", id: input.id,
            requestID: input.requestID, digest: input.digest, projectID: project.id, projectCanonical: project.canonical } }
          writes++
          createdConfig = structuredClone(input.config)
          const result = { id: input.id, revision: 0, state: "paused", digest: input.digest,
            projectID: project.id, projectCanonical: project.canonical }
          saved.set(input.id, result)
          if (lost) throw new Error("native ACK lost")
          return { schedule: result }
        } }),
    } }
    const workspace = { id: "workspace" }
    const manager: any = { get: () => workspace, getServiceLocation: () => ({ directory: active }),
      getSharedServiceConnection: async () => connection,
      ownsLocation: async (_id: string, location: any) => locations.includes(location.directory),
      getServiceDirectoryForPath: async (_id: string, directory: string) => locations.includes(directory) ? directory : undefined,
      getWorktreeIdentityForPath: async (_id: string, directory: string) => {
        if (checkoutReadsAfterRead >= 0 && ++checkoutReadsAfterRead === 8 && moveWatchAtFinalAdmission) watchedDirectory = worktree
        return [nested, "/wsl/owned", "/wsl/owned/packages/server"].includes(directory) ? canonicalWorktreeIdentity(canonical)
          : [canonical, worktree].includes(directory) ? canonicalWorktreeIdentity(directory) : undefined
      },
      getHostPathForServicePath: async (_id: string, directory: string) => {
        return distro && directory === "/wsl/owned" ? canonical : distro && directory === "/wsl/owned/packages/server"
          ? nested : redirectHost && directory === canonical ? worktree : directory
      },
      getServiceWslDistro: () => distro,
      getServicePathStyle: () => distro ? "posix" : process.platform === "win32" ? "win32" : "posix" }
    const family = await readFamilyAuthorityIdentity(canonical)
    const logger: any = { child: () => logger, warn: () => {}, info: () => {} }
    const profileDirectory = path.join(root, "Émilie")
    await mkdir(profileDirectory)
    const originalConfig = path.join(profileDirectory, `custom.${extension}`)
    const originalBytes = extension === "json" ? '{"server":{"logLevel":"info"}}\n' : 'server:\n  logLevel: info\n'
    // Instantiate first so this CREATE fixture tests source preservation without
    // exercising SettingsService's separate, existing startup migration.
    const settings = new SettingsService(resolveConfigLocation(originalConfig), undefined, logger)
    await writeFile(originalConfig, originalBytes)
    // Simulate the already-resolved desktop identity and materialized YAML,
    // preserving the selected JSON source rather than substituting its path.
    const yamlPath = settings.configYamlPathForAuthority()
    if (extension === "json") await writeFile(yamlPath, "server: {}\n")
    process.env.CODENOMAD_UPDATE_CHANNEL = "dev-v2"
    process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = process.platform === "win32"
      ? yamlPath.replaceAll("/", "\\").replace(/[A-Z]/g, letter => letter.toLowerCase()) : yamlPath
    const scope = settings.getProfileScope()
    const wslGit: WslGit = async (_distro, command, args) => {
      if (command === "git") {
        assert.equal(args[0], "-C"); assert.ok(["/wsl/owned", "/wsl/owned/packages/server"].includes(args[1]))
        if (args.includes("--show-toplevel")) return "/wsl/owned"
        return "/wsl/owned/.git"
      }
      return args.at(-1)!
    }
    registerMissionRecurrenceCreate(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(200),
      settings, wslGit, bridgeToken: "fixture-token", auth: { isAuthEnabled: () => true,
        getSessionFromRequest: () => ({ sessionId: "human-cookie", username: "human" }) } as never })
    const url = "/api/workspaces/workspace/missions/recurrence"
    const post = (body: any) => app.inject({ method: "POST", url, payload: body })
    assert.equal((await post({ ...payload, template: undefined })).statusCode, 400)
    assert.equal((await post({ ...payload, template: "wayfinder" })).statusCode, 400, "custom profiles do not fund another playbook")
    assert.equal((await post({ ...payload, notes: "x".repeat(20_001) })).statusCode, 400)
    assert.equal((await post({ ...payload, notes: "\0".repeat(20_000) })).statusCode, 400,
      "individually bounded notes that overflow the frozen JSON config are rejected before native admission")
    assert.equal(writes, 0)
    for (const budgets of [{ effects: 3 }, { effects: 4, inboxMessages: 0 }]) {
      const response = await post({ ...payload, requestID: "old_source_budget", watchedConversationIDs: ["ses_watched"], budgets })
      assert.equal(response.statusCode, 400)
      assert.equal(writes, 0, "removed allocation fields cannot reach native creation")
    }
    for (const effects of [1, 2]) {
      assert.equal((await post({ ...payload, budgets: { effects } })).statusCode, 400)
      assert.equal(writes, 0, "an unplayable budget must not reach native creation")
    }
    assert.equal((await post({ ...payload, directory: path.join(root, "outside") })).statusCode, 403)
    assert.equal((await post({ ...payload, profileID: "forged" })).statusCode, 400)
    const first = await post(payload)
    assert.equal(first.statusCode, 503)
    assert.equal(writes, 1)
    const second = await post(payload)
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().schedule.state, "paused")
    const schedule = [...saved.values()][0], config = recurrenceConfigSchema.parse(createdConfig)
    const native = await resolveRecurrenceRoot(manager, "workspace", canonical, canonical)
    const opaque = canonicalWorktreeIdentity("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo")
    assert.equal(opaque, "wsl:ubuntu:/home/user/repo")
    await assert.rejects(resolveRecurrenceRoot({ ...manager, getWorktreeIdentityForPath: async () => opaque },
      "workspace", canonical, canonical), /Physical recurrence checkout unavailable/,
      "opaque deletion identities are compared, never dereferenced as paths")
    assert.equal(native.mode, "git")
    assert.equal(native.family, family)
    assert.equal(native.checkout, physical(canonical))
    assert.equal(schedule?.projectID, project.id)
    assert.equal(config.profileID, scope.key)
    assert.equal(config.notes, payload.notes)
    const recomputed = canonicalScope(scope.channel, yamlPath, root, root)
    if (process.platform === "win32") assert.notEqual(config.profileID, recomputed.key, "Tauri's Unicode user-data identity stays unchanged")
    else assert.equal(config.profileID, recomputed.key)
    assert.equal(config.executionHost, "local")
    assert.deepEqual(config.roots, [native])
    const resolveCreatedSource = (created: typeof config) => resolveStandingProfileSource({ settings,
      descriptor: { scope, physicalProfile: physical(profileDirectory), executionHost: created.executionHost },
      binding: { profileID: created.profileID, executionHost: created.executionHost, projectID: project.id,
        projectCanonical: project.canonical, roots: created.roots }, manager,
      roots: { assertRoots: async roots => assert.deepEqual(roots, created.roots) }, workspaceID: "workspace",
      assertCurrent: () => { connection.assertCurrent(); return true as const },
    }, async (host, selected) => {
      assert.equal(host, yamlPath); assert.equal(selected, "Ubuntu"); return "/wsl/profile/custom.yaml"
    }, async (file, selected) => {
      assert.equal(file, "/wsl/profile/custom.yaml"); assert.equal(selected, "Ubuntu")
    })
    await t.test(`Unicode ${extension} paused CREATE resolves the exact selected standing profile source`, async () => {
      assert.deepEqual(await resolveCreatedSource(config), { profileID: config.profileID,
        executionHost: "local", configYamlPath: yamlPath })
      assert.equal(await readFile(originalConfig, "utf8"), originalBytes)
    })
    await assertNativeRecurrenceCreateScope(canonical, config, scope, "local")
    await assert.rejects(assertNativeRecurrenceCreateScope(canonical, { ...config,
      roots: [{ ...native, family: "foreign-git-family" }] }, scope, "local"), /native root differs/)
    await assert.rejects(assertNativeRecurrenceCreateScope(canonical, { ...config,
      roots: [{ ...native, checkout: "different-checkout" }] }, scope, "local"), /native root differs/)
    await assert.rejects(assertNativeRecurrenceCreateScope(canonical, { ...config,
      profileID: "foreign-profile" }, scope, "local"), /profile or host differs/)
    if (process.platform === "win32") await assert.rejects(assertNativeRecurrenceCreateScope(canonical, { ...config,
      executionHost: "wsl:Ubuntu" }, scope, "wsl:Ubuntu"), /profile or host differs/)
    assert.equal(writes, 1, "lost native ACK is reconciled by read, not retried")
    assert.equal((await post({ ...payload, instructions: "Different instruction" })).statusCode, 409)
    assert.equal((await post({ ...payload, notes: payload.notes + "changed" })).statusCode, 409, "notes change the exact frozen request digest")
    active = worktree; lost = false
    const siblingResponse = await post(payload)
    assert.equal(siblingResponse.statusCode, 409, "one project-wide request ID cannot retarget another checkout")
    assert.equal(writes, 1)
    const fresh = await post({ ...payload, requestID: "fresh_schedule" })
    assert.equal(fresh.statusCode, 200)
    assert.equal(writes, 2)
    assert.notEqual(fresh.json().schedule.id, second.json().schedule.id)
    assert.deepEqual(recurrenceConfigSchema.parse(createdConfig).roots,
      [{ mode: "git", directory: worktree, family, checkout: physical(worktree) }])
    active = canonical
    await t.test("watch moves during final admission await, before native CREATE", async () => {
      afterRead = () => { checkoutReadsAfterRead = 0; moveWatchAtFinalAdmission = true }
      const response = await post({ ...payload, requestID: "moving_watch", watchedConversationIDs: ["ses_watched"] })
      assert.equal(response.statusCode, 503, `checkout rechecks: ${checkoutReadsAfterRead}`)
      assert.equal(writes, 2, "moved watch must never reach the native write")
      assert.equal(watchedDirectory, worktree, "move happened during the final awaited admission check")
      afterRead = undefined; checkoutReadsAfterRead = -1; moveWatchAtFinalAdmission = false; watchedDirectory = canonical
    })
    await t.test("lost-ACK readback cannot settle after physical root changes during RPC", async () => {
      afterRead = () => { redirectHost = true }
      const response = await post(payload)
      assert.equal(response.statusCode, 503)
      assert.equal(writes, 2)
      afterRead = undefined; redirectHost = false
    })
    await t.test("64 schedules return exact native no-effect capacity; retry never parks deletion", async () => {
      for (let index = 0; index < 62; index++) saved.set(`occupied_${index}`, { id: `occupied_${index}` })
      assert.equal(saved.size, 64)
      const full = { ...payload, requestID: "full_schedule" }
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post(full)
        assert.equal(response.statusCode, 503)
        assert.equal(response.json().code, "recurrence-capacity")
        assert.equal(writes, 2, "capacity has positive no-effect evidence, never another write")
      }
      for (let index = 0; index < 62; index++) saved.delete(`occupied_${index}`)
    })
    await t.test("verified WSL Location creates paused metadata with native Linux Git identities", async () => {
      active = "/wsl/owned"; distro = "Ubuntu"
      project.canonical = "/wsl/owned"
      const response = await post({ ...payload, requestID: "wsl_schedule" })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().schedule.state, "paused")
      assert.equal(writes, 3)
      const wsl = recurrenceConfigSchema.parse(createdConfig)
      assert.equal(wsl.profileID, scope.key)
      assert.equal(wsl.executionHost, "wsl:Ubuntu")
      assert.deepEqual(wsl.roots, [{ mode: "git", directory: "/wsl/owned", family: "/wsl/owned/.git", checkout: "/wsl/owned" }])
      assert.deepEqual(await resolveCreatedSource(wsl), { profileID: wsl.profileID,
        executionHost: "wsl:Ubuntu", configYamlPath: "/wsl/profile/custom.yaml" })
      assert.equal((await post({ ...payload, requestID: "wsl_schedule" })).statusCode, 200)
      assert.equal(writes, 3, "WSL duplicate is an exact read, not another native write")
    })
    for (const template of ["debug", "wayfinder"] as const) await t.test(`recurring ${template} freezes its exact role selections`, async () => {
      const profiles = { coordinator: profile, roles: Object.fromEntries(missionProfileRoles[template]
        .map(role => [role, { ...profile, agent: "child" }])) }
      const recurring = { ...payload, requestID: `recurring_${template}`, template, profiles }
      const response = await post(recurring)
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().schedule.state, "paused")
      const config = recurrenceConfigSchema.parse(createdConfig)
      assert.equal(config.template, template)
      assert.equal(config.notes, payload.notes)
      assert.deepEqual(config.profiles, profiles)
      assert.throws(() => recurrenceConfigSchema.parse({ ...config, profiles: payload.profiles }))
      assert.throws(() => recurrenceConfigSchema.parse({ ...config, template: "custom" }))
      assert.equal((await post({ ...recurring, template: "custom" })).statusCode, 400)
      assert.equal((await post(recurring)).statusCode, 200, "exact duplicate remains a read")
      assert.equal((await post({ ...recurring, notes: payload.notes + " changed" })).statusCode, 409)
    })
    for (const wsl of [false, true]) await t.test(`nested ${wsl ? "WSL" : "host"} Location retains its enclosing checkout identity`, async () => {
      active = wsl ? "/wsl/owned/packages/server" : nested
      distro = wsl ? "Ubuntu" : undefined; project.canonical = wsl ? "/wsl/owned" : canonical
      const response = await post({ ...payload, requestID: `nested_${wsl ? "wsl" : "host"}` })
      assert.equal(response.statusCode, 200)
      const config = recurrenceConfigSchema.parse(createdConfig)
      assert.deepEqual(config.roots, [{ mode: "git", directory: active,
        family: wsl ? "/wsl/owned/.git" : family, checkout: wsl ? "/wsl/owned" : physical(canonical) }])
      if (!wsl) {
        await assertNativeRecurrenceCreateScope(nested, config, scope, "local")
        const claims = [{ family, claim: { assertCurrent: async () => assert.equal(await readFamilyAuthorityIdentity(nested), family), release: async () => {} } }]
        await new CanonicalMissionRoots(manager, "workspace", claims, held => {
          assert.equal(held.family, family); return true
        }).assertRoots(config.roots)
      }
    })
    await t.test("exact 16384-character start payload is accepted; 16385 is rejected before native write", async () => {
      for (const template of ["custom", "debug", "wayfinder"] as const) {
        const profiles = { coordinator: profile, roles: Object.fromEntries(missionProfileRoles[template].map(role => [role, { ...profile, agent: "child" }])) }
        const full = { ...payload, template, profiles, requestID: `boundary_${template}`, instructions: "x".repeat(MISSION_LIFECYCLE_TEXT_LIMIT) }
        const before = writes
        assert.equal((await post({ ...full, instructions: full.instructions + "x" })).statusCode, 400)
        assert.equal(writes, before)
        assert.equal((await post(full)).statusCode, 200)
        assert.equal(recurrenceStartText(recurrenceConfigSchema.parse(createdConfig)), full.instructions)
        assert.equal(writes, before + 1)
      }
    })
    await t.test("watched whole-input room is preflighted before publication and rejected requests remain explicitly retryable", async () => {
      active = canonical; distro = undefined; project.canonical = canonical; watchedDirectory = canonical
      const followed = { ...payload, requestID: "source_input_boundary", watchedConversationIDs: ["ses_watched"] }
      const limit = recurrenceInputBudget({ consigne: "", watchedConversationIDs: followed.watchedConversationIDs,
        roots: [{ directory: canonical }] }).instructionsMaximum
      const before = writes
      const oversized = { ...followed, instructions: "x".repeat(limit + 1) }
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post(oversized)
        assert.equal(response.statusCode, 400); assert.equal(response.json().code, "recurrence-input-capacity")
        assert.equal(writes, before, "source envelope overflow makes no native write and parks no creation hold")
      }
      assert.equal((await post({ ...followed, instructions: "x".repeat(limit) })).statusCode, 200)
      assert.equal(writes, before + 1)
      const config = recurrenceConfigSchema.parse(createdConfig)
      assert.equal("budgets" in config, false); assert.equal("publication" in config, false)
      assert.equal(recurrenceInputBudget(config).sufficient, true)
    })
    assert.equal(await readFile(originalConfig, "utf8"), originalBytes, "paused CREATE never edits the original settings source")
  } finally {
    if (oldChannel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
    else process.env.CODENOMAD_UPDATE_CHANNEL = oldChannel
    if (oldIdentity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = oldIdentity
    await app.close(); await rm(root, { recursive: true, force: true })
  }
  })
})
