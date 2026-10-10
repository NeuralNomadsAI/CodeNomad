import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { PREFERENCES_SECTIONS, createPreferencesUrl, requirePreferencesRequest, requirePreferencesSection } from "../../../electron-app/electron/main/preferences-window"
import { normalizeNativePreferencesRequest, readPreferencesRequestFromUrl } from "./native/preferences-window"
import type { SettingsSectionId } from "../stores/settings-screen"

const providersSection: SettingsSectionId = "providers"

function sourceSections(path: string, declaration: RegExp): string[] {
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
  const block = source.match(declaration)?.[1]
  assert.ok(block, `preferences section declaration in ${path}`)
  return [...block.matchAll(/"([a-z-]+)"/g)].map(match => match[1])
}

describe("Native Preferences section parity", () => {
  it("keeps renderer, Electron, Tauri and the Settings union on the exact same allowlist", () => {
    const renderer = sourceSections("./native/preferences-window.ts", /const sections = new Set<SettingsSectionId>\(\[([\s\S]*?)\]\)/)
    const tauri = sourceSections("../../../tauri-app/src-tauri/src/preferences_window.rs", /const SECTIONS: &\[&str\] = &\[([\s\S]*?)\];/)
    const settings = sourceSections("../stores/settings-screen.ts", /export type SettingsSectionId =([\s\S]*?)(?=\nconst |\nexport )/)
    const expected = [...PREFERENCES_SECTIONS].sort()
    assert.ok(expected.includes(providersSection))
    assert.ok(expected.includes("missions") && renderer.includes("missions") && settings.includes("missions"), "Mission preferences are a Settings section")
    for (const [name, sections] of Object.entries({ renderer, tauri, settings })) {
      assert.equal(new Set(sections).size, sections.length, `${name} has no duplicate sections`)
      assert.deepEqual(sections.sort(), expected, `${name} matches Electron`)
    }
  })

  it("accepts a Providers request and preserves its owned window/location context in both TypeScript hosts", () => {
    const context = {
      instanceId: "workspace-1", scrollTop: 128,
      location: { directory: "D:/CodeNomad/project", workspaceID: "worktree-1" },
    }
    assert.equal(requirePreferencesSection(providersSection), providersSection)
    assert.deepEqual(normalizeNativePreferencesRequest(providersSection), { section: providersSection })
    const nativeRequest = requirePreferencesRequest(providersSection, context)
    assert.deepEqual(nativeRequest, { section: providersSection, ...context })
    assert.deepEqual(normalizeNativePreferencesRequest(nativeRequest), nativeRequest)
  })

  it("round-trips the Providers section through the Preferences URL without dropping existing query data", () => {
    const url = createPreferencesUrl("https://localhost:3000/app?keep=yes", providersSection)
    assert.equal(url.searchParams.get("keep"), "yes")
    assert.deepEqual(readPreferencesRequestFromUrl(url.toString()), { section: providersSection })
    url.searchParams.set("preferencesInstanceId", "workspace-1")
    url.searchParams.set("preferencesDirectory", "D:/CodeNomad/project")
    url.searchParams.set("preferencesWorkspaceId", "worktree-1")
    assert.deepEqual(readPreferencesRequestFromUrl(url.toString()), {
      section: providersSection, instanceId: "workspace-1",
      location: { directory: "D:/CodeNomad/project", workspaceID: "worktree-1" },
    })
  })

  it("accepts the exact Missions section but no Mission-like variants", () => {
    assert.equal(requirePreferencesSection("missions"), "missions")
    assert.deepEqual(normalizeNativePreferencesRequest("missions"), { section: "missions" })
    for (const section of ["mission", "Missions", "missions/admin", "workspace", ""]) {
      assert.throws(() => requirePreferencesSection(section), /Invalid preferences section/)
      assert.equal(normalizeNativePreferencesRequest(section), null)
      assert.equal(normalizeNativePreferencesRequest({ section }), null)
      assert.equal(readPreferencesRequestFromUrl(`https://localhost:3000/?preferences=${encodeURIComponent(section)}`), null)
    }
  })
})
