// prototype-1236: an `opencode pair` link pasted into Add server is exchanged by the host backend only.
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const ENTRY = "tests/browser/fixtures/opencode-server-pairing.tsx"
const ORIGIN = "https://box.example.opentunnel.test"
const HOST = `<script>window.__CODENOMAD_WINDOW_CONTEXT__ = "local"; window.__CODENOMAD_RUNTIME_HOST__ = "electron";
window.opened = []; window.electronAPI = { openRemoteWindow: async (payload) => { window.opened.push(payload) } }</script>`

let browser: Browser, url: string
before(async () => {
  ;({ url } = await borrowFixture({ name: "opencode-server-pairing", routes: [{ path: "/fixture",
    html: `<html><body><div id="root"></div>${HOST}<script type="module" src="/${ENTRY}"></script></body></html>` }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

type State = { added: Array<{ name?: string; address: string }>; fetched: string[]; opened: unknown[] }
const state = (page: Page) => page.evaluate(() => {
  const value = window as unknown as State
  return { added: value.added, fetched: value.fetched, opened: value.opened }
})

async function submit(page: Page, address: string) {
  await page.getByLabel("Name").fill("Box")
  await page.getByLabel("Server URL").fill(address)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
}

test("an opencode pair link goes to the host backend once, never to this page or a window", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.goto(url)
    await page.getByLabel("Server URL").waitFor()
    await submit(page, `${ORIGIN}/auth/connect/fresh-code`)
    await page.waitForFunction(() => (window as unknown as State).added.length === 1)
    const result = await state(page)
    assert.deepEqual(result.added, [{ name: "Box", address: `${ORIGIN}/auth/connect/fresh-code` }])
    assert.deepEqual(result.opened, [])
    assert.equal(result.fetched.some(value => value.includes("/auth/connect/")), false)
    assert.equal(await page.evaluate(() => (window as unknown as { uiState: () => string }).uiState().includes("fresh-code")), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an expired link shows the field's ordinary connection error", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(url)
    await page.getByLabel("Server URL").waitFor()
    await submit(page, `http://127.0.0.1:4096/auth/connect/expired-code`)
    await page.getByText("Could not connect to the remote server.", { exact: true }).waitFor()
    assert.equal((await state(page)).added.length, 1)
  } finally { await page.close() }
})

test("a Remote Control link is not taken for an OpenCode server", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(url)
    await page.getByLabel("Server URL").waitFor()
    await submit(page, "https://codenomad.example.test/remote-pair#code")
    // The fixture refuses CodeNomad probes; the OpenCode exchange stays untouched.
    await page.getByText("an OpenCode link must not be probed as a CodeNomad server").waitFor()
    assert.deepEqual((await state(page)).added, [])
  } finally { await page.close() }
})

test("an OpenCode link has one action and no TLS override, the name defaults to its host, and no intro is shown", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, locale: "en-US" })
  try {
    await page.goto(url)
    await page.getByLabel("Server URL").waitFor()
    assert.equal(await page.getByText("Add a remote CodeNomad server", { exact: false }).count(), 0)
    await page.getByText("CodeNomad or OpenCode address or pairing link", { exact: true }).waitFor()
    await page.getByLabel("Server URL").fill("https://codenomad.example.test")
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 1)
    assert.equal(await page.getByRole("checkbox").count(), 1)
    await page.getByLabel("Server URL").fill(`${ORIGIN}/auth/connect/named-by-host`)
    assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0)
    assert.equal(await page.getByRole("checkbox").count(), 0)
    assert.equal(await page.getByLabel("Name").getAttribute("placeholder"), "box.example.opentunnel.test")
    await page.getByRole("button", { name: "Connect", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as State).added.length === 1)
    assert.deepEqual((await state(page)).added, [{ name: "box.example.opentunnel.test", address: `${ORIGIN}/auth/connect/named-by-host` }])
  } finally { await page.close() }
})
