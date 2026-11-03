// Integration attachment from the right panel's Status section: diagnostic boundaries, the absent header and
// Plugins entry points (AC-E7), and the authoritative binding of the displayed conversation (AC-C12).
// Actions (picker, attach, Detach) live in integration-attachment-actions.test.ts; host installation and
// removal in integration-attachment-install.test.ts.
import assert from "node:assert/strict"
import { test } from "node:test"
import { join } from "node:path"
import type { Page } from "playwright"
import { assertNoSentinels, findSentinels } from "../../../../scripts/fixtures/fake-integration/index.mjs"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import {
  actionReady, browser, call, captureDiagnostics, captureHandleControl, conversation, conversationAction, count, echoes, expandPlugins, expandSection,
  failureKinds, heldSessions, launch, line, openStatus, takeBinding, panelToggle, pluginRowMenu, privateHost, screenshots, section, sectionBody, sectionMenu, sectionTrigger,
  sentinelOptions, shell, stateBadge, statusTab, useAttachmentBrowser, waitConversation, withAttachment,
} from "./integration-attachment-harness"

useAttachmentBrowser()

for (const stage of ["addInitScript", "goto", "waitForFunction"] as const)
test(`attachment boundary preserves ${stage} primary under diagnostic and close failures`, async t => {
  const page = await browser.newPage(), context = page.context(), close = page.close.bind(page)
  const primary = new Error("bootstrap primary"), stack = primary.stack, output: unknown[][] = []
  t.mock.method(console, "error", (...args: unknown[]) => { output.push(args) })
  t.mock.method(browser, "newPage", async () => page)
  if (stage === "addInitScript") t.mock.method(page, "addInitScript", async () => { throw primary })
  else {
    t.mock.method(page, "goto", async () => { if (stage === "goto") throw primary; return null })
    t.mock.method(page, "waitForFunction", async () => { throw primary })
  }
  const closing = t.mock.method(page, "close", async () => { await close(); throw new Error("close secondary") })
  try {
    await assert.rejects(withAttachment(async () => assert.fail("bootstrap must reject")), error => error === primary && (error as Error).stack === stack)
    assert.equal(page.isClosed(), true)
    assert.equal(browser.contexts().includes(context), false, "the owned newPage context is closed immediately")
    assert.equal(closing.mock.callCount(), 1)
    for (const event of ["requestfailed", "response", "framenavigated"]) assert.equal(page.listenerCount(event), 0, "the failure observer is detached")
    assert.deepEqual(output, [["attachment-primary-failed", stage === "addInitScript" ? "allocation" : "bootstrap"],
      ["attachment-diagnostic-failed"], ["attachment-close-failed"]])
  } finally { await close() }
})

test("attachment boundary preserves body primary and separates diagnostic and close failures", async t => {
  const primary = new Error("body primary"), stack = primary.stack, output: unknown[][] = []
  let ownedPage: Page | undefined
  t.mock.method(console, "error", (...args: unknown[]) => { output.push(args) })
  await assert.rejects(withAttachment(async ({ page }) => {
    ownedPage = page
    const close = page.close.bind(page)
    t.mock.method(page, "close", async () => { await close(); throw new Error("close secondary") })
    await page.evaluate(host => console.debug("private failure evidence", host), privateHost)
    throw primary
  }), error => error === primary && (error as Error).stack === stack)
  assert.equal(ownedPage?.isClosed(), true)
  assertNoSentinels(output, sentinelOptions, "public failure categories")
  assert.deepEqual(output, [["attachment-primary-failed", "body"], ["attachment-diagnostic-failed"], ["attachment-close-failed"]])
})

