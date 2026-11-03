// ST2: original attachment safety scenarios, entered through the real Status section.
import assert from "node:assert/strict"
import { test } from "node:test"
import { join } from "node:path"
import { assertNoSentinels } from "../../../../scripts/fixtures/fake-integration/index.mjs"
import {
  actionReady, call, confirmAttach, conversation, conversationAction, count, echoes, failureKinds, failResponse,
  held, launch, openStatus, picker, screenshots, sectionBody, sentinelOptions, shell, stateBadge,
  useAttachmentBrowser, waitConversation, withAttachment,
} from "./integration-attachment-harness"

useAttachmentBrowser()

for (const width of [1500, 390]) test(`AC-C3/C5 trusted Status picker at ${width}px: Cancel first, Q8 exact match, consent and authoritative attach/detach`, async () => {
  await withAttachment(async ({ page, calls }) => {
    await call(page, "hint", "other", "Scene")
    await launch(page)
    const dialog = picker(page)
    assert.equal(await dialog.getByText(/Reattach/).count(), 0)
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    assert.equal(count(calls, "attach"), 0)
    await call(page, "hint", "blender", "Scene")
    // The first explicit picker read already proved a fresh matching Scene offer.
    await launch(page, "Reattach “Scene”")
    await dialog.getByRole("button", { name: /Reattach “Scene”/ }).waitFor()
    assert.match(await dialog.innerText(), /Fixture conversation/)
    assert.match(await dialog.innerText(), /agent will be able to modify/)
    assert.match(await dialog.innerText(), /machine where OpenCode runs/)
    assert.equal(await dialog.getByRole("button", { name: "Reattach", exact: true }).isDisabled(), true)
    await dialog.getByRole("button", { name: /Reattach “Scene”/ }).click()
    const box = await dialog.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= width)
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)"), false)
    if (screenshots) await dialog.screenshot({ path: join(screenshots, `attachment-${width}.png`) })
    assert.equal(count(calls, "attach"), 0, "selecting an offer never consents")
    await confirmAttach(page, "Reattach")
    await dialog.getByText("Attachment requested for “Scene”.", { exact: true }).waitFor()
    await dialog.getByRole("button", { name: "OK", exact: true }).click()
    await waitConversation(page, "attached")
    assert.deepEqual(calls.find(call => call.action === "attach"), { action: "attach", directory: "/repo", method: "POST", body: { sessionID: "session", offerID: "offer-1" } })
    await conversationAction(page).click()
    await waitConversation(page, "available")
    assert.deepEqual(calls.find(call => call.action === "detach")?.body, { sessionID: "session" })
    assert.equal(count(calls, "detach"), 1)
  }, width)
})

for (const dismissal of ["Enter", "Cancel", "Escape"]) for (const width of [1500, 390])
test(`AC-C5 ${dismissal} cancels and restores the exact Status opener at ${width}px`, async () => {
  await withAttachment(async ({ page, calls }) => {
    await actionReady(page, "Attach…")
    const opener = await conversationAction(page).elementHandle()
    await launch(page)
    await call(page, "event", "plugin.updated", {}, "other-workspace")
    await page.waitForFunction(() => document.querySelector('.integration-attachment .button-secondary') === document.activeElement)
    if (dismissal === "Cancel") await picker(page).getByRole("button", { name: "Cancel", exact: true }).click()
    else await page.keyboard.press(dismissal)
    await picker(page).waitFor({ state: "hidden" })
    await page.waitForFunction(element => element === document.activeElement, opener)
    assert.equal(count(calls, "attach") + count(calls, "detach") + count(calls, "install-host"), 0)
  }, width)
})

