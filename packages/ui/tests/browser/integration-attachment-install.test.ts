// ST2: original host-installation and source-removal scenarios through Status and Plugins.
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Page } from "playwright"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS } from "../../../../scripts/fixtures/fake-integration/index.mjs"
import {
  call, confirmationReady, count, dialogNamed, echoes, expandPlugins, expandSection, failureKinds, failResponse, held,
  installationReady, installButton, installLabel, launchInstallation, line, nextToast, pluginRowMenu, privateHost,
  refreshInstallation, sectionMenu, sentinelOptions, shell, updateLabel, useAttachmentBrowser,
  waitConversation, withAttachment,
} from "./integration-attachment-harness"

useAttachmentBrowser()

test("AC-C15 sessionless install/update needs fresh active native status and a package version, never offers or a conversation", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await shell(page, "showInfo")
    await installationReady(page, model)
    for (const variation of [
      { state: "inactive" }, { state: "ok", family: "api" },
      { family: "native", host: "unknown" }, { host: "unsupported" },
      { host: "absent", hostAction: undefined }, { hostAction: "install", version: "" },
    ]) {
      Object.assign(model, variation)
      await refreshInstallation(page)
      await expandSection(page)
      assert.equal(await line(page, "application").getByRole("button", { name: /^(Install in|Update) application/ }).count(), 0)
    }
    model.version = "1.2.3"
    for (const [host, hostAction, name] of [["absent", "install", installLabel], ["outdated", "update", updateLabel]] as const) {
      Object.assign(model, { host, hostAction })
      await refreshInstallation(page)
      const dialog = await launchInstallation(page, name)
      assert.match(await dialog.innerText(), /Blender.*OpenCode for Blender 1\.2\.3/s)
      assert.match(await dialog.innerText(), /machine where OpenCode runs/)
      assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    assert.equal(calls.some(call => ["hosts", "attach", "detach", "install-host"].includes(call.action)), false)
  })
})

for (const [width, height, locale] of [[1500, 850, "en"], [390, 850, "en"], [390, 480, "en"], [390, 850, "he"]] as const)
test(`AC-C5/C15 shared confirmation ${width}x${height} ${locale}: Cancel focus/ring and all dismissals dispatch nothing`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    if (locale === "he") {
      await shell(page, "setLocale", "he")
      await page.waitForFunction(() => document.documentElement.dir === "rtl" && (window as any).integrationFixture.installLabel() !== "Install in application…")
    }
    const name = await call(page, "installLabel")
    for (const dismissal of ["Enter", "Cancel", "Escape", "backdrop"]) {
      const opener = await installButton(page, name).elementHandle()
      const dialog = await launchInstallation(page, name)
      await call(page, "event", "plugin.updated", {}, "other-workspace")
      await page.waitForFunction(() => {
        const button = document.querySelector('.alert-dialog button.button-secondary')
        if (button !== document.activeElement || !button) return false
        const style = getComputedStyle(button)
        return style.outlineStyle !== "none" && style.outlineWidth !== "0px" && style.boxShadow !== "none"
      })
      assert.equal(await dialog.locator("button.button-primary").count(), 1)
      const box = await dialog.boundingBox()
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
      if (dismissal === "Cancel") await dialog.locator("button.button-secondary").click()
      else if (dismissal === "backdrop") await page.mouse.click(width - 2, height - 2)
      else await page.keyboard.press(dismissal)
      await dialog.waitFor({ state: "hidden" })
      await page.waitForFunction(element => element === document.activeElement, opener)
      assert.equal(count(calls, "install-host"), 0)
    }
  }, width, height)
})

test("AC-C5/C15 installer rejects sub-500ms activation and admits exactly one double-click after 600ms", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    const time = new Date("2026-11-03T12:00:00Z")
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    const dialog = await launchInstallation(page)
    const confirm = dialog.locator("button.button-primary")
    await page.clock.runFor(499)
    assert.equal(await confirm.isDisabled(), true)
    await confirm.dispatchEvent("click")
    await confirm.dispatchEvent("dblclick")
    assert.equal(count(calls, "install-host"), 0)
    await page.clock.runFor(101)
    assert.equal(await confirm.isEnabled(), true)
    model.holdInstall = true
    await confirm.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    const request = await held(model)
    assert.equal(count(calls, "install-host"), 1)
    await request.fulfill({ json: { outcome: "installed" } })
    await page.waitForFunction(() => (window as any).integrationFixture.toasts().length > 0)
  })
})