async function checkDiagnosticCapture() {
  const page = await browser.newPage()
  let diagnostics: Awaited<ReturnType<typeof captureDiagnostics>> | undefined
  await runWithDiagnosticCleanup({ run: async () => {
    diagnostics = await captureDiagnostics(page)
    await page.addInitScript(host => {
      const error = new Error(host.token)
      error.stack += JSON.stringify(host)
      for (const level of ["debug", "log", "info", "warn", "error", "trace"] as const) {
        console[level](`capture self-check ${host.scriptHandle}`, { nested: host, error }, error)
      }
      setTimeout(() => { throw error }, 0)
    }, privateHost)
    const uncaught = page.waitForEvent("pageerror")
    await page.goto("data:text/html,<title>Diagnostic collector self-check</title>")
    await uncaught
    await diagnostics.drain()
    for (const type of ["debug", "log", "info", "warning", "error", "trace"]) {
      const entry = diagnostics.consoleEntries.find(entry => entry.type === type)
      assert.ok(entry, `captured console level ${type}`)
      assert.ok(findSentinels(entry.text, sentinelOptions).includes("scriptHandle"), "console text was captured")
      assert.deepEqual(findSentinels(entry.args, sentinelOptions).sort(), Object.keys(privateHost).sort(), "nested console arguments retain every sentinel for scanning")
      assert.deepEqual(findSentinels((entry.args[1] as any).error, sentinelOptions).sort(), Object.keys(privateHost).sort(), "Errors nested inside structured arguments retain their message and stack")
    }
    assert.deepEqual(findSentinels(diagnostics.pageErrors[0].message, sentinelOptions), ["token"], "uncaught messages are captured")
    assert.deepEqual(findSentinels(diagnostics.pageErrors[0].stack, sentinelOptions).sort(), Object.keys(privateHost).sort(), "uncaught stacks are captured")
    assert.deepEqual(findSentinels(diagnostics.pageErrors, sentinelOptions).sort(), Object.keys(privateHost).sort(), "uncaught message and stack are both scanned")
    assert.throws(() => assertNoSentinels(diagnostics.consoleEntries, sentinelOptions, "intentional capture self-check"), error => {
      // The negative control must fail without reproducing any secret in the runner's own output.
      assertNoSentinels(String(error), sentinelOptions, "leak assertion output")
      return true
    })
    await diagnostics.drain()
  }, diagnose: async () => { await diagnostics?.drain() }, cleanup: () => runWithDiagnosticCleanup({
    run: () => page.close(), diagnose: async () => {}, cleanup: async () => { await diagnostics?.complete() },
    onObservationError: () => {}, onCleanupError: () => console.error("capture-control-completion-failed"),
  }),
  onObservationError: () => console.error("capture-control-diagnostic-failed"),
  onCleanupError: () => console.error("capture-control-close-failed") })
}
test("diagnostic capture detects sentinel text, structured arguments and Error stacks at every console level before navigation", checkDiagnosticCapture)
test("diagnostic capture control closes its owned page on transport initialization failure", async t => {
  const page = await browser.newPage(), context = page.context(), primary = new Error("capture initialization primary"), stack = primary.stack
  t.after(() => context.close())
  t.mock.method(browser, "newPage", async () => page)
  t.mock.method(context, "addInitScript", async () => { throw primary })
  await assert.rejects(checkDiagnosticCapture(), error => error === primary && (error as Error).stack === stack)
  assert.equal(page.isClosed(), true)
  assert.equal(browser.contexts().includes(context), false, "capture setup releases its owned context immediately")
})

test("diagnostic capture retains real dispatcher output after drain while the original handle control rejects document death", async () => {
  await withAttachment(async ({ page, diagnostics }) => {
    const legacy = captureHandleControl(page)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let armed = false, heldID: string | undefined
    page.prependListener("console", message => {
      if (!armed || heldID || !message.text().includes("event batch")) return
      const tag = message.args().at(-1)!.toString(), token = diagnostics.transport.token
      heldID = tag.slice(token.length, tag.indexOf("|", token.length))
      const argument = message.args()[4], evaluate = argument.evaluate.bind(argument)
      argument.evaluate = async (expression, arg) => { started.resolve(); await release.promise; return evaluate(expression, arg) }
    })
    await diagnostics.drain()
    await legacy.drain()
    const before = new Set(diagnostics.transport.snapshots.keys())
    armed = true
    try {
      await call(page, "event", "session.updated", { sessionID: "other-session" })
      await started.promise
      await page.reload()
      release.resolve()
      // Other genuine renderer calls can also race reload; the original zero-loss
      // assertion stays strict, while its negative control requires a positive loss.
      await assert.rejects(legacy.drain, error => error instanceof assert.AssertionError && Number.isInteger(error.actual) && error.actual > 0 && error.expected === 0
        && error.message.includes("every console argument was serialized before teardown"))
      await page.waitForFunction(() => Boolean((window as any).integrationFixture))
      await diagnostics.drain()
      assert.ok(heldID && !before.has(heldID), "the held real call was emitted after drainage")
      const entry = diagnostics.consoleEntries.find(entry => entry.id === heldID && entry.text.includes("event batch") && entry.args.some((value: any) => value?.size === 1))
      assert.ok(entry, "the actual dispatcher message emitted after drain retained its structured value")
      const snapshot = diagnostics.transport.snapshots.get(entry.id!)
      assert.equal(diagnostics.transport.history.get(snapshot.uniqueId).retired, true)
    } finally { release.resolve() }
  })
})