test("AC-C5 attachment rejects activation below 500ms and admits one double-click after 600ms", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    const time = new Date("2026-11-03T12:00:00Z")
    await page.clock.install({ time })
    await page.clock.pauseAt(time)
    await launch(page)
    const confirm = picker(page).getByRole("button", { name: "Attach", exact: true })
    await picker(page).getByRole("button", { name: /Blender.*Scene/ }).waitFor()
    await page.clock.runFor(499)
    assert.equal(await confirm.isDisabled(), true)
    await confirm.dispatchEvent("click")
    await confirm.dispatchEvent("dblclick")
    assert.equal(count(calls, "attach"), 0)
    await page.clock.runFor(101)
    assert.equal(await confirm.isEnabled(), true)
    model.holdAttach = true
    await confirm.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    const request = await held(model)
    assert.equal(count(calls, "attach"), 1)
    model.binding = "attached"
    await request.fulfill({ json: { outcome: "attached" } })
    await picker(page).getByText("Attachment requested for “Scene”.", { exact: true }).waitFor()
  })
})

for (const change of ["navigation", "roundtrip", "event", "hidden", "disabled", "detached", "digest"]) test(`AC-C5 Status opener restoration fenced by ${change}`, async () => {
  await withAttachment(async ({ page, model }) => {
    const opener = await conversationAction(page).elementHandle()
    await launch(page)
    if (change === "navigation" || change === "roundtrip") {
      await shell(page, "addSession", "other")
      await shell(page, "selectSession", "other")
      if (change === "roundtrip") await shell(page, "selectSession", "session")
    } else if (change === "event") await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    else if (change === "digest") { model.version = "9.9.9"; await call(page, "refresh"); await page.keyboard.press("Escape") }
    else {
      await opener!.evaluate((element, change) => {
        if (change === "hidden") (element as HTMLElement).style.visibility = "hidden"
        else if (change === "disabled") (element as HTMLButtonElement).disabled = true
        else element.remove()
      }, change)
      await page.keyboard.press("Escape")
    }
    await picker(page).waitFor({ state: "hidden" })
    await page.waitForTimeout(100)
    assert.equal(await opener!.evaluate(element => element === document.activeElement), false)
  })
})

test("AC-C3 late hosts cannot retarget a conversation; busy/gone/refused remain actionable without replay", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    model.holdHosts = true
    await launch(page)
    const hosts = await held(model)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await picker(page).waitFor({ state: "hidden" })
    await hosts.fulfill({ json: { offers: [{ offerID: "late", label: "Late", protocol: "ok" }] } }).catch(() => {})
    assert.equal(count(calls, "attach"), 0)
    model.holdHosts = false
    for (const outcome of ["busy", "gone", "refused"]) {
      model.outcome = outcome
      await launch(page)
      await confirmAttach(page)
      const alert = picker(page).getByRole("alert")
      await alert.filter({ hasText: /\S/ }).waitFor()
      assert.ok((await alert.innerText()).length > 20)
      await echoes(page)
      assert.equal(await picker(page).isVisible(), true)
      await picker(page).getByRole("button", { name: "Cancel", exact: true }).click()
    }
    assert.equal(count(calls, "attach"), 3)
    model.holdAttach = true
    await launch(page)
    await confirmAttach(page)
    const attach = await held(model)
    await shell(page, "selectSession", "session")
    await picker(page).waitFor({ state: "hidden" })
    await attach.fulfill({ json: { outcome: "attached" } })
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("Attachment requested for “Scene”.", { exact: true }).count(), 0)
    assert.equal(calls.filter(call => call.action === "attach").at(-1)?.body.sessionID, "other")
  })
})

test("AC-C3 unrelated workspace/session events preserve picker selection; exact-session invalidation expires consent", async () => {
  await withAttachment(async ({ page, calls }) => {
    await launch(page)
    const offer = picker(page).getByRole("button", { name: /Blender.*Scene/ })
    await offer.click()
    await call(page, "event", "rpc.neuralnomads.blender.status_changed", {}, "other-workspace")
    await call(page, "event", "session.updated", { sessionID: "other-session" })
    await call(page, "event", "session.updated", { sessionID: "session" }, "other-workspace")
    assert.equal(await picker(page).isVisible(), true)
    assert.equal(await offer.getAttribute("aria-pressed"), "true")
    await page.waitForFunction(() => !(document.querySelector('.integration-attachment .button-primary') as HTMLButtonElement)?.disabled)
    assert.equal(await picker(page).getByRole("button", { name: "Attach", exact: true }).isEnabled(), true)
    assert.equal(count(calls, "attach"), 0)
    await call(page, "event", "session.updated", { sessionID: "session" })
    await picker(page).waitFor({ state: "hidden" })
    assert.equal(count(calls, "attach"), 0)
  })
})

