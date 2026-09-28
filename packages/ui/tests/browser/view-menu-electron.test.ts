import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron, type ElectronApplication } from "playwright"

test("real Electron View menu rebuilds native labels on initial sync, locale and window changes", { timeout: 45000 }, async () => {
  const sandbox = await mkdtemp(join(process.env.CODENOMAD_TEST_TEMP || tmpdir(), "codenomad-view-menu-"))
  let app: ElectronApplication | undefined
  try {
    const module = join(sandbox, "menu.cjs")
    await build({ entryPoints: ["menu", "menu-target"].map(name => fileURLToPath(new URL(`../../../electron-app/electron/main/${name}.ts`, import.meta.url))),
      outdir: sandbox, outExtension: { ".js": ".cjs" }, bundle: true, platform: "node", format: "cjs", external: ["electron"] })
    const env = { ...process.env, CODENOMAD_TEST_PROFILE: join(sandbox, "profile"), CODENOMAD_TEST_MENU_MODULE: module }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ timeout: 15000, executablePath: process.env.CODENOMAD_TEST_ELECTRON || createRequire(import.meta.url)("electron"),
      args: [fileURLToPath(new URL("fixtures/view-menu-electron.cjs", import.meta.url))], env })
    await app.evaluate(async ({ app }) => { await app.whenReady() })
    const makeState = (locale: string, checked = true) => Object.fromEntries(["leftPanel", "rightPanel", "timeline", "timelineTools"].map(key => [key, {
      label: `${locale}-${key}`, checked, enabled: key !== "timelineTools",
    }]))
    assert.deepEqual(await app.evaluate(() => (globalThis as any).menuFixture.snapshot()), [])
    await app.evaluate((_electron, state) => (globalThis as any).menuFixture.set(0, state), makeState("fr"))
    const read = () => app!.evaluate(() => (globalThis as any).menuFixture.snapshot())
    let native = await read()
    assert.deepEqual(native.map((item: any) => item.label), ["fr-leftPanel", "fr-rightPanel", "fr-timeline", "fr-timelineTools"])
    assert.ok(native.every((item: any) => item.checked))
    assert.equal(native[3].enabled, false)
    await app.evaluate(() => { const f = (globalThis as any).menuFixture; f.beforeMenu = f.menu() })
    await app.evaluate(() => (globalThis as any).menuFixture.blur())
    await app.evaluate((_electron, state) => (globalThis as any).menuFixture.set(0, state), makeState("fr", false))
    assert.equal(await app.evaluate(() => { const f = (globalThis as any).menuFixture; return f.beforeMenu === f.menu() }), true, "checkbox-only updates do not replace an open menu")
    assert.ok((await read()).every((item: any) => !item.checked))
    assert.ok((await read()).slice(0, 3).every((item: any) => item.enabled), "native focus gap must not disable unrelated View controls")
    assert.deepEqual(await app.evaluate(() => (globalThis as any).menuFixture.workspaceEnabled()), [true, true, true], "File commands use the same retained target")
    await app.evaluate((_electron, state) => (globalThis as any).menuFixture.set(1, state), makeState("en"))
    assert.equal((await read())[0].label, "fr-leftPanel", "background renderer cannot change focused labels")
    await app.evaluate(() => (globalThis as any).menuFixture.focus(1))
    assert.equal((await read())[0].label, "en-leftPanel")
    await app.evaluate((_electron, state) => (globalThis as any).menuFixture.set(1, state), makeState("he"))
    assert.equal((await read())[0].label, "he-leftPanel")
    await app.evaluate(() => (globalThis as any).menuFixture.click("view-right-panel"))
    const delivery = await app.evaluate(() => { const f = (globalThis as any).menuFixture; return { actions: f.actions, id: f.ids[1] } })
    assert.deepEqual(delivery.actions, [[delivery.id, "menu:action", "view-right-panel"]])
    await app.evaluate(() => (globalThis as any).menuFixture.focus(null))
    assert.ok((await read()).every((item: any) => !item.enabled))
    assert.deepEqual(await app.evaluate(() => (globalThis as any).menuFixture.workspaceEnabled()), [false, false, false], "a focused non-local window must not target the background local window")
    await app.evaluate(() => { const f = (globalThis as any).menuFixture; f.focus(0); f.clear(0) })
    assert.ok((await read()).every((item: any) => !item.enabled && !item.checked))
  } finally {
    await app?.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})