const installInvalidations: Array<[string, (page: Page) => Promise<unknown>]> = [
  ["session navigation", async page => { await shell(page, "addSession", "other"); await shell(page, "selectSession", "other") }],
  ["session roundtrip", async page => { await shell(page, "addSession", "other"); await shell(page, "selectSession", "other"); await shell(page, "selectSession", "session") }],
  ["Location navigation", page => call(page, "move", "session", "/other-repo")],
  ["instance navigation", page => call(page, "instance", "other-workspace")],
  ["surface hiding", page => page.getByRole("tab", { name: "Files", exact: true, includeHidden: true }).dispatchEvent("click")],
  ["panel hiding", page => page.locator('button[aria-label="Right panel"]').dispatchEvent("click")],
  ["inactive surface", page => shell(page, "setActive", false)],
  ...["plugin.updated", "config.updated", "rpc.neuralnomads.blender.status_changed"].map(type => [type, (page: Page) => call(page, "event", type)] as [string, (page: Page) => Promise<unknown>]),
  ["session invalidation", page => call(page, "event", "session.updated", { sessionID: "session" })],
  ["reconnect", page => call(page, "reconnect")],
  ["stream open", page => call(page, "open")],
  ["disconnect", page => call(page, "disconnect")],
  ["renderer disconnect", page => call(page, "transportDisconnect")],
  ["workspace stop", page => call(page, "stop", "header-windows")],
]
for (const [name, invalidate] of installInvalidations) test(`AC-C15 ${name} revokes preconsent without installer dispatch`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    const opener = await installButton(page).elementHandle()
    const dialog = await launchInstallation(page)
    await invalidate(page)
    await dialog.waitFor({ state: "hidden", timeout: 3000 })
    await page.waitForTimeout(100)
    assert.equal(await opener!.evaluate(element => element === document.activeElement), false)
    await page.keyboard.press("Enter")
    assert.equal(count(calls, "install-host"), 0)
  })
})

test("AC-C15 unrelated instance events retain consent; all five outcomes send one empty POST to the captured Location", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    await call(page, "move", "session", "/installation-repo")
    await page.waitForTimeout(450)
    for (const outcome of ["installed", "updated", "unchanged", "refused", "failed"]) {
      model.installOutcome = outcome
      const dialog = await launchInstallation(page)
      await call(page, "event", "plugin.updated", {}, "other-workspace")
      await call(page, "event", "rpc.neuralnomads.blender.status_changed", {}, "other-workspace")
      assert.equal(await dialog.isVisible(), true)
      const before = (await call(page, "toasts")).length
      await confirmationReady(page)
      await dialog.getByRole("button", { name: installLabel, exact: true }).click()
      const toast = await nextToast(page, before)
      assert.match(toast.message, new RegExp(outcome === "unchanged" ? "already up to date" : outcome))
      assert.equal(toast.variant, ["refused", "failed"].includes(outcome) ? "error" : "success")
      assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "installer result")
    }
    assert.deepEqual(calls.filter(call => call.action === "install-host"), Array.from({ length: 5 }, () => ({ action: "install-host", directory: "/installation-repo", body: {}, method: "POST" })))
    assert.equal(calls.some(call => ["hosts", "attach", "detach"].includes(call.action)), false)
  })
})

test("AC-C15 unsupported WSL hides installation; mirrored compatible status still handles route refusal safely", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    model.host = "unsupported"
    await refreshInstallation(page)
    assert.equal(await installButton(page).count(), 0)
    assert.equal(count(calls, "install-host"), 0)
    model.host = "absent"
    await refreshInstallation(page)
    model.holdInstall = true
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await confirmationReady(page)
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    await (await held(model)).fulfill({ status: 422, json: { code: "unsupported", error: privateHost } })
    const toast = await nextToast(page, before)
    assert.match(toast.message, /Not supported on this OpenCode machine/)
    assert.equal(toast.variant, "error")
    assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "WSL refusal")
    assert.equal(count(calls, "install-host"), 1)
  })
})

for (const name of ["session navigation", "surface hiding"]) test(`AC-C15 held installation after ${name} never publishes wrong-view feedback or retries`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    model.holdInstall = true
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await confirmationReady(page)
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    const request = await held(model)
    assert.equal(await installButton(page).count(), 0, "pending installer offers no second invocation")
    await installInvalidations.find(([value]) => value === name)![1](page)
    await request.fulfill({ json: { outcome: "installed" } })
    await page.waitForTimeout(200)
    assert.equal((await call(page, "toasts")).length, before)
    assert.equal(count(calls, "install-host"), 1)
  })
})

