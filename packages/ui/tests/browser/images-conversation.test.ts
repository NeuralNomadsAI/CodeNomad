import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("images-conversation") })
after(async () => { await fixture?.close() })

type Answer = Record<string, unknown>
async function openPage(answers: Answer[]) {
  const page = await fixture.browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  const bodies: unknown[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (route.request().url().endsWith("/api/workspaces/images-instance/images-conversation")) {
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(answers.shift() ?? { status: "unknown" }) })
    }
    return route.fulfill({ contentType: "application/json", body: "{}" })
  })
  await page.goto(fixture.url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors, bodies }
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())
const open = (page: Page, mode: "open" | "new") => page.evaluate(value => (window as any).fixture.open(value), mode)
const sendButton = (page: Page) => page.getByRole("button", { name: "Send message", exact: true })
const notice = (page: Page) => page.getByRole("status").filter({ hasText: "The Design agent is not available" })
async function waitFor(page: Page, predicate: (state: any) => boolean, description: string) {
  const deadline = Date.now() + 5000
  while (!predicate(await snapshot(page))) {
    if (Date.now() > deadline) throw new Error(`Did not observe ${description}: ${JSON.stringify(await snapshot(page))}`)
    await page.waitForTimeout(20)
  }
}

test("Open creates the Images conversation with Design and CodeNomad's model, focuses the composer and sends nothing; New adds another", async () => {
  const { page, errors, bodies } = await openPage([
    { status: "found", sessionID: "ses_images", created: true, gitExclusion: "excluded" },
    { status: "found", sessionID: "ses_images", created: false, gitExclusion: "excluded" },
    { status: "found", sessionID: "ses_images_new", created: true, gitExclusion: "excluded" },
  ])
  try {
    assert.equal((await snapshot(page)).active, "ses_work")
    const created = await open(page, "open")
    assert.deepEqual(created, { status: "found", sessionID: "ses_images", created: true, gitExclusion: "excluded" })
    // CodeNomad resolves the provider default ("chosen"), not the native default ("native").
    assert.deepEqual(bodies[0], { directory: "/fixture", mode: "open", title: "Images", agent: "design", model: { providerID: "fixture", id: "chosen" } })
    await waitFor(page, state => state.active === "ses_images" && state.focused, "the focused Images composer")
    let state = await snapshot(page)
    assert.equal(state.listed[0], "ses_images")
    assert.equal(state.prompts, 0)
    assert.deepEqual(await notice(page).count(), 0)

    // Reopening from a work conversation: the found conversation keeps the model it has since chosen.
    await page.evaluate(async () => {
      await (window as any).fixture.changeModel("ses_images", "native")
      await (window as any).fixture.show("ses_work")
    })
    await waitFor(page, state => state.active === "ses_work", "the work conversation")
    const modelWrites = (await snapshot(page)).switchModel.length
    await open(page, "open")
    await waitFor(page, state => state.active === "ses_images" && state.focused, "the reopened Images composer")
    state = await snapshot(page)
    assert.deepEqual(state.model, { providerId: "fixture", modelId: "native" })
    assert.equal(state.switchModel.length, modelWrites, "opening never writes the model")

    // New Images conversation: another marked session, the previous one stays listed.
    await open(page, "new")
    assert.equal((bodies[2] as any).mode, "new")
    await waitFor(page, state => state.active === "ses_images_new" && state.focused, "the new Images composer")
    state = await snapshot(page)
    assert.deepEqual(state.listed.slice(0, 2), ["ses_images_new", "ses_images"])
    assert.equal(state.prompts, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("another Location's catalog never blocks or decides creation, even when its own refresh waits or fails", async () => {
  const { page, errors, bodies } = await openPage([])
  try {
    // The first Location really lacks Design: its Images conversation is blocked.
    await page.evaluate(() => (window as any).fixture.setDesignPresent(false))
    await page.evaluate(() => (window as any).fixture.show("ses_images"))
    await notice(page).waitFor()

    // Switch to an Images conversation of a Location that has Design, while its catalog read waits.
    await page.evaluate(() => (window as any).fixture.setOther("hang"))
    await page.evaluate(() => (window as any).fixture.show("ses_other_images"))
    await waitFor(page, state => state.active === "ses_other_images", "the other Location's conversation")
    await page.waitForFunction(() => (window as any).fixture.otherWaiting() > 0)
    const input = page.locator("textarea.prompt-input")
    await input.fill("Draw a banner")
    assert.equal(await notice(page).count(), 0, "the first Location's catalog does not judge this one")
    assert.equal(await sendButton(page).isDisabled(), false)

    // A failed refresh keeps the catalog unloaded for this Location: no block, and no creation either.
    await page.evaluate(() => (window as any).fixture.releaseOther(false))
    await page.waitForTimeout(100)
    assert.equal(await notice(page).count(), 0)
    assert.equal(await sendButton(page).isDisabled(), false)
    await page.evaluate(() => (window as any).fixture.setOther("fail"))
    assert.deepEqual(await open(page, "open"), { status: "unknown" })
    assert.equal(bodies.length, 0, "Design's presence unknown: nothing is created")

    // Once this Location's own catalog loads, it decides: absent blocks, present does not.
    await page.evaluate(async () => { (window as any).fixture.setOther("ok", false); await (window as any).fixture.refreshOther() })
    await notice(page).waitFor()
    await page.evaluate(async () => { (window as any).fixture.setOther("ok", true); await (window as any).fixture.refreshOther() })
    await notice(page).waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an unknown lookup creates nothing and keeps the current conversation", async () => {
  const { page, errors } = await openPage([{ status: "unknown" }])
  try {
    assert.deepEqual(await open(page, "open"), { status: "unknown" })
    const state = await snapshot(page)
    assert.equal(state.active, "ses_work")
    assert.equal(state.listed.length, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("without the Design agent: creation has no agent, and only an Images conversation selecting design is blocked until the default agent", async () => {
  const { page, errors, bodies } = await openPage([{ status: "found", sessionID: "ses_images", created: true, gitExclusion: "unavailable" }])
  try {
    await page.evaluate(() => (window as any).fixture.setDesignPresent(false))
    await open(page, "open")
    assert.deepEqual(bodies[0], { directory: "/fixture", mode: "open", title: "Images", model: { providerID: "fixture", id: "chosen" } })
    await waitFor(page, state => state.active === "ses_images", "the Images conversation")

    // The conversation still selects design (created while the agent existed): blocked.
    await notice(page).waitFor()
    const input = page.locator("textarea.prompt-input")
    await input.fill("Draw an app icon")
    assert.equal(await sendButton(page).isDisabled(), true)
    await input.press("Enter")
    await page.waitForTimeout(100)
    assert.equal((await snapshot(page)).prompts, 0)
    assert.equal(await input.inputValue(), "Draw an app icon", "typing stays available")

    await notice(page).getByRole("button", { name: "Use the default agent" }).click()
    await notice(page).waitFor({ state: "detached" })
    assert.deepEqual((await snapshot(page)).switchAgent, [{ sessionID: "ses_images", agent: "build" }])
    assert.equal(await sendButton(page).isDisabled(), false)
    await input.press("Enter")
    await waitFor(page, state => state.prompts === 1, "the send the default agent re-enabled")

    // Another selected agent, or an unmarked conversation using design, is never blocked.
    for (const id of ["ses_images_build", "ses_unmarked_design"]) {
      await page.evaluate(value => (window as any).fixture.show(value), id)
      await waitFor(page, state => state.active === id, id)
      await page.locator("textarea.prompt-input").fill("Hello")
      assert.equal(await notice(page).count(), 0, id)
      assert.equal(await sendButton(page).isDisabled(), false, id)
    }

    // The agent coming back lifts the block too.
    await page.evaluate(() => (window as any).fixture.show("ses_images_new"))
    await waitFor(page, state => state.active === "ses_images_new", "the second Images conversation")
    await notice(page).waitFor()
    await page.evaluate(() => (window as any).fixture.setDesignPresent(true))
    await notice(page).waitFor({ state: "detached" })
    await page.locator("textarea.prompt-input").fill("Hello")
    assert.equal(await sendButton(page).isDisabled(), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