test("AC-C3 aggregate bindings and Q8 cannot grant attachment without active native offers", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await call(page, "hint", "blender", "Scene")
    model.plantAggregate = true
    for (const variation of [{ state: "inactive" }, { state: "ok", family: "api" }, { family: "native", offers: 0 }]) {
      Object.assign(model, variation)
      await call(page, "event", "rpc.neuralnomads.blender.status_changed")
      await page.waitForTimeout(650)
      assert.equal(await conversationAction(page).filter({ hasText: /Attach|Reattach/ }).count(), 0)
      assert.doesNotMatch(await sectionBody(page).innerText(), /\b42\b|Attached to/)
    }
    assert.equal(count(calls, "hosts") + count(calls, "attach"), 0)
  })
})

for (const detachOutcome of ["detached", "none"]) test(`AC-C12/C16 native echoes preserve attach receipt, then one direct ${detachOutcome} request`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.holdAttach = true
    model.holdDetach = true
    await launch(page)
    await confirmAttach(page)
    const attach = await held(model)
    await echoes(page)
    await call(page, "reconnect")
    await picker(page).getByText("Waiting for the application…", { exact: true }).waitFor()
    assert.match(await picker(page).innerText(), /Blender Scene Scene.blend/)
    assert.match(await picker(page).innerText(), /Fixture conversation/)
    model.binding = "attached"
    await attach.fulfill({ json: { outcome: "attached" } })
    await picker(page).getByText("Attachment requested for “Scene”.", { exact: true }).waitFor()
    await echoes(page)
    await call(page, "open")
    assert.equal(await picker(page).getByRole("button", { name: "Attach", exact: true }).count(), 0)
    await picker(page).getByRole("button", { name: "OK", exact: true }).click()
    await waitConversation(page, "attached")
    await conversationAction(page).click()
    const detach = await held(model)
    assert.equal(await page.getByRole("dialog").count() + await page.getByRole("alertdialog").count(), 0, "D24 has no confirmation")
    await echoes(page)
    model.binding = "none"
    await detach.fulfill({ json: { outcome: detachOutcome } })
    await waitConversation(page, "available")
    await echoes(page)
    await page.waitForTimeout(450)
    assert.deepEqual(calls.filter(call => ["attach", "detach"].includes(call.action)).map(call => call.body), [
      { sessionID: "session", offerID: "offer-1" }, { sessionID: "session" },
    ])
  })
})

test("AC-C16 direct Detach double-click submits exactly once, preserves the other conversation and fences a stale control", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.bindingBySession.session = { state: "attached", label: "Scene" }
    model.bindingBySession.other = { state: "attached", label: "Other scene" }
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    await shell(page, "addSession", "other")
    model.holdDetach = true
    const original = await conversationAction(page).elementHandle()
    await original!.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    const detach = await held(model)
    assert.equal(count(calls, "detach"), 1)
    assert.equal(await page.getByRole("dialog").count() + await page.getByRole("alertdialog").count(), 0)
    model.bindingBySession.session = { state: "none" }
    await detach.fulfill({ json: { outcome: "detached" } })
    await waitConversation(page, "available")
    assert.deepEqual(model.bindingBySession.other, { state: "attached", label: "Other scene" })
    await shell(page, "selectSession", "other")
    await waitConversation(page, "attached")
    await original!.evaluate(element => (element as HTMLButtonElement).click())
    await echoes(page)
    await page.waitForTimeout(450)
    assert.equal(count(calls, "detach"), 1, "the old action cannot target the new conversation")
    assert.deepEqual(calls.find(call => call.action === "detach")?.body, { sessionID: "session" })
    assert.equal(count(calls, "remove") + count(calls, "install-host") + count(calls, "attach"), 0)
  })
})