test("diagnostic capture drains a delayed structured argument before fixture reload", async () => {
  await withAttachment(async ({ page, diagnostics: captured, reload }) => {
    const diagnostics = captureHandleControl(page), authorityDrain = captured.drain
    captured.drain = async () => { await diagnostics.drain(); await authorityDrain() }
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    page.prependListener("console", message => {
      if (!message.text().startsWith("delayed reload diagnostic")) return
      const argument = message.args()[1], evaluate = argument.evaluate.bind(argument)
      argument.evaluate = async (expression, arg) => {
        started.resolve()
        await release.promise
        return evaluate(expression, arg)
      }
    })
    const drain = diagnostics.drain
    // Hold the real JSHandle until the boundary drains it, or navigation destroys its context.
    diagnostics.drain = () => { release.resolve(); return drain() }
    page.once("framenavigated", () => release.resolve())
    try {
      await page.evaluate(() => console.debug("delayed reload diagnostic", { nested: { value: "retained" }, error: new Error("retained error") }))
      await started.promise
      await reload()
      await page.waitForFunction(() => Boolean((window as any).integrationFixture))
      await diagnostics.drain()
      const entry = diagnostics.consoleEntries.find(entry => entry.text.startsWith("delayed reload diagnostic"))!
      assert.deepEqual((entry.args[1] as any).nested, { value: "retained" })
      assert.equal((entry.args[1] as any).error.message, "retained error")
      assert.match((entry.args[1] as any).error.stack, /Error: retained error/)
    } finally { release.resolve() }
  })
})

// ---- AC-E7: the conversation header and the Plugins row carry no integration control. ----

const integrationWords = /attach|detach|application|blender|integration|binding/i
/** `menu`: also open the header overflow menu (a floating right panel covers the header at narrow widths). */
async function assertHeaderClean(page: Page, width: number, menu = true) {
  const expanded = page.locator(".session-header-expanded-actions")
  const names = await expanded.locator("button").evaluateAll(buttons => buttons.map(button =>
    `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`))
  assert.equal(names.some(name => integrationWords.test(name)), false, `${width}px header has no integration button`)
  assert.equal(await page.locator("[data-integration-binding], .integration-binding-label").count(), 0, `${width}px header has no binding line`)
  const header = await page.locator(".session-header-expanded-actions").evaluate(element => element.closest(".panel-header, header")?.textContent ?? element.textContent ?? "")
  assert.doesNotMatch(header, /Attached to|Binding unknown|Not supported|No open application/, `${width}px header has no attachment label`)
  const overflow = page.locator(".session-header-actions-menu:visible")
  if (menu && await overflow.count()) {
    await overflow.first().click()
    const items = await page.getByRole("menuitem").allInnerTexts()
    assert.ok(items.length > 0, "the header overflow menu opened")
    assert.equal(items.some(item => integrationWords.test(item)), false, `${width}px header overflow menu has no integration entry`)
    await page.keyboard.press("Escape")
    await page.getByRole("menuitem").first().waitFor({ state: "detached" })
  }
}
const attachmentMarks = "[data-integration-section], [data-conversation-state], [data-conversation-action], [data-integration-state], [data-integration-binding], .integration-attachment"

