import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { assertSentinelsHidden, sentinelForms } from "../../../server/src/remote-control/test-support/sentinel-forward"

const sentinel = "SECRET_ENTRY_SENTINEL_731"
const pairing = `https://fixture.opentunnel.xyz/remote-pair#${sentinel}`
const sentinels = [sentinel, pairing, "PASSWORD_SENTINEL_+/?\\\"\n", "DEVICE_TOKEN_SENTINEL_592",
  "PAIRING_TOKEN_SENTINEL_281", "RELAY_PROOF_SENTINEL_417", "SSH_PRIVATE_KEY_SENTINEL_862",
  "C:\\synthetic\\SSH_PATH_SENTINEL_936", "TLS_PRIVATE_KEY_SENTINEL_184"]
const refusal = "Use HTTPS or Remote Control to enter credentials."
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
type Meta = { localRequest: boolean; secretEntryAllowed?: boolean; serversUsable?: boolean; serversManageable?: boolean }

async function fixture(t: TestContext, surface: string, initial: Meta) {
  const borrowed = await borrowFixture({ name: "remote-secret-entry", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/remote-secret-entry.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage()
  const events = await fixtureEventStream(borrowed.url)
  page.setDefaultTimeout(10_000)
  let meta = initial
  let profiles = [{ id: "a", name: "Alpha", baseUrl: ["browser", "restore"].includes(surface) ? "https://password-host.test" : "https://fixture.opentunnel.xyz", skipTlsVerify: false, createdAt: "", updatedAt: "" }]
  let patchGate: ReturnType<typeof deferred> | undefined
  const gates = new Set<ReturnType<typeof deferred>>()
  const requests: Array<{ method: string; path: string; body: string }> = []
  const leaks: string[] = [], errors: string[] = [], unexpected: string[] = []
  const network: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  const responses: Promise<void>[] = []
  const storageSnapshot = () => page.evaluate(() => ({
    local: { ...localStorage }, session: { ...sessionStorage },
  }))
  const checkStorage = async () => {
    assertSentinelsHidden(await storageSnapshot(), sentinels, "browser local/session storage keys and values")
  }
  t.after(async () => {
    for (const gate of gates) gate.release()
    try { await checkStorage() }
    finally { await browser.close(); await events.close(); await borrowed.close() }
  })
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    const capture = { url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() ?? "" }
    network.push(capture)
    if (sentinels.some(value => sentinelForms(value).some(form => JSON.stringify(capture).includes(form)))) leaks.push(new URL(request.url()).pathname)
  })
  page.on("response", response => {
    if (!new URL(response.url()).pathname.startsWith("/api/")) return
    responses.push((async () => {
      const headers = await response.allHeaders()
      assertSentinelsHidden({ url: response.url(), headers,
        body: headers["content-type"]?.includes("text/event-stream") ? "" : await response.text() },
        sentinels, "captured browser response")
    })())
  })
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    requests.push({ method: request.method(), path, body: request.postData() ?? "" })
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    if (path === "/api/meta") return json(meta)
    if (path === "/api/storage/config/ui") return json({ settings: { multiBackend: true, locale: "en" } })
    if (path === "/api/storage/config/server") return json({})
    if (path === "/api/storage/state/ui") {
      if (request.method() === "PATCH") {
        const gate = patchGate; patchGate = undefined
        await gate?.promise
        profiles = request.postDataJSON().remoteServers ?? profiles
      }
      return json({ remoteServers: profiles })
    }
    if (path === "/api/remote-servers/ssh-hosts") return json({ hosts: [] })
    if (path === "/api/remote-servers/probe") return json({ ok: true, normalizedUrl: request.postDataJSON().baseUrl })
    if (/\/api\/remote-servers\/[^/]+\/connect$/.test(path)) return json({ ok: true })
    if (/\/api\/backends\/[^/]+\/api\/auth\/login$/.test(path)) return json({ ok: true })
    if (/\/api\/remote-servers\/[^/]+\/browse$/.test(path)) return json({ error: "needs_credentials", code: "needs_credentials" }, 401)
    // These stores are imported by the real browser dialog and restore component.
    if (path === "/api/workspaces") return json([])
    if (path === "/api/auth/status") return json({ authenticated: true })
    if (path === "/api/auth/login") return json({ ok: true })
    if (path === "/api/speech/capabilities") return json({})
    unexpected.push(`${request.method()} ${path}`)
    return json({})
  })
  await events.route(page)
  await page.goto(`${borrowed.url}?surface=${surface}`)
  await page.waitForFunction(() => !!(window as any).secretEntryFixture)
  return {
    page, requests, leaks, network, storageSnapshot,
    holdPatch: () => { patchGate = deferred(); gates.add(patchGate); return patchGate },
    revoke: async () => {
      meta = { ...meta, secretEntryAllowed: false }
      await page.evaluate(async () => { await (await import("/src/lib/server-meta.ts" as string)).getServerMeta(true) })
    },
    check: async (allowedSecrets = 0) => {
      assert.equal(leaks.length, allowedSecrets, "exact secret-bearing outgoing request count")
      for (const capture of network) {
        let body = capture.body
        if (allowedSecrets && capture.method === "POST") {
          const path = new URL(capture.url).pathname
          if (path === "/api/auth/login") {
            assert.deepEqual(JSON.parse(body), { username: "codenomad", password: sentinel })
            body = ""
          } else if (/^\/api\/remote-servers\/[^/]+\/connect$/.test(path) && body.includes(sentinel)) {
            assert.deepEqual(JSON.parse(body), { pairingLink: pairing })
            body = ""
          }
        }
        assertSentinelsHidden({ ...capture, body }, sentinels, "captured non-carrier browser request")
      }
      await Promise.all(responses)
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
      await checkStorage()
    },
  }
}
test("encoding guards detect planted network and both browser-storage counterexamples without credential dispatch", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "dispatch", { localRequest: false, secretEntryAllowed: false })
  const forms = sentinels.flatMap(value => sentinelForms(value))
  const snapshots = await f.page.evaluate(forms => {
    return forms.flatMap(form => [localStorage, sessionStorage].map(store => {
      store.setItem("synthetic-secret", form)
      const snapshot = { local: { ...localStorage }, session: { ...sessionStorage } }
      store.removeItem("synthetic-secret")
      return snapshot
    }))
  }, forms)
  assert.equal(forms.length, 270, "9 sentinel types × 30 representation slots")
  assert.equal(snapshots.length, 540, "every representation planted in both browser stores")
  for (const snapshot of snapshots) assert.throws(() => assertSentinelsHidden(snapshot, sentinels, "planted browser storage"))
  for (const form of forms) {
    for (const capture of [{ url: `https://capture.invalid/${form}` }, { headers: { "x-leak": form } }, { body: form }]) {
      assert.throws(() => assertSentinelsHidden(capture, sentinels, "planted network capture"))
    }
  }
  assert.equal(f.requests.filter(request => request.method === "POST"
    && (request.path.endsWith("/connect") || request.path.endsWith("/auth/login"))).length, 0)
  await f.check()
  t.diagnostic("9 sentinels × 30 slots: 540 browser-storage and 810 network counterexamples; zero credential requests")
})
const field = (page: Page) => page.locator("[data-server-add-field]")
async function forgedInput(page: Page, selector: string, value: string) {
  await page.locator(selector).evaluate((element, value) => {
    const input = element as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, value)
}
async function submitForm(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
}

for (const localRequest of [false, true]) test(`refused inline pairing rejects input, paste and submit; address remains usable (local ${localRequest})`, { timeout: 60_000 }, async t => {
  const f = await fixture(t, "inline", { localRequest, serversUsable: true, serversManageable: true, secretEntryAllowed: false })
  assert.equal(await field(f.page).isDisabled(), false)
  await field(f.page).fill(pairing)
  await f.page.getByRole("alert").filter({ hasText: refusal }).waitFor()
  assert.equal(await field(f.page).inputValue(), "")
  await submitForm(f.page, ".server-add-field form")
  await field(f.page).evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text", text)
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, pairing)
  assert.equal(await field(f.page).inputValue(), "")
  assert.equal(f.requests.filter(request => request.path.endsWith("/probe") || request.path.endsWith("/connect")).length, 0)
  await field(f.page).fill("https://address-only.test")
  await field(f.page).press("Enter")
  await f.page.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-server-add-field]")?.value
    && !document.querySelector<HTMLInputElement>("[data-server-add-field]")?.disabled)
  assert.equal(f.requests.filter(request => request.path.endsWith("/probe")).length, 1)
  assert.equal(f.requests.filter(request => request.path.endsWith("/connect")).length, 0)
  await f.check()
})

