import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, it } from "node:test"
import { parse } from "jsonc-parser"
import { PluginControls, PluginControlsError } from "./plugin-controls"

const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe("OpenCode V2 plugin activation controls", () => {
  it("keeps runtime inventory separate from configured sources and ordered rules", async () => {
    const fixture = createFixture({
      globalPlugins: [{ package: "@acme/reviewer", options: { strict: true } }, "-acme.reviewer"],
      projectPlugins: ["acme.reviewer", "-opencode.provider.*"],
      runtime: [
        { id: "acme.reviewer", source: { type: "package", target: "@acme/reviewer", version: "1.2.0" }, features: { server: true }, state: { status: "active" } },
        { id: "broken", source: { type: "local", path: "/plugins/broken" }, features: { rpc: true }, state: { status: "failed", error: "boom", ref: "err_1" } },
      ],
    })

    const snapshot = await fixture.controls.read("workspace", fixture.location)

    assert.deepEqual(snapshot.runtime.map((entry) => [entry.id, entry.state.status]), [
      ["acme.reviewer", "active"], ["broken", "failed"],
    ])
    assert.deepEqual(snapshot.configured.sources.map((entry) => [entry.target, entry.scope, entry.hasOptions]), [
      ["@acme/reviewer", "global", true],
    ])
    assert.deepEqual(snapshot.configured.rules.map((rule) => [rule.selector, rule.enabled, rule.scope]), [
      ["acme.reviewer", false, "global"],
      ["acme.reviewer", true, "project"],
      ["opencode.provider.*", false, "project"],
    ])
    const reviewer = snapshot.controls.find((entry) => entry.id === "acme.reviewer")!
    assert.equal(reviewer.global, "disabled")
    assert.equal(reviewer.project, "enabled")
    assert.equal(reviewer.effective, "enabled")
    assert.equal(reviewer.runtime?.source.type, "package")
  })

  it("keeps an exact disabled plugin visible when it is absent from runtime", async () => {
    const fixture = createFixture({ globalPlugins: ["-acme.reviewer"], runtime: [] })

    const snapshot = await fixture.controls.read("workspace", fixture.location)

    assert.deepEqual(snapshot.runtime, [])
    assert.deepEqual(snapshot.controls.map((entry) => ({ id: entry.id, effective: entry.effective })), [
      { id: "acme.reviewer", effective: "disabled" },
    ])
  })

  it("distinguishes a package target from later exact activation rules when target and ID match", async () => {
    const fixture = createFixture({
      globalPlugins: ["same.id", "-same.id", "same.id"],
      runtime: [activePlugin("same.id", "same.id")],
    })

    const snapshot = await fixture.controls.read("workspace", fixture.location)

    assert.deepEqual(snapshot.configured.sources.map((entry) => entry.target), ["same.id"])
    assert.deepEqual(snapshot.configured.rules.map((rule) => [rule.selector, rule.enabled]), [
      ["same.id", false],
      ["same.id", true],
    ])
    assert.equal(snapshot.controls.find((entry) => entry.id === "same.id")?.effective, "enabled")
  })

  it("replays object-form sources as ordered add operations", async () => {
    const fixture = createFixture({
      globalPlugins: ["same.id", "-same.id", { package: "same.id", options: {} }],
      runtime: [activePlugin("same.id", "same.id")],
    })

    const snapshot = await fixture.controls.read("workspace", fixture.location)

    assert.deepEqual(snapshot.configured.rules.map((rule) => [rule.selector, rule.enabled]), [
      ["same.id", false],
      ["same.id", true],
    ])
    assert.equal(snapshot.controls.find((entry) => entry.id === "same.id")?.effective, "enabled")
  })

  it("correlates relative and file URL local sources with their runtime entrypoint", async () => {
    for (const kind of ["relative", "file"] as const) {
      const fixture = createFixture({ runtime: [] })
      const configuredTarget = kind === "file"
        ? pathToFileURL(path.join(fixture.projectDirectory, "plugins", "reviewer")).href
        : "./plugins/reviewer"
      const sourceDirectory = kind === "file"
        ? path.join(fixture.projectDirectory, "plugins", "reviewer")
        : path.join(fixture.projectDirectory, ".opencode", "plugins", "reviewer")
      const entrypoint = path.join(sourceDirectory, "server.js")
      fixture.runtime.push({
        id: "acme.reviewer",
        source: { type: "local", path: entrypoint },
        features: { server: true },
        state: { status: "active" },
      })
      fixture.setProjectPlugins([
        configuredTarget,
        "-acme.reviewer",
        { package: configuredTarget, options: {} },
      ])

      const snapshot = await fixture.controls.read("workspace", fixture.location)
      assert.equal(snapshot.controls.find((entry) => entry.id === "acme.reviewer")?.effective, "enabled")
    }
  })

  it("marks an exact disabled OpenCode builtin even when runtime inventory omits it", async () => {
    const fixture = createFixture({ globalPlugins: ["-opencode.prompt.identity"], runtime: [] })

    const control = (await fixture.controls.read("workspace", fixture.location)).controls
      .find((entry) => entry.id === "opencode.prompt.identity")

    assert.equal(control?.builtin, true)
    assert.equal(control?.effective, "disabled")
  })

  it("serializes mutations, writes only the selected project layer, and preserves prior rules", async () => {
    const fixture = createFixture({
      globalPlugins: [
        { package: "@acme/reviewer", options: { strict: true } },
        { package: "@acme/linter", options: { level: "strict" } },
      ],
      runtime: [activePlugin("acme.reviewer", "@acme/reviewer"), activePlugin("acme.linter", "@acme/linter")],
      omitProjectDocument: true,
    })
    const globalBefore = fs.readFileSync(fixture.globalFile, "utf8")

    const [reviewer, linter] = await Promise.all([
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "acme.reviewer", scope: "project", enabled: false }),
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "acme.linter", scope: "project", enabled: false }),
    ])

    assert.equal(reviewer.changed, true)
    assert.equal(linter.changed, true)
    assert.equal(reviewer.target.scope, "project")
    assert.equal(fs.readFileSync(fixture.globalFile, "utf8"), globalBefore)
    const projectFile = path.join(fixture.projectDirectory, ".opencode", "opencode.jsonc")
    assert.deepEqual((parse(fs.readFileSync(projectFile, "utf8")) as any).plugins, ["-acme.reviewer", "-acme.linter"])
    assert.equal(linter.snapshot.controls.find((entry) => entry.id === "acme.reviewer")?.project, "disabled")
    assert.equal(linter.snapshot.controls.find((entry) => entry.id === "acme.linter")?.project, "disabled")
  })

  it("serializes same-target mutations while letting other scopes proceed", async () => {
    const fixture = createFixture({
      globalPlugins: [{ package: "@acme/reviewer", options: { strict: true } }],
      projectPlugins: [],
      runtime: [activePlugin("acme.reviewer", "@acme/reviewer")],
    })
    const manager = (fixture.controls as any).options.workspaceManager
    const innerIdentity = manager.getWorktreeIdentityForPath.bind(manager)
    const gate = deferred<void>()
    let identityCalls = 0
    let projectSettled = false
    manager.getWorktreeIdentityForPath = async (...args: [string, string]) => {
      identityCalls += 1
      // The first mutation (global scope) is held here; a per-target queue
      // lets the project-scope mutation overtake it instead of blocking.
      if (identityCalls === 1) await gate.promise
      return innerIdentity(...args)
    }

    const global = fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "acme.reviewer", scope: "global", enabled: false })
    const project = fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "acme.reviewer", scope: "project", enabled: false })
    void project.then(() => { projectSettled = true })
    const deadline = Date.now() + 5_000
    while (!projectSettled && Date.now() < deadline) await tick()
    assert.equal(projectSettled, true)
    gate.resolve()
    const [globalResponse, projectResponse] = await Promise.all([global, project])

    assert.equal(globalResponse.changed, true)
    assert.equal(projectResponse.changed, true)
    assert.deepEqual((parse(fs.readFileSync(fixture.globalFile, "utf8")) as any).plugins, [
      { package: "@acme/reviewer", options: { strict: true } },
      "-acme.reviewer",
    ])
    assert.deepEqual((parse(fs.readFileSync(fixture.projectFile, "utf8")) as any).plugins, ["-acme.reviewer"])
  })

  it("serializes global writes from different worktree directories to the same file", async () => {
    const fixture = createFixture({
      globalPlugins: [],
      runtime: [activePlugin("acme.reviewer", "@acme/reviewer"), activePlugin("acme.linter", "@acme/linter")],
    })
    const otherLocation = { directory: path.join(path.dirname(fixture.projectDirectory), "other-worktree") }

    const [reviewer, linter] = await Promise.all([
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "acme.reviewer", scope: "global", enabled: false }),
      fixture.controls.mutate("workspace", { location: otherLocation, pluginId: "acme.linter", scope: "global", enabled: false }),
    ])

    assert.equal(reviewer.changed, true)
    assert.equal(linter.changed, true)
    assert.deepEqual((parse(fs.readFileSync(fixture.globalFile, "utf8")) as any).plugins, ["-acme.reviewer", "-acme.linter"])
  })

  it("appends a later exact rule to re-enable without deleting the disabling rule", async () => {
    const fixture = createFixture({
      globalPlugins: [{ package: "@acme/reviewer", options: { strict: true } }],
      projectPlugins: ["-acme.reviewer"],
      runtime: [],
    })

    const response = await fixture.controls.mutate("workspace", {
      location: fixture.location,
      pluginId: "acme.reviewer",
      scope: "project",
      enabled: true,
    })

    assert.equal(response.rule, "acme.reviewer")
    assert.equal(response.snapshot.controls.find((entry) => entry.id === "acme.reviewer")?.effective, "enabled")
    assert.deepEqual((parse(fs.readFileSync(fixture.projectFile, "utf8")) as any).plugins, ["-acme.reviewer", "acme.reviewer"])
  })

  it("uses daemon-reported roots and host translation instead of process configuration", async () => {
    const host = temporaryDirectory()
    const globalHost = path.join(host, "daemon-global")
    const projectHost = path.join(host, "daemon-project")
    fs.mkdirSync(globalHost, { recursive: true })
    fs.mkdirSync(projectHost, { recursive: true })
    fs.writeFileSync(path.join(globalHost, "opencode.jsonc"), `{ "plugins": [] }\n`)
    const location = { directory: "/srv/project" }
    const entries = [
      { type: "document", path: "/daemon/config/opencode.jsonc", info: { plugins: [] } },
      { type: "directory", path: "/daemon/config" },
    ]
    const manager = fakeManager({
      entries,
      runtime: [activePlugin("acme.reviewer", "@acme/reviewer")],
      style: "posix",
      translate: (servicePath) => servicePath === "/daemon/config" ? globalHost : servicePath === "/srv/project" ? projectHost : undefined,
    })
    const controls = new PluginControls({ workspaceManager: manager as any, worktreeDeletionFence: openFence(), logger: logger() })

    const response = await controls.mutate("workspace", { location, pluginId: "acme.reviewer", scope: "global", enabled: false })

    assert.equal(response.target.path, "/daemon/config/opencode.jsonc")
    assert.deepEqual((parse(fs.readFileSync(path.join(globalHost, "opencode.jsonc"), "utf8")) as any).plugins, ["-acme.reviewer"])
  })

  it("uses the canonical service directory for WSL requests and snapshot identity", async () => {
    const host = temporaryDirectory()
    const globalHost = path.join(host, "daemon-global")
    const projectHost = path.join(host, "daemon-project")
    fs.mkdirSync(globalHost, { recursive: true })
    fs.mkdirSync(projectHost, { recursive: true })
    fs.writeFileSync(path.join(globalHost, "opencode.jsonc"), `{ "plugins": [] }\n`)
    const entries = [{ type: "directory", path: "/daemon/config" }]
    const manager = fakeManager({
      entries,
      runtime: [activePlugin("acme.reviewer", "@acme/reviewer")],
      style: "posix",
      serviceDirectory: "/srv/project",
      translate: (servicePath) => servicePath === "/daemon/config" ? globalHost : servicePath === "/srv/project" ? projectHost : undefined,
    })
    const controls = new PluginControls({ workspaceManager: manager as any, worktreeDeletionFence: openFence(), logger: logger() })

    const snapshot = await controls.read("workspace", { directory: "\\\\wsl.localhost\\Ubuntu\\srv\\project" })

    assert.equal(snapshot.location.directory, "/srv/project")
    assert.deepEqual(manager.calls.configLocations, ["/srv/project"])
    assert.deepEqual(manager.calls.pluginLocations, ["/srv/project"])
  })

  it("does not expose Project when it resolves to the Global configuration file", async () => {
    const directory = temporaryDirectory()
    const configFile = path.join(directory, "opencode.jsonc")
    fs.writeFileSync(configFile, `{ "plugins": [] }\n`)
    const manager = fakeManager({
      entries: [
        { type: "document", path: configFile, info: { plugins: [] } },
        { type: "directory", path: directory },
      ],
      runtime: [activePlugin("known", "known-package")],
    })
    const controls = new PluginControls({ workspaceManager: manager as any, worktreeDeletionFence: openFence(), logger: logger() })

    const snapshot = await controls.read("workspace", { directory })
    assert.deepEqual(snapshot.targets.map((target) => target.scope), ["global"])
    await assert.rejects(
      controls.mutate("workspace", { location: { directory }, pluginId: "known", scope: "project", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
    assert.deepEqual((parse(fs.readFileSync(configFile, "utf8")) as any).plugins, [])
  })

  it("does not expose Project through a symlink to the Global configuration", async () => {
    const root = temporaryDirectory()
    const globalDirectory = path.join(root, "global")
    const projectDirectory = path.join(root, "project")
    const globalFile = path.join(globalDirectory, "opencode.jsonc")
    fs.mkdirSync(globalDirectory, { recursive: true })
    fs.mkdirSync(projectDirectory, { recursive: true })
    fs.writeFileSync(globalFile, `{ "plugins": [] }\n`)
    fs.symlinkSync(globalDirectory, path.join(projectDirectory, ".opencode"), process.platform === "win32" ? "junction" : "dir")
    const manager = fakeManager({
      entries: [
        { type: "document", path: globalFile, info: { plugins: [] } },
        { type: "directory", path: globalDirectory },
      ],
      runtime: [activePlugin("known", "known-package")],
    })
    const controls = new PluginControls({ workspaceManager: manager as any, worktreeDeletionFence: openFence(), logger: logger() })

    const snapshot = await controls.read("workspace", { directory: projectDirectory })
    assert.deepEqual(snapshot.targets.map((target) => target.scope), ["global"])
    await assert.rejects(
      controls.mutate("workspace", { location: { directory: projectDirectory }, pluginId: "known", scope: "project", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
    assert.deepEqual((parse(fs.readFileSync(globalFile, "utf8")) as any).plugins, [])
  })

  it("does not expose Project at the global configuration root when no document exists", async () => {
    const directory = temporaryDirectory()
    const manager = fakeManager({
      entries: [{ type: "directory", path: directory }],
      runtime: [activePlugin("known", "known-package")],
    })
    const controls = new PluginControls({ workspaceManager: manager as any, worktreeDeletionFence: openFence(), logger: logger() })

    const snapshot = await controls.read("workspace", { directory })
    assert.deepEqual(snapshot.targets.map((target) => target.scope), ["global"])
    await assert.rejects(
      controls.mutate("workspace", { location: { directory }, pluginId: "known", scope: "project", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
    assert.equal(fs.existsSync(path.join(directory, ".opencode", "opencode.jsonc")), false)
  })

  it("uses normalized daemon entries for authorization while preserving raw placeholders", async () => {
    const fixture = createFixture({
      globalPlugins: ["{env:PLUGIN_RULE}"],
      reportedGlobalPlugins: ["-known"],
      runtime: [],
    })

    const response = await fixture.controls.mutate("workspace", {
      location: fixture.location,
      pluginId: "known",
      scope: "global",
      enabled: true,
    })

    assert.equal(response.snapshot.controls.find((entry) => entry.id === "known")?.effective, "enabled")
    assert.deepEqual((parse(fs.readFileSync(fixture.globalFile, "utf8")) as any).plugins, ["{env:PLUGIN_RULE}", "known"])
  })

  it("never treats a concrete pending rule as the normalized form of a placeholder", async () => {
    const fixture = createFixture({
      globalPlugins: ["{env:PLUGIN_RULE}", "-known", "known"],
      reportedGlobalPlugins: ["known"],
      runtime: [activePlugin("known", "known-package")],
    })

    const response = await fixture.controls.mutate("workspace", {
      location: fixture.location,
      pluginId: "known",
      scope: "global",
      enabled: false,
    })

    assert.equal(response.changed, true)
    assert.equal(response.snapshot.controls.find((entry) => entry.id === "known")?.effective, "disabled")
    assert.deepEqual((parse(fs.readFileSync(fixture.globalFile, "utf8")) as any).plugins, [
      "{env:PLUGIN_RULE}", "-known", "known", "-known",
    ])
  })

  it("preserves normalized ordering when a placeholder follows a concrete rule", async () => {
    const fixture = createFixture({
      globalPlugins: ["-known", "{env:PLUGIN_RULE}"],
      reportedGlobalPlugins: ["-known", "known"],
      runtime: [activePlugin("known", "known-package")],
    })

    const response = await fixture.controls.mutate("workspace", {
      location: fixture.location,
      pluginId: "known",
      scope: "global",
      enabled: false,
    })

    assert.equal(response.changed, true)
    assert.equal(response.snapshot.controls.find((entry) => entry.id === "known")?.effective, "disabled")
    assert.deepEqual((parse(fs.readFileSync(fixture.globalFile, "utf8")) as any).plugins, [
      "-known", "{env:PLUGIN_RULE}", "-known",
    ])
  })

  it("keeps daemon-reported virtual precedence when adding a missing global document", async () => {
    const root = temporaryDirectory()
    const globalDirectory = path.join(root, "global")
    const projectDirectory = path.join(root, "project")
    const projectConfigDirectory = path.join(projectDirectory, ".opencode")
    fs.mkdirSync(globalDirectory, { recursive: true })
    fs.mkdirSync(projectConfigDirectory, { recursive: true })
    const entries = [
      { type: "document", info: { plugins: ["known"] } },
      { type: "directory", path: globalDirectory },
      { type: "document", path: path.join(projectConfigDirectory, "opencode.jsonc"), info: { plugins: [] } },
      { type: "directory", path: projectConfigDirectory },
      { type: "document", info: { plugins: ["-known"] } },
    ]
    const manager = fakeManager({ entries, runtime: [activePlugin("known", "known-package")] })
    const controls = new PluginControls({
      workspaceManager: manager as any,
      worktreeDeletionFence: openFence(),
      logger: logger(),
    })

    const response = await controls.mutate("workspace", {
      location: { directory: projectDirectory },
      pluginId: "known",
      scope: "global",
      enabled: true,
    })

    const control = response.snapshot.controls.find((entry) => entry.id === "known")
    assert.equal(control?.global, "enabled")
    assert.equal(control?.effective, "disabled", "the trailing virtual rule remains higher precedence")
    assert.deepEqual((parse(fs.readFileSync(path.join(globalDirectory, "opencode.jsonc"), "utf8")) as any).plugins, ["known"])
  })

  it("rejects foreign locations and unknown plugin IDs before any write", async () => {
    const fixture = createFixture({ runtime: [activePlugin("known", "known-package")], ownsLocation: false })
    await assert.rejects(
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "known", scope: "global", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "forbidden",
    )
    assert.equal(fixture.calls.config, 0)
    assert.equal(fixture.calls.plugins, 0)

    const owned = createFixture({ runtime: [activePlugin("known", "known-package")] })
    await assert.rejects(
      owned.controls.mutate("workspace", { location: owned.location, pluginId: "invented", scope: "global", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "forbidden",
    )
    assert.deepEqual((parse(fs.readFileSync(owned.globalFile, "utf8")) as any).plugins, [])
  })

  it("fails closed when the selected configuration document is malformed", async () => {
    const fixture = createFixture({ runtime: [activePlugin("known", "known-package")] })
    const malformed = `{ "plugins": ["known", } broken }`
    fs.writeFileSync(fixture.globalFile, malformed)

    await assert.rejects(
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "known", scope: "global", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "invalid",
    )
    assert.equal(fs.readFileSync(fixture.globalFile, "utf8"), malformed)
  })

  it("refuses a mutation while worktree deletion blocks the location", async () => {
    const fixture = createFixture({
      runtime: [activePlugin("known", "known-package")],
      worktreeDeletionFence: { enter: () => undefined },
    })
    const before = fs.readFileSync(fixture.globalFile, "utf8")

    await assert.rejects(
      fixture.controls.mutate("workspace", { location: fixture.location, pluginId: "known", scope: "global", enabled: false }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "conflict",
    )

    assert.equal(fs.readFileSync(fixture.globalFile, "utf8"), before)
  })

  it("fails closed instead of presenting malformed runtime inventory as active", async () => {
    const fixture = createFixture({
      runtime: [{ id: "known", source: { type: "unexpected" }, features: {}, state: { status: "pending" } }],
    })

    await assert.rejects(
      fixture.controls.read("workspace", fixture.location),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
  })

  it("fences a read if the authenticated connection changes during target discovery", async () => {
    const root = temporaryDirectory()
    const globalDirectory = path.join(root, "global")
    const projectDirectory = path.join(root, "project")
    fs.mkdirSync(globalDirectory, { recursive: true })
    fs.mkdirSync(projectDirectory, { recursive: true })
    const manager = fakeManager({
      entries: [{ type: "directory", path: globalDirectory }],
      runtime: [activePlugin("known", "known-package")],
      assertCurrent: (count) => { if (count === 2) throw new Error("stale connection") },
    })
    const controls = new PluginControls({
      workspaceManager: manager as any,
      worktreeDeletionFence: openFence(),
      logger: logger(),
    })

    await assert.rejects(
      controls.read("workspace", { directory: projectDirectory }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
  })

  it("fences a mutation again immediately before the atomic rename", async () => {
    const fixture = createFixture({
      runtime: [activePlugin("known", "known-package")],
      assertCurrent: (count) => { if (count === 4) throw new Error("stale connection") },
    })
    const before = fs.readFileSync(fixture.globalFile, "utf8")

    await assert.rejects(
      fixture.controls.mutate("workspace", {
        location: fixture.location,
        pluginId: "known",
        scope: "global",
        enabled: false,
      }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )

    assert.equal(fixture.calls.assertCurrent, 4)
    assert.equal(fs.readFileSync(fixture.globalFile, "utf8"), before)
  })

  it("fences a no-op mutation after reading the target document", async () => {
    const fixture = createFixture({
      globalPlugins: ["-known"],
      runtime: [],
      assertCurrent: (count) => { if (count === 3) throw new Error("stale connection") },
    })

    await assert.rejects(
      fixture.controls.mutate("workspace", {
        location: fixture.location,
        pluginId: "known",
        scope: "global",
        enabled: false,
      }),
      (error: unknown) => error instanceof PluginControlsError && error.kind === "unavailable",
    )
    assert.equal(fixture.calls.assertCurrent, 3)
  })
})

function createFixture(options: {
  globalPlugins?: unknown[]
  reportedGlobalPlugins?: unknown[]
  projectPlugins?: unknown[]
  reportedProjectPlugins?: unknown[]
  runtime?: any[]
  omitProjectDocument?: boolean
  ownsLocation?: boolean
  assertCurrent?: (count: number) => void
  worktreeDeletionFence?: { enter(identities: string[]): (() => void) | undefined }
} = {}) {
  const root = temporaryDirectory()
  const globalDirectory = path.join(root, "daemon-config")
  const projectDirectory = path.join(root, "project")
  const globalFile = path.join(globalDirectory, "opencode.jsonc")
  const projectFile = path.join(projectDirectory, ".opencode", "opencode.jsonc")
  fs.mkdirSync(globalDirectory, { recursive: true })
  fs.mkdirSync(path.dirname(projectFile), { recursive: true })
  fs.writeFileSync(globalFile, `${JSON.stringify({ plugins: options.globalPlugins ?? [] }, null, 2)}\n`)
  if (!options.omitProjectDocument) fs.writeFileSync(projectFile, `${JSON.stringify({ plugins: options.projectPlugins ?? [] }, null, 2)}\n`)
  const entries: any[] = [
    { type: "document", path: globalFile, info: { plugins: options.reportedGlobalPlugins ?? options.globalPlugins ?? [] } },
    { type: "directory", path: globalDirectory },
  ]
  let projectEntry: any
  if (!options.omitProjectDocument) {
    projectEntry = { type: "document", path: projectFile, info: { plugins: options.reportedProjectPlugins ?? options.projectPlugins ?? [] } }
    entries.push(projectEntry)
    entries.push({ type: "directory", path: path.dirname(projectFile) })
  }
  const runtime = options.runtime ?? []
  const manager = fakeManager({
    entries,
    runtime,
    ownsLocation: options.ownsLocation,
    assertCurrent: options.assertCurrent,
  })
  return {
    controls: new PluginControls({
      workspaceManager: manager as any,
      worktreeDeletionFence: options.worktreeDeletionFence ?? openFence(),
      logger: logger(),
    }),
    calls: manager.calls,
    location: { directory: projectDirectory },
    globalDirectory,
    projectDirectory,
    globalFile,
    projectFile,
    runtime,
    setProjectPlugins: (plugins: unknown[]) => {
      if (!projectEntry) throw new Error("Project document is omitted")
      projectEntry.info.plugins = plugins
      fs.writeFileSync(projectFile, `${JSON.stringify({ plugins }, null, 2)}\n`)
    },
  }
}

function fakeManager(options: {
  entries: any[]
  runtime: any[]
  ownsLocation?: boolean
  style?: "win32" | "posix"
  translate?: (servicePath: string) => string | undefined
  serviceDirectory?: string
  wslDistro?: string
  assertCurrent?: (count: number) => void
}) {
  const calls = { config: 0, plugins: 0, assertCurrent: 0, configLocations: [] as string[], pluginLocations: [] as string[] }
  const client = {
    config: { get: async (input: any) => { calls.config++; calls.configLocations.push(input.location.directory); return options.entries } },
    plugin: { list: async (input: any) => { calls.plugins++; calls.pluginLocations.push(input.location.directory); return { location: { directory: "unused" }, data: options.runtime } } },
  }
  return {
    calls,
    get: (id: string) => id === "workspace" ? { id } : undefined,
    getSharedServiceConnection: async () => ({
      client,
      assertCurrent: () => {
        calls.assertCurrent++
        options.assertCurrent?.(calls.assertCurrent)
      },
    }),
    ownsLocation: async () => options.ownsLocation !== false,
    getServiceDirectoryForPath: async (_id: string, directory: string) => options.serviceDirectory ?? directory,
    getWorktreeIdentityForPath: async () => "fixture-worktree",
    getServicePathStyle: () => options.style ?? (process.platform === "win32" ? "win32" : "posix"),
    getServiceWslDistro: () => options.wslDistro,
    getHostPathForServicePath: async (_id: string, servicePath: string) => options.translate?.(servicePath) ?? servicePath,
  }
}

function activePlugin(id: string, target: string) {
  return { id, source: { type: "package", target }, features: { server: true }, state: { status: "active" } }
}

function logger() {
  return { info() {}, warn() {}, error() {}, debug() {} } as any
}

function openFence() {
  return { enter: () => () => {} }
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-plugin-controls-"))
  temporaryDirectories.add(directory)
  return directory
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