for (const width of [1500, 700]) test(`AC-E7 at ${width}px: attached conversation has no header control and no indicator outside Status; Plugins lists only package, Remove and Refresh`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    // A planted aggregate the route no longer sends must never be displayed.
    Object.assign(model, { binding: "attached", bindingLabel: "Scene", plantAggregate: true })
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await waitConversation(page, "attached")
    assert.equal(await stateBadge(page).getAttribute("data-integration-state"), "attached")
    assert.equal(await sectionTrigger(page).getAttribute("aria-expanded"), "true", "an attached displayed conversation expands its section")
    assert.match(await conversation(page).innerText(), /Attached to “Scene”/)
    assert.equal(await conversationAction(page).innerText(), "Detach")
    assert.doesNotMatch(await page.locator("body").innerText(), /\b42\b/, "the planted aggregate count is never shown")
    await assertHeaderClean(page, width, width >= 1000)

    // The Plugins row and the section menu: only the package action, Remove and Refresh.
    await expandPlugins(page)
    await pluginRowMenu(page).click()
    await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'))
    const rowItems = await page.getByRole("menuitem").allInnerTexts()
    assert.deepEqual(rowItems.map(item => item.trim()), ["Check updates for @fixture/blender", "Remove from Global", "Refresh plugin controls"])
    await page.keyboard.press("Escape")
    await page.getByRole("menuitem").first().waitFor({ state: "detached" })
    assert.equal(await panelToggle(page).getAttribute("aria-expanded"), "true", "Escape closes the menu, not its floating drawer")
    await expandSection(page)
    assert.ok((await line(page, "plugin").getByRole("button").allTextContents()).length > 0, "the section keeps accessible plugin actions after its menu closes")
    await sectionMenu(page).click()
    await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'))
    const sectionItems = await page.getByRole("menuitem").allInnerTexts()
    assert.deepEqual(sectionItems.map(item => item.trim()), ["Check updates for @fixture/blender", "Remove from Global", "Refresh plugin controls"])
    await page.keyboard.press("Escape")
    assert.equal(await panelToggle(page).getAttribute("aria-expanded"), "true", "the section menu also owns Escape")

    // Another tab: nothing about the attachment is rendered anywhere.
    await statusTab(page).waitFor()
    await page.getByRole("tab", { name: "Files", exact: true }).click()
    await sectionBody(page).waitFor({ state: "detached" })
    assert.equal(await page.locator(attachmentMarks).count(), 0, "Status closed: no attachment indicator")
    assert.doesNotMatch(await page.locator("body").innerText(), /Attached to|Binding unknown|Detach\b/)
    await assertHeaderClean(page, width, width >= 1000)
    // The right panel closed: still nothing.
    await panelToggle(page).click()
    await page.waitForFunction(() => document.querySelector('button[aria-label="Right panel"]')?.getAttribute("aria-expanded") === "false")
    assert.equal(await page.locator(attachmentMarks).count(), 0, "panel closed: no attachment indicator")
    assert.doesNotMatch(await page.locator("body").innerText(), /Attached to|Binding unknown/)
    await assertHeaderClean(page, width)
    assert.equal(count(calls, "attach") + count(calls, "detach") + count(calls, "hosts"), 0)
  }, width)
})

test("AC-E7 Status closed from boot: no binding demand and no indicator; opening Status reads the binding once", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = "attached"
    await page.waitForTimeout(400)
    assert.equal(await page.locator(attachmentMarks).count(), 0)
    assert.equal(count(calls, "binding"), 0, "no binding read without the Status tab")
    await openStatus(page)
    await waitConversation(page, "attached")
    assert.equal(count(calls, "binding"), 1)
  }, 1500, 850, { status: false })
})

// ---- AC-C12: the Conversation line reads the authoritative binding only. ----