test("dedicated pairing field is disabled with the localized transport refusal", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "pairing", { localRequest: false, secretEntryAllowed: false })
  assert.equal(await field(f.page).isDisabled(), true)
  await f.page.getByText(refusal, { exact: true }).waitFor()
  await forgedInput(f.page, "[data-server-add-field]", pairing)
  await submitForm(f.page, ".server-add-field form")
  assert.equal(f.requests.filter(request => request.path.endsWith("/connect") || request.path.endsWith("/probe")).length, 0)
  await f.check()
})

test("editor rejects a pairing secret on input and submit without blocking address edits", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "editor", { localRequest: false, serversManageable: true, secretEntryAllowed: false })
  const url = f.page.getByRole("textbox", { name: "URL", exact: true })
  await url.fill(pairing)
  await f.page.getByRole("alert").filter({ hasText: refusal }).waitFor()
  assert.equal(await url.inputValue(), "")
  await f.page.getByRole("button", { name: "Save", exact: true }).click()
  assert.equal(f.requests.filter(request => request.path.endsWith("/probe") || request.path.endsWith("/connect")).length, 0)
  assert.equal(await url.isDisabled(), false)
  await f.check()
})

for (const surface of ["restore", "browser"]) test(`${surface} sign-in disables passwords and fences forged submission`, { timeout: 60_000 }, async t => {
  const f = await fixture(t, surface, { localRequest: false, secretEntryAllowed: false })
  if (surface === "restore") await f.page.getByRole("button", { name: "Connect", exact: true }).click()
  const passwords = f.page.locator('input[type="password"]')
  await passwords.first().waitFor()
  assert.equal(await passwords.count(), 1)
  for (const password of await passwords.all()) assert.equal(await password.isDisabled(), true)
  await f.page.getByText(refusal, { exact: true }).first().waitFor()
  await passwords.first().evaluate((element, value) => {
    const input = element as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, sentinel)
  await submitForm(f.page, ".remote-server-signin")
  assert.equal(f.requests.filter(request => request.path.endsWith("/connect") || request.path.endsWith("/auth/login")).length, 0)
  await f.check()
})

test("omitted capabilities retain affirmative local pairing fallback", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "inline", { localRequest: true })
  await field(f.page).fill(pairing)
  await field(f.page).press("Enter")
  await f.page.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-server-add-field]")?.disabled)
  assert.equal(f.requests.filter(request => request.path.endsWith("/probe")).length, 1)
  assert.equal(f.requests.filter(request => request.path.endsWith("/connect")).length, 1)
  assert.equal(f.leaks.length, 1, "the permitted connect is the sole secret-bearing request")
  assert.deepEqual(f.leaks, f.requests.filter(request => request.path.endsWith("/connect")).map(request => request.path))
  await f.check(1)
})