for (const kind of failureKinds) test(`AC-C3/C16 ${kind}: private failures, uncertain Detach, no replay and late navigation`, async () => {
  await withAttachment(async ({ page, model, calls, diagnostics }) => {
    const dialog = picker(page), alert = dialog.getByRole("alert").filter({ hasText: /\S/ })
    const reads = count(calls, "read")
    model.failure = { action: "read", kind }
    const failedRead = page.waitForEvent(kind === "network-error" ? "requestfailed" : "requestfinished", {
      predicate: request => new URL(request.url()).pathname.endsWith("/integrations"),
    })
    await call(page, "reconnect")
    await failedRead
    await page.waitForTimeout(100)
    assert.equal(count(calls, "read"), reads + 1)
    assert.equal(await conversationAction(page).filter({ hasText: "Attach…" }).count(), 0)
    model.failure = undefined
    await call(page, "reconnect")
    await actionReady(page, "Attach…")
    model.failure = { action: "hosts", kind }
    await launch(page)
    await alert.waitFor()
    assertNoSentinels(await dialog.innerText(), sentinelOptions, "hosts failure display")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await echoes(page)
    await call(page, "reconnect")
    await actionReady(page, "Attach…")
    assert.equal(count(calls, "hosts"), 1)
    assert.equal(count(calls, "attach"), 0)
    model.failure = { action: "attach", kind }
    await launch(page)
    await confirmAttach(page)
    await alert.waitFor()
    const message = await alert.innerText()
    assertNoSentinels(message, sentinelOptions, "attach failure display")
    await echoes(page)
    await call(page, "reconnect")
    await page.waitForTimeout(100)
    assert.equal(await alert.innerText(), message)
    assert.equal(count(calls, "attach"), 1)
    assert.equal(count(calls, "detach"), 0)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await waitConversation(page, "uncertain")
    model.failure = undefined
    await conversationAction(page).click()
    await actionReady(page, "Attach…")
    await launch(page)
    await confirmAttach(page)
    await dialog.getByRole("button", { name: "OK", exact: true }).click()
    await waitConversation(page, "attached")
    model.failure = { action: "detach", kind }
    await conversationAction(page).click()
    await waitConversation(page, "uncertain")
    assert.equal(await conversation(page).innerText(), "Uncertain state")
    assert.equal(await stateBadge(page).getAttribute("data-integration-state"), "uncertain")
    assert.equal(await conversationAction(page).innerText(), "Refresh")
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "detach failure display")
    await echoes(page)
    await call(page, "reconnect")
    await call(page, "open")
    await page.waitForTimeout(450)
    await waitConversation(page, "uncertain")
    assert.equal(count(calls, "detach"), 1, "events never replay a lost reply")
    model.failure = undefined
    await conversationAction(page).click()
    await waitConversation(page, "attached")
    model.detachOutcome = "none"
    await conversationAction(page).click()
    await waitConversation(page, "available")
    assert.equal(count(calls, "detach"), 2, "only a new explicit action retries")
    model.holdAttach = true
    await launch(page)
    await confirmAttach(page)
    const late = await held(model)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await dialog.waitFor({ state: "hidden" })
    await failResponse(late, kind)
    await page.waitForTimeout(100)
    assert.equal(await dialog.count(), 0)
    assert.equal(count(calls, "attach"), 3)
    await diagnostics.drain()
    assert.ok(diagnostics.consoleEntries.some(entry => entry.text.includes("event batch")))
  })
})

test("AC-C12/C16 receipt alone grants no attachment; late lost Detach cannot affect another view and reload never replays", async () => {
  await withAttachment(async ({ page, model, calls, reload }) => {
    model.bindingFollows = false
    await launch(page)
    await confirmAttach(page)
    await picker(page).getByRole("button", { name: "OK", exact: true }).click()
    await waitConversation(page, "available")
    assert.doesNotMatch(await sectionBody(page).innerText(), /Attached to/)
    model.binding = "attached"
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    model.holdDetach = true
    await conversationAction(page).click()
    const lost = await held(model)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await lost.abort("connectionfailed")
    await page.waitForTimeout(100)
    assert.doesNotMatch(await conversation(page).innerText(), /Uncertain state/)
    model.binding = "none"
    await reload()
    await page.waitForFunction(() => Boolean((window as any).integrationFixture))
    await openStatus(page)
    await waitConversation(page, "available")
    assert.equal(count(calls, "detach"), 1)
    assert.equal(count(calls, "attach"), 1)
  })
})