test("AC-C12 Attach… needs an offer and a displayed conversation; Q8 hint and receipts never show Attached to", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await waitConversation(page, "available")
    assert.equal(await conversation(page).innerText(), "Application available")
    await actionReady(page, "Attach…")
    // Offer expiry: no action, and the "i" hint.
    model.offers = 0
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await waitConversation(page, "noOffer")
    assert.equal(await conversationAction(page).count(), 0, "no offer: no Attach…")
    assert.equal(await line(page, "conversation").getByRole("button", { name: "No open application", exact: true }).count(), 1)
    model.offers = 1
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await waitConversation(page, "available")
    // No displayed conversation: a disabled Attach…
    await shell(page, "showInfo")
    await waitConversation(page, "noConversation")
    assert.equal(await conversationAction(page).getAttribute("aria-disabled"), "true")
    await conversationAction(page).click({ force: true })
    await page.waitForTimeout(200)
    assert.equal(count(calls, "hosts"), 0, "a disabled Attach… reads no offers")
    await shell(page, "showSession")
    await waitConversation(page, "available")
    // Q8 alone cannot establish that a matching offer exists: the picker checks its fresh offers.
    await call(page, "hint", "blender", "Scene")
    await waitConversation(page, "available")
    assert.equal(await conversation(page).innerText(), "Application available")
    await actionReady(page, "Attach…")
    assert.doesNotMatch(await sectionBody(page).innerText(), /Attached to/)
    // Another integration's hint grants nothing.
    await call(page, "hint", "other", "Scene")
    await waitConversation(page, "available")
    // A successful receipt with an authoritative "none" read grants no Attached to.
    model.bindingFollows = false
    await launch(page)
    await page.waitForFunction(() => !(document.querySelector(".integration-attachment .button-primary") as HTMLButtonElement | null)?.disabled)
    await page.locator(".integration-attachment .button-primary").click()
    await page.locator(".integration-attachment").getByText("Attachment requested for “Scene”.").waitFor()
    await page.locator(".integration-attachment .button-secondary").click()
    await page.waitForTimeout(400)
    await waitConversation(page, "available")
    assert.doesNotMatch(await sectionBody(page).innerText(), /Attached to/)
    assert.equal(count(calls, "attach"), 1)
  })
})

for (const width of [1500, 420]) test(`AC-C12 external attach and detach at ${width}px: route answer plus native event, bounded safe label, no local receipt`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await waitConversation(page, "available")
    model.binding = "attached"
    model.bindingLabel = `אבג <img onerror=alert(1)> ${"W".repeat(90)}`
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await waitConversation(page, "attached")
    const text = conversation(page)
    assert.equal(await text.locator("img, script").count(), 0, "labels render as text")
    assert.equal(await text.locator("bdi").count(), 1)
    assert.ok((await text.innerText()).includes(model.bindingLabel), "the full label is shown as text")
    const box = await line(page, "conversation").boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, "the Conversation line stays within the viewport")
    assert.equal(await conversationAction(page).innerText(), "Detach")
    assert.equal(count(calls, "hosts") + count(calls, "attach"), 0, "an external attach needs no local receipt")
    model.binding = "none"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await waitConversation(page, "available")
    assert.equal(count(calls, "detach"), 0, "an external detach is a read, never a mutation")
  }, width)
})

test("AC-C12 reload, conversation change, reconnect and stream open read the binding again and show the same state", async () => {
  await withAttachment(async ({ page, model, calls, reload }) => {
    Object.assign(model, { binding: "attached", bindingLabel: "Restored scene" })
    await reload()
    await page.waitForFunction(() => Boolean((window as any).integrationFixture))
    await openStatus(page)
    await waitConversation(page, "attached")
    assert.match(await conversation(page).innerText(), /Restored scene/)
    assert.equal(count(calls, "attach"), 0, "reload never replays attachment")
    model.bindingBySession.other = { state: "none" }
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await waitConversation(page, "available")
    assert.equal(calls.filter(call => call.action === "binding").at(-1)?.sessionID, "other")
    await shell(page, "selectSession", "session")
    await waitConversation(page, "attached")
    for (const step of ["reconnect", "open"] as const) {
      const before = count(calls, "binding")
      await call(page, step)
      await waitConversation(page, "attached")
      assert.ok(count(calls, "binding") > before, `${step} reads the binding again`)
    }
    model.binding = "none"
    const fresh = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/binding"))
    await reload()
    await page.waitForFunction(() => Boolean((window as any).integrationFixture))
    await openStatus(page)
    await fresh
    await waitConversation(page, "available")
    assert.equal(count(calls, "detach"), 0, "external detachment is a read, never a replay")
  })
})