test("captured relay hook rechecks secret capability after a held profile PATCH, before connect dispatch", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "dispatch", { localRequest: true, secretEntryAllowed: true })
  const gate = f.holdPatch()
  const patchEntered = f.page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith("/api/storage/state/ui"))
  await f.page.evaluate(link => {
    const submit = (window as any).secretEntryFixture.profiles.submitServer
    ;(window as any).secretEntryPending = submit({ name: "Pending", baseUrl: link, skipTlsVerify: false })
      .then(() => "accepted", () => "refused")
  }, pairing)
  await patchEntered
  await f.revoke()
  gate.release()
  assert.equal(await f.page.evaluate(() => (window as any).secretEntryPending), "refused")
  assert.equal(f.requests.filter(request => request.path.endsWith("/probe")).length, 1)
  assert.equal(f.requests.filter(request => request.method === "PATCH" && request.path === "/api/storage/state/ui").length, 1)
  assert.equal(f.requests.filter(request => request.path.endsWith("/connect")).length, 0)
  await f.check()
})

for (const api of ["connectRemoteServer", "relaySignIn"] as const) {
  test(`captured ${api} refuses typed credentials after revocation at the dispatch boundary`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, "dispatch", { localRequest: false, secretEntryAllowed: true })
    await f.page.evaluate(async api => {
      const { serverApi } = await import("/src/lib/api-client.ts" as string)
      const { createRemoteBackendClient } = await import("/src/lib/backend-client.ts" as string)
      const { RemoteServerRequestError } = await import("/src/lib/remote-server-request.ts" as string)
      const relay = createRemoteBackendClient("a")
      const captured = api === "relaySignIn" ? relay.auth.signIn : serverApi[api]
      ;(window as any).capturedSecretDispatch = async (value: string, pairing: boolean) => {
        try {
          if (api === "relaySignIn") await captured("codenomad", value)
          else await captured("a", pairing ? { pairingLink: value } : { username: "codenomad", password: value })
          return { accepted: true }
        } catch (error) {
          return { accepted: false, typed: error instanceof RemoteServerRequestError, code: (error as any).code }
        }
      }
      ;(window as any).capturedSecretFreeDispatch = () => serverApi.connectRemoteServer("a", {})
    }, api)
    await f.revoke()
    for (const value of api === "relaySignIn" ? [sentinel] : [sentinel, pairing]) {
      assert.deepEqual(await f.page.evaluate(({ value, pairing }) => (window as any).capturedSecretDispatch(value, pairing),
        { value, pairing: value === pairing }), { accepted: false, typed: true, code: "secret_entry_forbidden" })
    }
    assert.equal(f.requests.filter(request => request.method === "POST"
      && (request.path.endsWith("/connect") || request.path.endsWith("/auth/login"))).length, 0)
    assert.deepEqual(await f.page.evaluate(() => (window as any).capturedSecretFreeDispatch()), { ok: true })
    const secretFree = f.requests.filter(request => request.method === "POST"
      && (request.path.endsWith("/connect") || request.path.endsWith("/auth/login")))
    assert.equal(secretFree.length, 1)
    assert.equal(secretFree[0].body, "{}")
    await f.check()
  })
}

test("host auth recovery still allows LAN password login when remote secret entry is forbidden", { timeout: 60_000 }, async t => {
  const f = await fixture(t, "dispatch", { localRequest: false, secretEntryAllowed: false })
  assert.equal(await f.page.evaluate(async password => {
    const { authRecovery } = await import("/src/lib/auth-recovery.ts" as string)
    return authRecovery.signIn("codenomad", password)
  }, sentinel), "ok")
  const logins = f.requests.filter(request => request.method === "POST" && request.path === "/api/auth/login")
  assert.equal(logins.length, 1)
  assert.deepEqual(JSON.parse(logins[0].body), { username: "codenomad", password: sentinel })
  assert.deepEqual(f.leaks, ["/api/auth/login"])
  await f.check(1)
})