test("AC-C16 navigation before dispatch and invalid binding ownership transmit zero detach requests", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = "attached"
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    const obsolete = await conversationAction(page).elementHandle()
    model.bindingBySession.other = { state: "none" }
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await waitConversation(page, "available")
    await obsolete!.evaluate(element => (element as HTMLButtonElement).click())
    await echoes(page)
    await page.waitForTimeout(450)
    assert.equal(count(calls, "detach"), 0)
    model.bindingStatus = 403
    await shell(page, "selectSession", "session")
    await waitConversation(page, "unknown")
    assert.equal(await conversationAction(page).innerText(), "Refresh")
    await obsolete!.evaluate(element => (element as HTMLButtonElement).click())
    assert.equal(count(calls, "detach"), 0)
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "binding ownership refusal")
  })
})

test("AC-C16 successful detach receipt cannot claim none; an old action cannot detach a confirmed reattachment", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = "attached"
    model.bindingFollows = false
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    const obsolete = await conversationAction(page).elementHandle()
    await conversationAction(page).click()
    await actionReady(page, "Detach")
    await waitConversation(page, "attached")
    assert.equal(count(calls, "detach"), 1)
    assert.match(await conversation(page).innerText(), /Attached to/)
    model.binding = "none"
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await waitConversation(page, "available")
    model.bindingFollows = true
    await launch(page)
    await confirmAttach(page)
    await picker(page).getByRole("button", { name: "OK", exact: true }).click()
    await waitConversation(page, "attached")
    await obsolete!.evaluate(element => (element as HTMLButtonElement).click())
    await echoes(page)
    await call(page, "reconnect")
    await page.waitForTimeout(450)
    assert.equal(count(calls, "detach"), 1)
    assert.equal(count(calls, "attach"), 1)
    await waitConversation(page, "attached")
  })
})

for (const action of ["attach", "detach"] as const) test(`AC-C16 a lost ${action} reply from A cannot block the current Detach in B`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.bindingBySession.session = { state: action === "detach" ? "attached" : "none", label: "Scene" }
    model.bindingBySession.other = { state: "attached", label: "Other scene" }
    await call(page, "reconnect")
    await waitConversation(page, action === "detach" ? "attached" : "available")
    if (action === "attach") { model.holdAttach = true; await launch(page); await confirmAttach(page) }
    else { model.holdDetach = true; await conversationAction(page).click() }
    const late = await held(model)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await waitConversation(page, "attached")
    await late.abort("connectionfailed")
    await page.waitForFunction(() => !(window as any).integrationFixture.bindingBusy("session", "/repo"))
    model.holdDetach = false
    await actionReady(page, "Detach")
    await conversationAction(page).click()
    await waitConversation(page, "available")
    assert.equal(count(calls, "detach"), action === "detach" ? 2 : 1)
    assert.deepEqual(calls.filter(call => call.action === "detach").at(-1)?.body, { sessionID: "other" })
  })
})

for (const action of ["attach", "detach"] as const) for (const status of [403, 404])
test(`AC-C16 ${action} answered ${status} after transmission remains uncertain until authoritative refresh`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = action === "detach" ? "attached" : "none"
    await call(page, "reconnect")
    await waitConversation(page, action === "detach" ? "attached" : "available")
    if (action === "attach") { model.holdAttach = true; await launch(page); await confirmAttach(page) }
    else { model.holdDetach = true; await conversationAction(page).click() }
    const sent = await held(model)
    // The native effect occurred, then its ownership recheck failed; no authoritative binding is readable.
    model.binding = "unknown"
    await sent.fulfill({ status, json: { error: "refused" } })
    if (action === "attach") await picker(page).getByRole("button", { name: "Cancel", exact: true }).click()
    await waitConversation(page, "uncertain")
    await echoes(page)
    await call(page, "reconnect")
    await waitConversation(page, "uncertain")
    assert.equal(await conversationAction(page).innerText(), "Refresh")
    assert.equal(count(calls, action), 1, "the transmitted request is never replayed")
  })
})