for (const variant of ["unknown-answer", "timeout", "forbidden", ...failureKinds, "extra-fields", "oversized-label"] as const)
test(`AC-C12 binding ${variant} shows Binding unknown, never No open application, and stays confidential`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    Object.assign(model, { binding: "attached" })
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    model.offers = 0
    if (variant === "unknown-answer") model.binding = "unknown"
    else if (variant === "extra-fields") model.bindingExtra = true
    else if (variant === "oversized-label") model.bindingLabel = "x".repeat(121)
    else if (variant === "timeout") model.holdBinding = true
    else if (variant === "forbidden") model.bindingStatus = 403
    else model.failure = { action: "binding", kind: variant }
    await call(page, "reconnect")
    await waitConversation(page, "unknown")
    if (variant === "timeout") assert.equal(model.bindingRequests.length > 0, true, "the binding read is still pending")
    assert.equal(await conversation(page).innerText(), "Binding unknown")
    assert.equal(await conversationAction(page).innerText(), "Refresh")
    assert.doesNotMatch(await sectionBody(page).innerText(), /No open application|Attached to/)
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "binding error display")
    Object.assign(model, { binding: "attached", bindingExtra: false, bindingLabel: "Scene", failure: undefined, holdBinding: false, bindingStatus: 0 })
    // The timed-out read finally answers as the route does after its deadline.
    for (const pending of model.bindingRequests.splice(0)) await pending.fulfill({ json: { state: "unknown" } }).catch(() => {})
    await waitConversation(page, "unknown")
    await conversationAction(page).click()
    await waitConversation(page, "attached")
    assert.equal(count(calls, "detach") + count(calls, "attach") + count(calls, "hosts"), 0)
  })
})

test("AC-C12 pending binding reads cannot publish into another session/Location or revive revoked authority", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    model.binding = "attached"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await waitConversation(page, "attached")
    model.holdBinding = true
    await call(page, "event", "config.updated")
    assert.notEqual(await conversation(page).getAttribute("data-conversation-state"), "attached", "invalidation revokes Detach before debounce")
    await page.waitForTimeout(350)
    assert.deepEqual(heldSessions(model), ["session"])
    const obsolete = await takeBinding(model, "session")
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    const other = await takeBinding(model, "other")
    await obsolete.fulfill({ json: { state: "attached", label: "Obsolete" } }).catch(() => {})
    await other.fulfill({ json: { state: "none" } })
    await waitConversation(page, "available")
    assert.equal(await page.getByText("Obsolete").count(), 0)
    // The displayed conversation moves to another Location: its binding is read there.
    for (const pending of model.bindingRequests.splice(0)) await pending.fulfill({ json: { state: "none" } }).catch(() => {})
    await call(page, "move", "other", "/worktree")
    const moved = await takeBinding(model, "other")
    assert.equal(new URL(moved.request().url()).searchParams.get("directory"), "/worktree")
    await moved.fulfill({ json: { state: "attached", label: "Moved" } })
    await waitConversation(page, "attached")
    assert.match(await conversation(page).innerText(), /Moved/)
    for (const pending of model.bindingRequests.splice(0)) await pending.fulfill({ json: { state: "attached", label: "Moved" } }).catch(() => {})
    await call(page, "disconnect")
    assert.notEqual(await conversation(page).getAttribute("data-conversation-state"), "attached")
    await call(page, "reconnect")
    const preOpen = await takeBinding(model, "other")
    await call(page, "open")
    await preOpen.fulfill({ json: { state: "attached", label: "Pre-open" } }).catch(() => {})
    // Reconnect shares the current read and queues one trailing read; it never starts parallel authority reads.
    const afterOpen = await takeBinding(model, "other")
    await page.waitForTimeout(100)
    assert.notEqual(await conversation(page).getAttribute("data-conversation-state"), "attached", "pre-open answer is fenced")
    await afterOpen.fulfill({ json: { state: "none" } })
    await waitConversation(page, "available")
    assert.equal(calls.some(call => call.action === "detach"), false)
  })
})