for (const kind of [...failureKinds, "invalid-outcome"] as const) test(`AC-C15 installer ${kind}: private uncertainty, no replay and no late-navigation feedback`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    if (kind === "invalid-outcome") model.installOutcome = FAKE_INTEGRATION_SENTINELS.token
    else model.failure = { action: "install-host", kind }
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await confirmationReady(page)
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    const toast = await nextToast(page, before)
    assert.match(toast.message, /Uncertain outcome.*Check the application before trying again/s)
    assert.equal(toast.variant, "error")
    assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "installer failure")
    await echoes(page)
    await call(page, "event", "plugin.updated")
    await call(page, "event", "config.updated")
    await call(page, "reconnect")
    await call(page, "open")
    await page.waitForTimeout(650)
    assert.equal(count(calls, "install-host"), 1)
    model.failure = undefined
    model.holdInstall = true
    const fresh = await launchInstallation(page)
    await confirmationReady(page)
    await fresh.getByRole("button", { name: installLabel, exact: true }).click()
    const late = await held(model), toastCount = (await call(page, "toasts")).length
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    if (kind === "invalid-outcome") await late.fulfill({ json: { outcome: FAKE_INTEGRATION_SENTINELS.token, detail: privateHost } })
    else await failResponse(late, kind)
    await page.waitForTimeout(150)
    assert.equal((await call(page, "toasts")).length, toastCount)
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "late installer failure")
    assert.equal(count(calls, "install-host"), 2)
  })
})

for (const change of ["hidden", "disabled", "detached", "digest"]) test(`AC-C15 installation ${change} suppresses opener restoration`, async () => {
  await withAttachment(async ({ page, model }) => {
    await installationReady(page, model)
    const opener = await installButton(page).elementHandle()
    const dialog = await launchInstallation(page)
    if (change === "digest") { model.version = "9.9.9"; await call(page, "refresh") }
    else {
      await opener!.evaluate((element, change) => {
        if (change === "hidden") (element as HTMLElement).style.display = "none"
        else if (change === "disabled") (element as HTMLButtonElement).disabled = true
        else element.remove()
      }, change)
      await page.keyboard.press("Escape")
    }
    await dialog.waitFor({ state: "hidden" })
    await page.waitForTimeout(100)
    assert.equal(await opener!.evaluate(element => element === document.activeElement), false)
  })
})

async function launchRemoval(page: Page, surface: "plugins" | "section", guardedClock = false) {
  if (surface === "plugins") { await expandPlugins(page); await pluginRowMenu(page).click() }
  else { await expandSection(page); await sectionMenu(page).click() }
  const item = page.getByRole("menuitem", { name: "Remove from Global", exact: true })
  if (guardedClock) {
    const time = new Date("2026-11-03T12:00:00Z")
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    // Kobalte selects on pointer-up/Enter, then closes its menu on a zero-delay timer.
    await item.press("Enter")
    await page.clock.runFor(20)
  } else await item.click()
  const dialog = dialogNamed(page, /Remove from Global/)
  await dialog.waitFor()
  return dialog
}

