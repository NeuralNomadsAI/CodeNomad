import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { SettingsService } from "./service"
import { SettingsReadError, YamlDocStore } from "./yaml-doc-store"
import { resolveConfigLocation } from "../config/location"

function serviceWithStore(store: Record<string, unknown>) {
  const service = Object.create(SettingsService.prototype) as SettingsService
  Object.assign(service as any, { configStore: store, eventBus: undefined })
  return service
}

describe("SettingsService config persistence", () => {
  it("preserves Tauri's ASCII-folded Unicode Windows identity without moving profile state", () => {
    if (process.platform !== "win32") return
    const service = serviceWithStore({})
    const config = resolveConfigLocation(path.resolve("Émilie", "custom.json"))
    Object.assign(service as any, { location: config })
    const oldChannel = process.env.CODENOMAD_UPDATE_CHANNEL, oldIdentity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    try {
      process.env.CODENOMAD_UPDATE_CHANNEL = "dev-v2"
      delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      const electron = service.getProfileScope()
      const tauriIdentity = path.resolve(config.configYamlPath).replaceAll("/", "\\")
        .replace(/[A-Z]/g, letter => letter.toLowerCase())
      assert.notEqual(tauriIdentity, electron.configIdentity, "Unicode lowercasing differs from ASCII-only Tauri")
      process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = tauriIdentity
      const tauri = service.getProfileScope()
      assert.equal(tauri.configIdentity, tauriIdentity)
      assert.equal(tauri.key, createHash("sha256").update(`dev-v2\0${tauriIdentity}`).digest("hex"))
      assert.notEqual(tauri.key, electron.key)
      assert.equal(config.legacyJsonPath, path.resolve("Émilie", "custom.json"))
      process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = tauriIdentity.replace("Émilie", "Other")
      assert.throws(() => service.getProfileScope(), /profile configuration differs/)
    } finally {
      if (oldChannel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
      else process.env.CODENOMAD_UPDATE_CHANNEL = oldChannel
      if (oldIdentity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = oldIdentity
    }
  })
  it("Tauri's resolved dev-v2 channel gives the same custom-profile key as the signer", () => {
    const service = serviceWithStore({})
    const oldChannel = process.env.CODENOMAD_UPDATE_CHANNEL, oldDev = process.env.CODENOMAD_DEV
    const oldIdentity = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    try {
      delete process.env.CODENOMAD_UPDATE_CHANNEL
      delete process.env.CODENOMAD_DEV
      delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      for (const extension of ["json", "yaml"] as const) {
        const original = `isolated-profile/custom.${extension}`
        const selected = path.resolve(process.cwd(), original)
        const config = resolveConfigLocation(selected)
        Object.assign(service as any, { location: config })
        assert.equal(extension === "json" ? config.legacyJsonPath : config.configYamlPath, selected)
        assert.notEqual(selected, path.resolve(process.cwd(), "other-backend-cwd", original))
        const wrong = service.getProfileScope().key
        // Tauri resolves dev-v2 without a launcher env, then passes that channel,
        // the canonical identity, and the UNCHANGED CLI_CONFIG into the backend.
        process.env.CODENOMAD_UPDATE_CHANNEL = "dev-v2"
        const scope = service.getProfileScope()
        process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = scope.configIdentity
        assert.equal(service.getProfileScope().key,
          createHash("sha256").update(`dev-v2\0${scope.configIdentity}`).digest("hex"))
        assert.equal(scope.configIdentity, process.platform === "win32"
          ? config.configYamlPath.replaceAll("/", "\\").toLowerCase() : config.configYamlPath)
        assert.notEqual(scope.key, wrong)
        process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = "other-profile"
        assert.throws(() => service.getProfileScope(), /profile configuration differs/)
        delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
        delete process.env.CODENOMAD_UPDATE_CHANNEL
      }
    } finally {
      if (oldChannel === undefined) delete process.env.CODENOMAD_UPDATE_CHANNEL
      else process.env.CODENOMAD_UPDATE_CHANNEL = oldChannel
      if (oldDev === undefined) delete process.env.CODENOMAD_DEV
      else process.env.CODENOMAD_DEV = oldDev
      if (oldIdentity === undefined) delete process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
      else process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY = oldIdentity
    }
  })
  it("normalizes and persists a document patch once", () => {
    let writes = 0
    const service = serviceWithStore({
      reloadAuthoritative: () => ({ server: { logLevel: "info" } }),
      get: () => assert.fail("a write starts from the authoritative document, never the cache"),
      replace: (value: unknown) => {
        writes += 1
        return value
      },
      mergePatch: () => assert.fail("must not persist an intermediate document"),
    })

    const result = service.mergePatchDoc("config", { ui: { theme: "dark" } })
    assert.equal(writes, 1)
    assert.deepEqual(result, { server: { logLevel: "INFO" }, ui: { theme: "dark" } })
  })

  it("normalizes and persists a server-owner patch once", () => {
    let writes = 0
    const service = serviceWithStore({
      reloadAuthoritative: () => ({}),
      getOwner: () => ({ logLevel: "info", opencodeBinary: "opencode", sidecars: [] }),
      replaceOwner: (_owner: string, value: unknown) => {
        writes += 1
        return value
      },
      mergePatchOwner: () => assert.fail("must not persist an intermediate owner"),
    })

    const result = service.mergePatchOwner("config", "server", { sidecars: [{ id: "one" }] })
    assert.equal(writes, 1)
    assert.deepEqual(result, { logLevel: "INFO", opencodeBinary: "opencode2", sidecars: [{ id: "one" }] })
  })

  it("preserves only implicit transcript defaults changed by a switch to Custom", () => {
    const toolCallExpansionDefaults = { preset: "custom" }
    const balancedTools = {
      bash: "expanded",
      read: "collapsed",
      write: "expanded",
      edit: "expanded",
      patch: "expanded",
      webfetch: "collapsed",
      websearch: "collapsed",
      glob: "collapsed",
      grep: "collapsed",
      task: "expanded",
      execute: "expanded",
      skill: "collapsed",
      question: "expanded",
      invalid: "collapsed",
      other: "collapsed",
    }
    const cases = [
      { preset: "everything", expected: { toolCallExpansionDefaults, toolGroupVisibility: "expanded" } },
      { preset: "everything", saved: { toolGroupVisibility: "hidden" }, expected: { toolCallExpansionDefaults, toolGroupVisibility: "hidden" } },
      { preset: "everything", patch: { toolGroupVisibility: "collapsed" }, expected: { toolCallExpansionDefaults, toolGroupVisibility: "collapsed" } },
      { preset: "everything", saved: { toolGroupVisibility: "hidden" }, patch: { toolGroupVisibility: null }, expected: { toolCallExpansionDefaults } },
      {
        preset: "balanced",
        expected: {
          toolCallExpansionDefaults: { preset: "custom", tools: balancedTools },
          usageMetricsExpansion: "collapsed",
        },
      },
      { preset: "custom", expected: { toolCallExpansionDefaults } },
    ]
    for (const { preset, saved, patch, expected } of cases) {
      const ui = { settings: { toolCallExpansionDefaults: { preset }, ...saved } }
      const service = serviceWithStore({ reloadAuthoritative: () => ({ ui }), replace: (value: unknown) => value })
      const result = service.mergePatchDoc("config", { ui: { settings: { toolCallExpansionDefaults, ...patch } } })
      assert.deepEqual(result.ui, { settings: expected })
    }
  })

    it("preserves absent tools and thinking under write lock without clobbering concurrent custom edits", () => {
      let ui: Record<string, unknown> = {
        settings: {
          showThinkingBlocks: true,
          thinkingBlocksExpansion: "expanded",
          toolCallExpansionDefaults: { preset: "balanced" },
        },
      }
      const service = serviceWithStore({
        reloadAuthoritative: () => ({ ui }),
        getOwner: () => ui,
        replaceOwner: (_owner: string, value: unknown) => {
          ui = value as Record<string, unknown>
          return value
        },
      })
      const first = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom", tools: { skill: "hidden" } } },
      }) as { settings: Record<string, unknown> }
      const firstDefaults = first.settings.toolCallExpansionDefaults as { thinking: string; tools: Record<string, string> }
      assert.equal(firstDefaults.thinking, "expanded")
      assert.equal(firstDefaults.tools.skill, "hidden")
      assert.equal(firstDefaults.tools.bash, "expanded")
      assert.equal(firstDefaults.tools.read, "collapsed")
      assert.equal(first.settings.usageMetricsExpansion, "collapsed")

      // A concurrent minimal patch for read arriving after skill:hidden keeps skill:hidden.
      const second = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom", tools: { read: "expanded" } } },
      }) as { settings: Record<string, unknown> }
      const secondDefaults = second.settings.toolCallExpansionDefaults as { tools: Record<string, string> }
      assert.equal(secondDefaults.tools.read, "expanded")
      assert.equal(secondDefaults.tools.skill, "hidden")

      // Retired detailed with other:hidden preserves hidden for unlisted tools like write.
      ui = { settings: { toolCallExpansionDefaults: { preset: "detailed", tools: { other: "hidden" } } } }
      const detailed = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom", tools: { read: "expanded" } } },
      }) as { settings: { toolCallExpansionDefaults: { tools: Record<string, string> } } }
      assert.equal(detailed.settings.toolCallExpansionDefaults.tools.read, "expanded")
      assert.equal(detailed.settings.toolCallExpansionDefaults.tools.write, "hidden")
      assert.equal(detailed.settings.toolCallExpansionDefaults.tools.skill, "collapsed")

      // Retired detailed with tools.other: "hidden" switching to custom via thinking expansion alone
      // must still freeze read/skill/invalid at "collapsed" and other tools at "hidden".
      ui = { settings: { toolCallExpansionDefaults: { preset: "detailed", tools: { other: "hidden" } } } }
      const detailedThinkingOnly = service.mergePatchOwner("config", "ui", {
        settings: {
          thinkingBlocksExpansion: "expanded",
          toolCallExpansionDefaults: { preset: "custom", thinking: "expanded" },
        },
      }) as { settings: { toolCallExpansionDefaults: { thinking: string; tools: Record<string, string> } } }
      assert.equal(detailedThinkingOnly.settings.toolCallExpansionDefaults.thinking, "expanded")
      assert.equal(detailedThinkingOnly.settings.toolCallExpansionDefaults.tools.read, "collapsed")
      assert.equal(detailedThinkingOnly.settings.toolCallExpansionDefaults.tools.write, "hidden")

      ui = { settings: { toolCallExpansionDefaults: { preset: "detailed", tools: { other: "hidden" } } } }
      const detailedLegacyThinkingOnly = service.mergePatchOwner("config", "ui", {
        settings: {
          thinkingBlocksExpansion: "expanded",
          toolCallExpansionDefaults: { preset: "custom" },
        },
      }) as { settings: { toolCallExpansionDefaults: { thinking: string; tools: Record<string, string> } } }
      assert.equal(detailedLegacyThinkingOnly.settings.toolCallExpansionDefaults.thinking, "expanded")
      assert.equal(detailedLegacyThinkingOnly.settings.toolCallExpansionDefaults.tools.read, "collapsed")
      assert.equal(detailedLegacyThinkingOnly.settings.toolCallExpansionDefaults.tools.write, "hidden")

      // Partial custom hiding "other" freezes unlisted tools at their pre-patch effective value.
      ui = { settings: { toolOutputExpansion: "expanded", toolCallExpansionDefaults: { preset: "custom", tools: { bash: "collapsed" } } } }
      const partialCustom = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom", tools: { other: "hidden" } } },
      }) as { settings: { toolCallExpansionDefaults: { tools: Record<string, string> } } }
      assert.equal(partialCustom.settings.toolCallExpansionDefaults.tools.other, "hidden")
      assert.equal(partialCustom.settings.toolCallExpansionDefaults.tools.bash, "collapsed")
      assert.equal(partialCustom.settings.toolCallExpansionDefaults.tools.write, "expanded")

      // Explicit tools: null deletion is honored rather than overwritten.
      ui = { settings: { toolCallExpansionDefaults: { preset: "balanced", tools: { read: "hidden" } } } }
      const deleted = service.mergePatchOwner("config", "ui", {
        settings: { showThinkingBlocks: false, toolCallExpansionDefaults: { preset: "custom", tools: null } },
      }) as { settings: { toolCallExpansionDefaults: Record<string, unknown> } }
      assert.equal("tools" in deleted.settings.toolCallExpansionDefaults, false)

      // Explicit thinkingBlocksExpansion in the same PATCH is not clobbered by legacy fallback.
      ui = { settings: { thinkingBlocksExpansion: "collapsed", toolCallExpansionDefaults: { preset: "balanced" } } }
      const explicitThinking = service.mergePatchOwner("config", "ui", {
        settings: {
          thinkingBlocksExpansion: "expanded",
          toolCallExpansionDefaults: { preset: "custom", tools: { read: "expanded" } },
        },
      }) as { settings: { thinkingBlocksExpansion: string; toolCallExpansionDefaults: { thinking: string } } }
      assert.equal(explicitThinking.settings.thinkingBlocksExpansion, "expanded")
      assert.equal(explicitThinking.settings.toolCallExpansionDefaults.thinking, "expanded")

      // Hiding Tokens on a partial detailed profile freezes implicit usageMetricsExpansion ("expanded"),
      // without clobbering an explicit concurrent usageMetricsExpansion ("collapsed").
      ui = { settings: { toolCallExpansionDefaults: { preset: "detailed" } } }
      const hiddenDetailedUsage = service.mergePatchOwner("config", "ui", {
        settings: { showUsageMetrics: false },
      }) as { settings: { showUsageMetrics: boolean; usageMetricsExpansion: string } }
      assert.equal(hiddenDetailedUsage.settings.showUsageMetrics, false)
      assert.equal(hiddenDetailedUsage.settings.usageMetricsExpansion, "expanded")

      ui = { settings: { usageMetricsExpansion: "collapsed", toolCallExpansionDefaults: { preset: "detailed" } } }
      const hiddenExplicitUsage = service.mergePatchOwner("config", "ui", {
        settings: { showUsageMetrics: false },
      }) as { settings: { usageMetricsExpansion: string } }
      assert.equal(hiddenExplicitUsage.settings.usageMetricsExpansion, "collapsed")

      // Explicit tools: null on a fresh empty profile strips null for both custom and built-in presets,
      // and strips any nested RFC 7396 null keys when replacing a non-object container.
      ui = {}
      const freshDeleted = service.mergePatchOwner("config", "ui", {
        settings: {
          showThinkingBlocks: false,
          toolCallExpansionDefaults: { preset: "custom", thinking: null, tools: null },
        },
      }) as { settings: { toolCallExpansionDefaults: Record<string, unknown> } }
      assert.equal("tools" in freshDeleted.settings.toolCallExpansionDefaults, false)
      assert.equal("thinking" in freshDeleted.settings.toolCallExpansionDefaults, false)

      ui = {}
      const freshUsageNull = service.mergePatchOwner("config", "ui", {
        settings: { showUsageMetrics: false, usageMetricsExpansion: null },
      }) as { settings: Record<string, unknown> }
      assert.equal(freshUsageNull.settings.showUsageMetrics, false)
      assert.equal("usageMetricsExpansion" in freshUsageNull.settings, false)

      ui = {}
      const freshBalancedDeleted = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "balanced", tools: null } },
      }) as { settings: { toolCallExpansionDefaults: Record<string, unknown> } }
      assert.equal("tools" in freshBalancedDeleted.settings.toolCallExpansionDefaults, false)

      // Pure preset:"custom" PATCH on a partial "nothing" profile preserves inherited hidden tools.
      ui = { settings: { toolCallExpansionDefaults: { preset: "nothing" } } }
      const pureCustomFromNothing = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom" } },
      }) as { settings: { usageMetricsExpansion: string; toolCallExpansionDefaults: { tools: Record<string, string> } } }
      assert.equal(pureCustomFromNothing.settings.usageMetricsExpansion, "collapsed")
      assert.equal(pureCustomFromNothing.settings.toolCallExpansionDefaults.tools.read, "hidden")
      assert.equal(pureCustomFromNothing.settings.toolCallExpansionDefaults.tools.bash, "hidden")

      // Partial "detailed" profile without a tools object strips explicit read:null instead of persisting null.
      ui = { settings: { toolCallExpansionDefaults: { preset: "detailed" } } }
      const detailedDeleteRead = service.mergePatchOwner("config", "ui", {
        settings: { toolCallExpansionDefaults: { preset: "custom", tools: { read: null } } },
      }) as { settings: { toolCallExpansionDefaults: { tools: Record<string, unknown> } } }
      assert.equal("read" in detailedDeleteRead.settings.toolCallExpansionDefaults.tools, false)
      assert.equal(detailedDeleteRead.settings.toolCallExpansionDefaults.tools.skill, "collapsed")
      assert.equal(detailedDeleteRead.settings.toolCallExpansionDefaults.tools.bash, "expanded")

      // Deeply nested RFC 7396 nulls inside newly created containers under settings are stripped recursively.
      ui = {}
      const nestedNull = service.mergePatchOwner("config", "ui", {
        settings: { notificationRouting: { sessionDone: { system: null } } },
      }) as { settings: { notificationRouting: { sessionDone: Record<string, unknown> } } }
      assert.equal(nestedNull.settings.notificationRouting.sessionDone.screen, false)
      assert.equal("system" in nestedNull.settings.notificationRouting.sessionDone, false)

      // Top-level { ui: { settings: null } } via mergePatchDoc on an empty config strips settings:null.
      let doc: Record<string, unknown> = {}
      const docService = serviceWithStore({
        reloadAuthoritative: () => doc,
        getOwner: (owner: string) => (doc[owner] as Record<string, unknown>) ?? {},
        replace: (value: unknown) => {
          doc = value as Record<string, unknown>
          return value
        },
        replaceOwner: (owner: string, value: unknown) => {
          doc = { ...doc, [owner]: value }
          return value
        },
      })
      const docPatched = docService.mergePatchDoc("config", { ui: { settings: null } }) as { ui: Record<string, unknown> }
      assert.equal("settings" in docPatched.ui, false)

      // First notificationRouting migration seeds legacy flags under the write lock without clobbering concurrent cells.
      ui = { settings: { osNotificationsEnabled: false, notifyOnIdle: false } }
      const routed1 = service.mergePatchOwner("config", "ui", {
        settings: { notificationRouting: { copy: { history: true } } },
      }) as { settings: { notificationRouting: Record<string, Record<string, boolean>> } }
      assert.equal(routed1.settings.notificationRouting.copy.history, true)
      assert.equal(routed1.settings.notificationRouting.updates.system, false)
      assert.equal(routed1.settings.notificationRouting.sessionDone.system, false)
      const routed2 = service.mergePatchOwner("config", "ui", {
        settings: { notificationRouting: { files: { screen: false } } },
      }) as { settings: { notificationRouting: Record<string, Record<string, boolean>> } }
      assert.equal(routed2.settings.notificationRouting.copy.history, true)
      assert.equal(routed2.settings.notificationRouting.files.screen, false)

      // Atomic secureEnvVarsMask merges concurrent secrets under the write lock without persisting the transient key.
      let serverOwner: Record<string, unknown> = {}
      const serverService = serviceWithStore({
        reloadAuthoritative: () => ({ server: serverOwner }),
        getOwner: () => serverOwner,
        replaceOwner: (_owner: string, value: unknown) => {
          serverOwner = value as Record<string, unknown>
          return value
        },
      })
      const env1 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { SECRET_A: "1" },
        secureEnvVarsMask: { SECRET_A: true },
      }) as Record<string, unknown>
      assert.deepEqual(env1.secureEnvVars, ["SECRET_A"])
      assert.equal("secureEnvVarsMask" in env1, false)
      const env2 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { SECRET_B: "2" },
        secureEnvVarsMask: { SECRET_B: true },
      }) as Record<string, unknown>
      assert.deepEqual(env2.secureEnvVars, ["SECRET_A", "SECRET_B"])
      const env3 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { SECRET_A: null },
        secureEnvVarsMask: { SECRET_A: false },
      }) as Record<string, unknown>
      assert.deepEqual(env3.secureEnvVars, ["SECRET_B"])

      // Unicode case-folding matches Solid's toUpperCase() (É_TOKEN and é_TOKEN share one mask entry),
      // Case-insensitive secureEnvVars matching Solid (`toUpperCase()`),
      // and conflicting equivalent keys in one mask fail safe (mask wins deterministically).
      const env4 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { "É_TOKEN": "1" },
        secureEnvVarsMask: { "É_TOKEN": true },
      }) as Record<string, unknown>
      const env5 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { "é_TOKEN": "2" },
        secureEnvVarsMask: { "é_TOKEN": true },
      }) as Record<string, unknown>
      assert.deepEqual(env4.secureEnvVars, ["SECRET_B", "É_TOKEN"])
      assert.deepEqual(env5.secureEnvVars, ["SECRET_B", "é_TOKEN"])
      const env6 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { TOKEN: "3" },
        secureEnvVarsMask: { token: false, TOKEN: true },
      }) as Record<string, unknown>
      assert.deepEqual(env6.secureEnvVars, ["SECRET_B", "é_TOKEN", "TOKEN"])

      // Deleting one POSIX case-variant while a sibling survives keeps the surviving sibling masked.
      const env7 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { token: "lower" },
        secureEnvVarsMask: { token: true },
      }) as Record<string, unknown>
      assert.deepEqual(env7.secureEnvVars, ["SECRET_B", "é_TOKEN", "token"])
      const env8 = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { token: null },
        secureEnvVarsMask: { token: false },
      }) as Record<string, unknown>
      assert.deepEqual(env8.secureEnvVars, ["SECRET_B", "é_TOKEN", "token"])
      assert.equal((env8.environmentVariables as Record<string, unknown>).TOKEN, "3")
      assert.equal("token" in (env8.environmentVariables as Record<string, unknown>), false)

      // Explicit `secureEnvVars: null` resets prior masks before applying `secureEnvVarsMask`.
      const env9 = serverService.mergePatchOwner("config", "server", {
        secureEnvVars: null,
        secureEnvVarsMask: { NEW: true },
      }) as Record<string, unknown>
      assert.deepEqual(env9.secureEnvVars, ["NEW"])

      // Deleting an existing speech.stt object via explicit null clears it completely.
      serverOwner = { speech: { stt: { baseUrl: "https://stt.example", apiKey: "secret" } } }
      const clearedSpeech = serverService.mergePatchOwner("config", "server", {
        speech: { stt: null },
      }) as { speech: Record<string, unknown> }
      assert.equal("stt" in clearedSpeech.speech, false)

      // Deleting a notification category or environment variable on first creation leaves it absent.
      ui = {}
      const deletedCategory = service.mergePatchOwner("config", "ui", {
        settings: { notificationRouting: { sessionDone: null } },
      }) as { settings: { notificationRouting: Record<string, unknown> } }
      assert.equal("sessionDone" in deletedCategory.settings.notificationRouting, false)
      assert.equal("needsInput" in deletedCategory.settings.notificationRouting, true)

      serverOwner = {}
      const deletedEnv = serverService.mergePatchOwner("config", "server", {
        environmentVariables: { TOKEN: null },
      }) as { environmentVariables: Record<string, unknown> }
      assert.deepEqual(deletedEnv.environmentVariables, {})

      // State owner & full-doc PATCH reload authoritatively once and strip first-pass nested nulls on ui.
      let diskState: Record<string, unknown> = { ui: { existing: true } }
      let ownerAuth = false
      let docAuth = false
      const stateService = Object.create(SettingsService.prototype) as SettingsService
      Object.assign(stateService as any, {
        stateStore: {
          mergePatchOwner: (
            _owner: string,
            patch: Record<string, unknown>,
            opts?: { authoritative?: boolean; prepare?: (before: Record<string, unknown>, raw: Record<string, unknown>) => Record<string, unknown> },
          ) => {
            ownerAuth = opts?.authoritative === true
            const beforeOwner = (diskState.ui as Record<string, unknown>) ?? {}
            const effective = opts?.prepare ? opts.prepare(beforeOwner, patch) : patch
            const next = { ...beforeOwner, ...effective }
            diskState = { ...diskState, ui: next }
            return next
          },
          mergePatch: (
            patch: Record<string, unknown>,
            opts?: { authoritative?: boolean; prepare?: (before: Record<string, unknown>, raw: Record<string, unknown>) => Record<string, unknown> },
          ) => {
            docAuth = opts?.authoritative === true
            const effective = opts?.prepare ? opts.prepare(diskState, patch) : patch
            diskState = { ...diskState, ...effective }
            return diskState
          },
        },
        logger: { warn: () => {} },
      })
      const savedState = stateService.mergePatchOwner("state", "ui", {
        appearancePreferences: { light: { presetId: null, scheme: { id: "linen" } } },
      }) as { existing: boolean; appearancePreferences: { light: Record<string, unknown> } }
      assert.equal(ownerAuth, true)
      assert.equal(savedState.existing, true)
      assert.equal("presetId" in savedState.appearancePreferences.light, false)
      const savedDoc = stateService.mergePatchDoc("state", {
        ui: { appearancePreferences: { dark: { presetId: null } } },
      }) as { ui: { appearancePreferences: { dark: Record<string, unknown> } } }
      assert.equal(docAuth, true)
      assert.equal("presetId" in savedDoc.ui.appearancePreferences.dark, false)
    })

  it("keeps only known update feeds", () => {
    const owner = (updateFeed: unknown) => serviceWithStore({
      reloadAuthoritative: () => ({}),
      getOwner: () => ({}),
      replaceOwner: (_owner: string, value: unknown) => value,
    }).mergePatchOwner("config", "server", { updateFeed })
    assert.deepEqual(owner("preview"), { updateFeed: "preview" })
    assert.deepEqual(owner("stable"), { updateFeed: "stable" })
    assert.deepEqual(owner("dev"), {})
    assert.deepEqual(owner(null), {})
  })

  it("keeps the desktop host's server.implementation choice", () => {
    const service = serviceWithStore({
      reloadAuthoritative: () => ({}),
      getOwner: () => ({ implementation: "rust" }),
      replaceOwner: (_owner: string, value: unknown) => value,
    })
    assert.deepEqual(service.mergePatchOwner("config", "server", { logLevel: "info" }), { implementation: "rust", logLevel: "INFO" })
  })

  it("does not report a persisted patch as failed when an event listener throws", () => {
    let warnings = 0
    const service = serviceWithStore({
      reloadAuthoritative: () => ({}),
      getOwner: () => ({}),
      replaceOwner: (_owner: string, value: unknown) => value,
    })
    Object.assign(service as any, {
      eventBus: { publish: () => { throw new Error("listener failed") } },
      logger: { warn: () => { warnings += 1 } },
    })

    assert.deepEqual(service.mergePatchOwner("config", "ui", { theme: "dark" }), { theme: "dark" })
    assert.equal(warnings, 1)
  })

  it("refuses authoritative reads when state.yaml contains invalid UTF-8 bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-utf8-"))
    const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any
    try {
      const statePath = path.join(dir, "state.yaml")
      fs.writeFileSync(statePath, "ui:\n  note: \"ok\"\n", "utf-8")
      const validStore = new YamlDocStore(statePath, logger)
      assert.deepEqual(validStore.reloadAuthoritative(), { ui: { note: "ok" } })

      fs.writeFileSync(statePath, Buffer.concat([Buffer.from("ui:\n  note: \"ok"), Buffer.from([0xff, 0xfe]), Buffer.from("\"\n")]))
      const store = new YamlDocStore(statePath, logger)
      assert.throws(() => store.reloadAuthoritative(), SettingsReadError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("matches Solid case-insensitive secureEnvVars semantics and preserves mask on sibling delete", () => {
    let owner: Record<string, unknown> = {
      environmentVariables: { TOKEN: "old", token: "other" },
      secureEnvVars: ["Token"],
    }
    const service = serviceWithStore({
      reloadAuthoritative: () => ({ server: owner }),
      getOwner: () => owner,
      replaceOwner: (_owner: string, value: unknown) => {
        owner = value as Record<string, unknown>
        return value
      },
    })
    // Editing TOKEN with mask=false removes the legacy mixed-case entry ["Token"] cleanly.
    const unmasked = service.mergePatchOwner("config", "server", {
      environmentVariables: { TOKEN: "new" },
      secureEnvVarsMask: { TOKEN: false },
    }) as Record<string, unknown>
    assert.deepEqual(unmasked.environmentVariables, { TOKEN: "new", token: "other" })
    assert.deepEqual(unmasked.secureEnvVars, [])

    // Malformed non-boolean secureEnvVarsMask is rejected before saving unmasked secrets.
    assert.throws(() =>
      service.mergePatchOwner("config", "server", {
        environmentVariables: { BAD: "secret" },
        secureEnvVarsMask: { BAD: "true" },
      }),
    )

    // Deleting `token` while `TOKEN` survives keeps the case-insensitive mask intact.
    owner = {
      environmentVariables: { TOKEN: "secret", token: "other" },
      secureEnvVars: ["TOKEN"],
    }
    const afterDelete = service.mergePatchOwner("config", "server", {
      environmentVariables: { token: null },
      secureEnvVarsMask: { token: false },
    }) as Record<string, unknown>
    assert.deepEqual(afterDelete.environmentVariables, { TOKEN: "secret" })
    assert.deepEqual(afterDelete.secureEnvVars, ["TOKEN"])
  })

  it("quotes YAML 1.1 and 1.2 scalar-like strings across authoritative reloads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-yaml-quote-"))
    const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } as any
    try {
      const configPath = path.join(dir, "config.yaml")
      const store = new YamlDocStore(configPath, logger)
      const values = {
        OCT12: "0o10",
        BIN11: "0b101",
        OCT11: "010",
        BOOL11: "yes",
        BOOL12: "true",
        NEL: "alpha\u0085beta",
        LS: "alpha\u2028beta",
        PS: "alpha\u2029beta",
      }
      store.mergePatchOwner("server", { environmentVariables: values })
      const reloaded = store.reloadAuthoritative() as any
      assert.deepEqual(reloaded.server.environmentVariables, values)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