for (const disconnect of ["disconnect", "transportDisconnect"]) test(`AC-C12 ${disconnect} aborts dirty trailing work until reconnect`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = "attached"
    await call(page, "reconnect")
    await waitConversation(page, "attached")
    model.holdBinding = true
    await call(page, "event", "config.updated")
    await page.waitForTimeout(350)
    await call(page, "event", "plugin.updated")
    await page.waitForTimeout(350)
    const reads = count(calls, "binding")
    await call(page, disconnect)
    assert.notEqual(await conversation(page).getAttribute("data-conversation-state"), "attached")
    await model.bindingRequests[0]!.fulfill({ json: { state: "attached", label: "Stale" } }).catch(() => {})
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await page.waitForTimeout(400)
    assert.equal(count(calls, "binding"), reads, "disconnected work cannot revive authority")
    assert.notEqual(await conversation(page).getAttribute("data-conversation-state"), "attached")
    model.holdBinding = false
    await call(page, disconnect === "disconnect" ? "reconnect" : "open")
    await waitConversation(page, "attached")
  })
})

test("AC-C12 unsupported WSL host: Not supported with its i, and zero hosts, attach, detach or install calls", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    Object.assign(model, { host: "unsupported", hostAction: "install", binding: "attached" })
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await waitConversation(page, "unsupported")
    assert.equal(await stateBadge(page).getAttribute("data-integration-state"), "unsupported")
    assert.equal(await conversation(page).innerText(), "Not supported")
    assert.equal(await conversationAction(page).count(), 0)
    const info = line(page, "conversation").getByRole("button", { name: "Not supported", exact: true })
    await info.click()
    await page.getByText("Not available on this OpenCode machine.").waitFor()
    await page.keyboard.press("Escape")
    assert.equal(await line(page, "application").getByRole("button", { name: /Install in application|Update application/ }).count(), 0)
    await echoes(page)
    await page.waitForTimeout(450)
    for (const action of ["hosts", "attach", "detach", "install-host"]) assert.equal(count(calls, action), 0, `no ${action} call`)
  })
})

test("native dispatcher coalesces events, reconciles reconnect/open, forgets stopped workspaces and never polls", async () => {
  await withAttachment(async ({ page, calls }) => {
    await waitConversation(page, "available")
    const reads = () => count(calls, "read")
    const before = reads()
    await call(page, "burst")
    await page.waitForTimeout(650)
    assert.equal(reads(), before + 1)
    await page.waitForTimeout(1000)
    assert.equal(reads(), before + 1, "no polling")
    await launch(page)
    await call(page, "reconnect")
    await page.locator(".integration-attachment").waitFor({ state: "hidden" })
    await page.waitForTimeout(200)
    assert.ok(reads() > before + 1)
    const reconnectReads = reads()
    await call(page, "open")
    await page.waitForTimeout(200)
    assert.ok(reads() > reconnectReads)
    await shell(page, "setActive", false)
    const hiddenReads = reads(), hiddenBindings = count(calls, "binding")
    await call(page, "burst")
    await page.waitForTimeout(650)
    assert.equal(reads(), hiddenReads, "native events do not read an inactive conversation")
    assert.equal(count(calls, "binding"), hiddenBindings)
    await shell(page, "setActive", true)
    await actionReady(page, "Attach…")
    await call(page, "demandStopped")
    await page.waitForTimeout(100)
    assert.equal(await call(page, "snapshot"), "ready")
    await call(page, "stop")
    assert.equal(await call(page, "snapshot"), "loading")
  })
})

for (const dark of [false, true]) test(`section screenshots at 420px ${dark ? "dark" : "light"}: available, attached, uncertain, unsupported`, async () => {
  await withAttachment(async ({ page, model }) => {
    const shoot = async (name: string) => {
      await page.waitForTimeout(100)
      if (screenshots) await section(page).screenshot({ path: join(screenshots, `section-${name}-420-${dark ? "dark" : "light"}.png`) })
    }
    await waitConversation(page, "available")
    await shoot("available")
    model.binding = "attached"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await waitConversation(page, "attached")
    await shoot("attached")
    model.failure = { action: "detach", kind: "network-error" }
    await conversationAction(page).click()
    await waitConversation(page, "uncertain")
    assert.equal(await stateBadge(page).getAttribute("data-integration-state"), "uncertain")
    await shoot("uncertain")
    model.failure = undefined
    model.host = "unsupported"
    await conversationAction(page).click()
    await waitConversation(page, "unsupported")
    await shoot("unsupported")
  }, 420, 900, { colorScheme: dark ? "dark" : "light" })
})