for (const surface of ["plugins", "section"] as const) {
  test(`AC-C14/D25 ${surface}: relevant invalidation revokes confirmation before any source mutation`, async () => {
    await withAttachment(async ({ page, model, calls }) => {
      model.binding = "attached"
      await call(page, "reconnect")
      await waitConversation(page, "attached")
      const dialog = await launchRemoval(page, surface)
      await call(page, "event", "config.updated")
      await dialog.waitFor({ state: "hidden", timeout: 3000 })
      await page.keyboard.press("Enter")
      assert.equal(count(calls, "remove") + count(calls, "detach") + count(calls, "attach"), 0)
      assert.equal(model.binding, "attached")
    })
  })

  test(`AC-C14a/D25 ${surface}: unavailable catalogue and unknown binding leave ordinary removal available`, async () => {
    await withAttachment(async ({ page, model, calls }) => {
      Object.assign(model, { catalog: "unavailable", binding: "unknown", plantAggregate: true })
      await call(page, "reconnect")
      await waitConversation(page, "unknown")
      const dialog = await launchRemoval(page, surface)
      assert.doesNotMatch(await dialog.innerText(), /\b42\b/)
      await page.waitForTimeout(650)
      const response = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/plugin-sources"))
      await dialog.getByRole("button", { name: "Remove from Global", exact: true }).click()
      assert.equal((await response).ok(), true)
      assert.equal(count(calls, "remove"), 1)
      assert.equal(count(calls, "detach") + count(calls, "attach") + count(calls, "hosts"), 0)
    })
  })

  test(`AC-C14/D25 ${surface}: same exact-source service, Cancel first, 600ms consent and no implicit detach`, async () => {
    await withAttachment(async ({ page, model, calls }) => {
      model.binding = "attached"
      await call(page, "reconnect")
      await waitConversation(page, "attached")
      await call(page, "hint", "blender", "Scene")
      for (const dismissal of ["Enter", "Cancel", "Escape"]) {
        const dialog = await launchRemoval(page, surface)
        assert.match(await dialog.innerText(), surface === "section" ? /OpenCode for Blender/ : /@fixture\/blender/)
        assert.match(await dialog.innerText(), /other projects/)
        assert.match(await dialog.innerText(), /interrupt|connection|availability/i)
        assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
        if (dismissal === "Cancel") await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        else await page.keyboard.press(dismissal)
        await dialog.waitFor({ state: "hidden" })
        assert.equal(count(calls, "remove"), 0)
        assert.equal(model.binding, "attached")
      }
      const dialog = await launchRemoval(page, surface, true), confirm = dialog.getByRole("button", { name: "Remove from Global", exact: true })
      await page.clock.runFor(478)
      assert.equal(await confirm.isDisabled(), true)
      await confirm.dispatchEvent("click")
      assert.equal(count(calls, "remove"), 0)
      await page.clock.runFor(122)
      assert.equal(await confirm.isEnabled(), true)
      const response = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname.endsWith("/plugin-sources"))
      await confirm.click()
      assert.equal((await response).ok(), true)
      const requests = calls.filter(call => call.action === "remove")
      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, "DELETE")
      assert.equal(requests[0].directory, null, "ordinary source removal carries its Location in the strict body")
      assert.deepEqual(requests[0].body.location, { directory: "/repo" })
      assert.equal(requests[0].body.scope, "global")
      assert.equal(requests[0].body.target, "@fixture/blender")
      assert.equal(requests[0].body.entryIndex, 4)
      assert.equal(requests[0].body.expectedRevision, "a".repeat(64))
      assert.equal(count(calls, "detach") + count(calls, "attach") + count(calls, "hosts") + count(calls, "install-host"), 0)
      assert.equal(model.binding, "attached")
    })
  })

  for (const kind of failureKinds) test(`AC-C14d/D25 ${surface} removal ${kind}: confidential uncertainty, one submission and no compensation`, async () => {
    await withAttachment(async ({ page, calls, model }) => {
      model.binding = "attached"
      await call(page, "reconnect")
      await waitConversation(page, "attached")
      model.failure = { action: "remove", kind }
      const dialog = await launchRemoval(page, surface)
      assert.match(await dialog.innerText(), /other projects/)
      await page.waitForTimeout(650)
      await dialog.getByRole("button", { name: "Remove from Global", exact: true }).click()
      await page.waitForFunction(() => JSON.stringify((window as any).integrationFixture.toasts()).includes("could not be confirmed"))
      await call(page, "event", "plugin.updated")
      await call(page, "event", "config.updated")
      await call(page, "reconnect")
      await call(page, "open")
      await page.waitForTimeout(400)
      assert.equal(count(calls, "remove"), 1)
      assert.equal(count(calls, "detach") + count(calls, "attach"), 0)
      assert.equal(model.binding, "attached")
      assertNoSentinels({ toasts: await call(page, "toasts"), dom: await page.locator("body").innerText() }, sentinelOptions, "removal failure")
    })
  })

  test(`AC-C14b/D25 ${surface} stale source refusal preserves the live binding and never detaches`, async () => {
    await withAttachment(async ({ page, calls, model }) => {
      model.binding = "attached"
      model.removeCode = "stale"
      await call(page, "reconnect")
      await waitConversation(page, "attached")
      const dialog = await launchRemoval(page, surface)
      await page.waitForTimeout(650)
      await dialog.getByRole("button", { name: "Remove from Global", exact: true }).click()
      await page.waitForFunction(() => JSON.stringify((window as any).integrationFixture.toasts()).includes("changed in the Global configuration"))
      assert.equal(count(calls, "remove"), 1)
      assert.equal(count(calls, "detach") + count(calls, "attach"), 0)
      assert.equal(model.binding, "attached")
    })
  })
}
