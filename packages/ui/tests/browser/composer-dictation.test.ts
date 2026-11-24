import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { startProductFixture } from "./fixtures/product-fixture-server"

let fixture: Awaited<ReturnType<typeof startProductFixture>>
before(async () => { fixture = await startProductFixture("composer-dictation") })
after(async () => { await fixture?.close() })

async function withComposer(run: (page: Page) => Promise<void>, mobile = false, native?: "remote" | "remote-api" | "remote-api-legacy" | "remote-tauri" | "wsl" | "hex-setup" | "tauri-api" | "tauri-preferences" | "tauri-remote-api", pcm = false, locale: "en" | "he" | "zh-Hans" = "en", ttsOnly = false, unconfigured: boolean | Promise<number> = false, options: { alerts?: boolean; history?: boolean; engineStatus?: Promise<number>; expectedSends?: string[]; unsupportedChoice?: boolean } = {}) {
  const context = await fixture.browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 900, height: 600 },
    isMobile: mobile, hasTouch: mobile,
  })
  armFixtureNavigationBudget(context)
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  const errors: Error[] = []
  page.on("pageerror", error => errors.push(error))
  try {
    if (native) {
      const installNativeBridge = (kind: typeof native, unsupportedChoice: boolean) => {
        const requests: Array<Record<string, unknown>> = []
        const settings = {
          opened: [] as string[], engine: unsupportedChoice ? null : "api", state: "needsPreparation", token: "plan-initial",
          remaining: 5_500_000, phase: { state: "downloading", downloadedBytes: 1_250_000, error: "failed" },
          defer: false, readFails: false, acknowledge: () => {},
          holdRead: false, releaseRead: () => {}, holdCancelReceipt: false, releaseCancelReceipt: () => {},
        }
        const tauriApi = kind === "tauri-api" || kind === "tauri-preferences" || kind === "tauri-remote-api"
        const bridge = { requests, choice: kind === "remote" && unsupportedChoice ? "unsupported"
          : kind === "remote-api" || kind === "remote-api-legacy" || tauriApi ? "api" : "hex", operation: "recording",
          resolve: (_: string) => {}, holdMicrophone: false, admitMicrophone: () => {},
          denyMicrophone: false, microphoneState: "recording", readFails: false, denyLease: false }
        const mic = (action: unknown) => action === "claimMicrophone" ? { ok: true, value: { busy: bridge.denyLease ? "test" : null } }
          : action === "releaseMicrophone" ? { ok: true, value: null } : undefined
        const relay = async (request: Record<string, unknown>) => {
          requests.push(request)
          if (mic(request.action)) return mic(request.action)
          if (request.action === "read") {
            if (bridge.readFails) throw new Error("Engine could not be read")
            return bridge.choice
          }
          if (request.action === "begin") return new Promise<string>(resolve => { bridge.resolve = resolve })
           if (request.action === "startApiMicrophone" || request.action === "startApiInputTest") {
             if (request.action === "startApiMicrophone" && bridge.choice !== "api") throw "unavailable"
            if (bridge.holdMicrophone) await new Promise<void>(resolve => { bridge.admitMicrophone = resolve })
            if (bridge.denyMicrophone) throw "permissionDenied"
            bridge.microphoneState = "recording"
            return null
          }
          if (request.action === "statusApiMicrophone") return bridge.microphoneState
          if (request.action === "finishApiMicrophone") return "UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAABAA=="
          return null
        }
        const local = kind === "wsl" || kind === "hex-setup"
        const desktop = local ? {
          openPreferences: async (section: string) => {
            settings.opened.push(section)
            ;(window as any).fixture.setNativeSettings(true)
          },
          deviceSpeech: async (request: Record<string, unknown>) => {
            requests.push(request)
            if (mic(request.action)) return mic(request.action)
            if (kind === "hex-setup") {
              const snapshot = () => ({ engine: settings.engine,
                hex: { state: settings.state, plan: { id: settings.token, missing: settings.state === "ready" ? [] : [
                  { component: "engine", downloadBytes: 0 }, { component: "model", downloadBytes: settings.remaining },
                ] } },
              })
              switch (request.action) {
                case "read":
                  if (settings.holdRead) await new Promise<void>(resolve => { settings.releaseRead = resolve })
                  return settings.readFails ? { ok: false, error: "failed" } : { ok: true, value: snapshot() }
                case "select": settings.engine = request.engine as string; return { ok: true, value: snapshot() }
                case "prepare":
                  if (request.planId !== settings.token) return { ok: false, error: "planChanged" }
                  if (settings.defer) await new Promise<void>(resolve => { settings.acknowledge = resolve })
                  return { ok: true, value: { id: "00000000-0000-4000-8000-000000000001" } }
                case "start": return { ok: false, error: "failed" }
                case "status": return settings.phase.state === "forgotten"
                  ? { ok: false, error: "notOwned" } : { ok: true, value: settings.phase }
                case "cancel":
                  if (settings.phase.state === "prepared") {
                    settings.phase.state = "forgotten"
                    if (settings.holdCancelReceipt) await new Promise<void>(resolve => { settings.releaseCancelReceipt = resolve })
                    return { ok: true, value: { state: "prepared" } }
                  }
                  if (settings.phase.state !== "error") {
                    settings.phase.state = "cancelled"
                    settings.token = "plan-resumable"
                    settings.remaining = 4_250_000
                  }
                  return { ok: true, value: null }
              }
            }
            switch (request.action) {
              case "read": return { ok: true, value: { engine: "hex", hex: { state: "ready", plan: { id: "ready", missing: [] } } } }
              case "start": return { ok: true, value: { id: "00000000-0000-4000-8000-000000000001" } }
              case "status": return { ok: true, value: { state: bridge.operation,
                ...(bridge.operation === "transcribed" ? { text: "WSL text" } : {}) } }
              case "finish": bridge.operation = "transcribed"; return { ok: true, value: null }
              case "cancel": bridge.operation = "cancelled"; return { ok: true, value: null }
            }
          },
        } : { remoteDictation: relay, ...(kind !== "remote-api-legacy" ? { remoteMicrophoneLease: true } : {}) }
        Object.assign(window, { native: bridge, speechSettings: settings, __CODENOMAD_WINDOW_CONTEXT__: local ? "local" : "remote" })
        if (kind === "remote-tauri" || tauriApi) {
          const label = kind === "tauri-preferences" ? "preferences" : kind === "tauri-api" ? "local" : "remote"
          Object.assign(window, {
            __CODENOMAD_WINDOW_CONTEXT__: label,
            __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_REMOTE_DICTATION__: true,
            __TAURI_INTERNALS__: { metadata: { currentWindow: { label }, currentWebview: { label } }, invoke: async (command: string, payload: { request: Record<string, unknown> }) => {
              if (command === "device_speech_request" &&
                  (payload.request?.action === "authorizeApiMicrophone" || payload.request?.action === "revokeApiMicrophone")) {
                requests.push(payload.request)
                if (bridge.holdMicrophone && payload.request.action === "authorizeApiMicrophone") {
                  await new Promise<void>(resolve => { bridge.admitMicrophone = resolve })
                }
                return { ok: true, value: null }
              }
              if (command === "remote_dictation_request") return relay(payload.request)
              if (command === "device_speech_request") {
                requests.push(payload.request)
                if (mic(payload.request.action)) return mic(payload.request.action)
                return { ok: true, value: { engine: "api", hex: { state: "unavailable" } } }
              }
            } },
          })
          if (tauriApi) Object.defineProperty(navigator, "userAgent", { value: "Linux" })
        } else {
          Object.assign(window, { electronAPI: desktop, __CODENOMAD_RUNTIME_HOST__: "electron" })
        }
      }
      await page.addInitScript(`{ const __name = (value) => value; (${installNativeBridge.toString()})(${JSON.stringify(native)}, ${Boolean(options.unsupportedChoice)}); }`)
    }
    await context.route("**/api/**", async route => {
      const url = route.request().url()
      if (url.endsWith("/speech/capabilities")) {
        const status = typeof unconfigured === "boolean" ? 200 : await unconfigured
        return route.fulfill({ status, json: status === 200
          ? { available: true, sttConfigured: !ttsOnly && unconfigured !== true, supportsStt: true, ttsConfigured: ttsOnly, supportsTts: true,
            desktopVoiceConversationEngine: Boolean(options.engineStatus) }
          : { error: "Capabilities unavailable" } })
      }
      if (url.endsWith("/speech/conversation/engine") && options.engineStatus) {
        return route.fulfill({ status: await options.engineStatus, json: { error: "Engine unavailable" } })
      }
      return route.fulfill({ json: ttsOnly && url.endsWith("/config/server") ? { speech: { playbackMode: "buffered" } } : {} })
    })
    const target = new URL(fixture.url)
    if (native === "wsl") target.searchParams.set("wsl", "1")
    if (pcm) target.searchParams.set("pcm", "1")
    if (locale !== "en") target.searchParams.set("locale", locale)
    if (options.history) target.searchParams.set("history", "")
    if (options.alerts) target.searchParams.set("alerts", "")
    await page.goto(target.toString(), { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => Boolean((window as any).fixture)).catch(error => {
      if (errors.length) throw new AggregateError(errors, errors.map(value => value.message).join("; "))
      throw error
    })
    try {
      await run(page)
    } catch (error) {
      if (errors.length) throw new AggregateError(errors, errors.map(value => value.message).join("; "), { cause: error })
      throw error
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.sends), options.expectedSends ?? [])
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

const field = (page: Page) => page.locator("textarea").first()
const select = (page: Page, start: number, end = start) => field(page).evaluate((el, range) =>
  el.setSelectionRange(...range), [start, end] as [number, number])
const action = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem", { name, exact: true }).click()
}
const dictationMode = (page: Page) => page.getByRole("menuitemcheckbox", { name: "Dictation mode", exact: true })
const mic = (page: Page) => page.locator(".voice-button")
const nativeReads = (page: Page) => page.evaluate(() =>
  (window as any).native.requests.filter(({ action }: any) => action === "read").length)
const waitForNativeRead = (page: Page, previous: number) => page.waitForFunction(count =>
  (window as any).native.requests.filter(({ action }: any) => action === "read").length > count, previous)
const holdMic = async (page: Page) => {
  await page.mouse.up()
  await mic(page).hover()
  await page.mouse.down()
}
const start = async (page: Page) => {
  if (!(await mic(page).count())) {
    await page.getByRole("button", { name: "More actions", exact: true }).click()
    await dictationMode(page).click()
  }
  if (await page.evaluate(() => {
    const { native, __CODENOMAD_WINDOW_CONTEXT__: context } = window as any
    return context === "remote" && native?.choice === "hex"
  })) await mic(page).click()
  else await holdMic(page)
}
const chooseLocalEngine = "Choose an engine in local Preferences → Voice → Dictation."
const stop = async (page: Page) => {
  await page.waitForFunction(() => (window as any).capture.starts === 1)
  await page.mouse.up()
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
}
const finish = async (page: Page, text: string) => {
  await page.evaluate(value => (window as any).capture.requests[0].resolve(value), text)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))))
}

test("dictation mode adds the microphone before More actions without starting capture", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  assert.equal(await mic(page).count(), 0)
  await more.click()
  assert.equal(await dictationMode(page).getAttribute("aria-checked"), "false")
  await dictationMode(page).click()
  await mic(page).waitFor()
  assert.equal(await page.locator(".voice-button + .prompt-actions-menu").count(), 1)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
  await more.click()
  assert.equal(await dictationMode(page).getAttribute("aria-checked"), "true")
  assert.equal(await page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true }).isDisabled(), true)
  await dictationMode(page).click()
  await mic(page).waitFor({ state: "detached" })
}))

test("releasing the microphone before permission resolves does not start a recording later", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).capture.deferPermission = true })
  await start(page)
  await page.waitForFunction(() => (window as any).capture.permit)
  await page.mouse.up()
  await page.evaluate(() => (window as any).capture.permit())
  await page.waitForFunction(() => (window as any).capture.tracksStopped === 1)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
}))

test("Dictate retains keyboard focus and its node when capabilities finish loading", async () => {
  let resolve!: (status: number) => void
  const response = new Promise<number>(done => { resolve = done })
  await withComposer(async page => {
    const more = page.getByRole("button", { name: "More actions", exact: true })
    await more.press("Enter")
    const loading = page.getByRole("menuitemcheckbox", { name: /Dictation mode.*Checking voice settings/ })
    await loading.focus()
    const node = (await loading.elementHandle())!
    assert.equal(await node.evaluate(el => document.activeElement === el), true)
    resolve(200)
    await dictationMode(page).waitFor()
    assert.equal(await node.evaluate(el => el.isConnected && document.activeElement === el), true)
    await page.keyboard.press("Enter")
    await mic(page).focus()
    await page.keyboard.down("Space")
    await page.waitForFunction(() => (window as any).capture.starts === 1)
    await page.keyboard.up("Space")
  }, false, undefined, false, "en", false, response)
})

test("a speech capabilities 503 shows read failure and opens each command's own Voice card", async () => {
  let resolve!: (status: number) => void
  const response = new Promise<number>(done => { resolve = done })
  await withComposer(async page => {
    const more = page.getByRole("button", { name: "More actions", exact: true })
    await more.press("Enter")
    await page.getByRole("menuitemcheckbox", { name: /Conversation mode.*Checking voice settings/ }).waitFor()
    resolve(503)
    const failure = /Couldn’t check voice settings/
    const conversation = page.getByRole("menuitemcheckbox", { name: /^Conversation mode/ }).filter({ hasText: failure })
    const dictate = page.getByRole("menuitemcheckbox", { name: /^Dictation mode/ }).filter({ hasText: failure })
    await dictate.waitFor()
    await conversation.click()
    await page.waitForFunction(() => document.activeElement?.id === "voice-conversation")
    await page.evaluate(() => (window as any).fixture.closeSettings())
    await more.press("Enter")
    await dictate.click()
    await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
    assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
  }, false, undefined, false, "en", false, response)
})

test("a desktop conversation engine read failure opens Conversation and leaves API dictation available", async () => {
  let resolve!: (status: number) => void
  const engineStatus = new Promise<number>(done => { resolve = done })
  await withComposer(async page => {
    await page.getByRole("button", { name: "More actions", exact: true }).press("Enter")
    await page.getByRole("menuitemcheckbox", { name: /Conversation mode.*Checking voice settings/ }).waitFor()
    // The device uses the API path; only the desktop engine preference is unavailable.
    await page.evaluate(() => { (window as any).speechSettings.engine = "api"; window.dispatchEvent(new Event("focus")) })
    resolve(503)
    await dictationMode(page).waitFor()
    await page.getByRole("menuitemcheckbox", { name: /Conversation mode.*Couldn’t check voice settings/ }).click()
    await page.waitForFunction(() => document.activeElement?.id === "voice-conversation")
    await page.getByText("Could not load conversation settings", { exact: true }).waitFor()
  }, false, "hex-setup", false, "en", false, false, { engineStatus })
})

test("dictating into a recalled prompt does not replace the saved draft", () => withComposer(async page => {
  await field(page).fill("Original unsent draft")
  await action(page, "Previous prompt")
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Previously sent")
  await select(page, "Previously ".length, "Previously sent".length)
  await start(page)
  await stop(page)
  await finish(page, "appendix")
  assert.equal(await field(page).inputValue(), "Previously appendix ")
  await page.evaluate(() => (window as any).fixture.setSession("ses_b"))
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "")
  await page.evaluate(() => (window as any).fixture.setSession("ses_a"))
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Original unsent draft")
}, false, undefined, false, "en", false, false, { history: true }))

test("dictation replaces only its original selection and neither sends nor steals focus", () => withComposer(async page => {
  await field(page).fill("before replace after")
  await select(page, 7, 14)
  await start(page)
  await stop(page)
  await page.locator("#elsewhere").focus()
  await finish(page, "transcript")
  assert.equal(await field(page).inputValue(), "before transcript after")
  assert.equal(await field(page).evaluate(el => el.selectionStart), 17)
  assert.equal(await page.evaluate(() => document.activeElement?.id), "elsewhere")
  assert.deepEqual(await page.evaluate(() => {
    const { tracksStopped, requests } = (window as any).capture
    return [tracksStopped, requests.length, requests[0].input.mimeType]
  }), [1, 1, "audio/mp4"])
}))

test("clear then retype the identical draft: only explicit recovery inserts, preserving current text", () => withComposer(async page => {
  await field(page).fill("first")
  await start(page)
  await stop(page)
  await action(page, "Clear prompt text")
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "")
  await field(page).fill("first")
  await finish(page, "transcript")
  assert.equal(await field(page).inputValue(), "first")
  await page.getByRole("button", { name: "Insert transcript" }).click()
  assert.equal(await field(page).inputValue(), "first transcript ")
}))

test("holding the dictation button by touch transcribes on release without focusing the textarea", () => withComposer(async page => {
  const menu = page.getByRole("button", { name: "More actions", exact: true })
  await menu.tap()
  await dictationMode(page).tap()
  const { x, y, width, height } = (await mic(page).boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
  await page.waitForFunction(() => (window as any).capture.starts === 1)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  await finish(page, "texte")
  assert.equal(await field(page).inputValue(), "texte ")
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA")
}, true))

test("a cancelled touch releases the microphone without transcribing", () => withComposer(async page => {
  await page.getByRole("button", { name: "More actions", exact: true }).tap()
  await dictationMode(page).tap()
  const { x, y, width, height } = (await mic(page).boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x + width / 2, y: y + height / 2 }] })
  await page.waitForFunction(() => (window as any).capture.starts === 1)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
  await page.waitForFunction(() => (window as any).capture.tracksStopped === 1)
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
}, true))

test("Dictate waits for the previous transcription to be inserted or discarded", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await stop(page)
  await field(page).fill("updated")
  await finish(page, "saved")
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  await insert.waitFor()
  assert.equal(await mic(page).isDisabled(), true)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 1)
  await insert.click()
  assert.equal(await field(page).inputValue(), "updated saved ")
  await start(page)
  await page.waitForFunction(() => (window as any).capture.starts === 2)
}))

test("an older remote Electron renderer uses the browser lease only when the native lease is absent", async () => {
  await withComposer(async page => {
    await start(page)
    await stop(page)
    await finish(page, "recorded")
    assert.equal(await field(page).inputValue(), "recorded ")
    assert.equal(await page.evaluate(() => (window as any).native.requests.some((request: any) => request.action === "claimMicrophone")), false)
  }, false, "remote-api-legacy")
  await withComposer(async page => {
    await page.evaluate(() => { (window as any).native.denyLease = true })
    await start(page)
    await page.waitForFunction(() => (window as any).native.requests.some((request: any) => request.action === "claimMicrophone"))
    await page.getByRole("dialog").filter({ hasText: "The input test is using the microphone." }).waitFor()
    await page.mouse.up()
    assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
  }, false, "remote-api", false, "en", false, false, { alerts: true })
})

test("MediaRecorder releases its lease before an oversize upload and retains a confirmable excerpt", () => withComposer(async page => {
  await start(page)
  await page.waitForFunction(() => (window as any).capture.starts === 1)
  await page.evaluate(() => {
    const capture = (window as any).capture
    for (let index = 0; index < 8; index++) capture.chunk(100_000)
  })
  const confirm = page.getByRole("button", { name: "Transcribe", exact: true })
  await confirm.waitFor()
  assert.equal(await page.evaluate(() => (window as any).capture.tracksStopped), 1)
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
  assert.equal(await page.evaluate(() => navigator.locks.request("codenomad:microphone", { ifAvailable: true }, lock => !!lock)), true)
  await confirm.press("Enter")
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  const bytes = await page.evaluate(() => new TextEncoder().encode(JSON.stringify((window as any).capture.requests[0].input)).byteLength)
  assert.ok(bytes > 900_000 && bytes < 1024 * 1024)
  await finish(page, "excerpt")
  assert.equal(await field(page).inputValue(), "excerpt ")
  assert.ok(await field(page).evaluate(el => el === document.activeElement))
}))

test("a pending transcript belongs to its session, including after composer remount", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await stop(page)
  await field(page).fill("updated")
  await finish(page, "saved")
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  await insert.waitFor()
  await page.evaluate(() => {
    const fixture = (window as any).fixture
    fixture.setOpen(false)
    fixture.setSession("ses_b")
    fixture.setOpen(true)
  })
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "")
  assert.equal(await insert.count(), 0)
  await page.evaluate(() => (window as any).fixture.setSession("ses_a"))
  await insert.waitFor()
  await insert.click()
  assert.match(await field(page).inputValue(), /saved/)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 1)
}))

test("keyboard insertion of a pending transcript returns focus to the new draft caret", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await stop(page)
  await field(page).fill("left right")
  await finish(page, "saved")
  await select(page, 5)
  await page.getByRole("button", { name: "Insert transcript", exact: true }).press("Enter")
  assert.deepEqual(await field(page).evaluate(element => [element === document.activeElement, element.value, element.selectionStart, element.selectionEnd]),
    [true, "left saved right", 11, 11])
}))

test("discarding a pending transcript returns focus to the draft only from the focused button", () => withComposer(async page => {
  const other = page.getByRole("button", { name: "Other control" })
  const discard = page.getByRole("button", { name: "Discard transcript", exact: true })
  for (const focused of [true, false]) {
    await field(page).fill("original")
    await start(page)
    await page.waitForFunction(expected => (window as any).capture.starts === expected, focused ? 1 : 2)
    await page.mouse.up()
    await page.waitForFunction(expected => (window as any).capture.requests.length === expected, focused ? 1 : 2)
    await field(page).fill("left right")
    await select(page, 5)
    await page.evaluate(() => (window as any).capture.requests.at(-1).resolve("saved"))
    if (focused) await discard.press("Enter")
    else {
      await other.focus()
      await discard.evaluate((button: HTMLButtonElement) => button.click())
    }
    assert.equal(await discard.count(), 0)
    assert.deepEqual(await field(page).evaluate(element => [element.value, element.selectionStart]), ["left right", 5])
    assert.equal(await (focused ? field(page) : other).evaluate(el => el === document.activeElement), true)
  }
}))

test("a pending transcription survives sending the draft and still inserts in the same session", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await stop(page)
  await field(page).fill("send this draft")
  await finish(page, "saved")
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  await insert.waitFor()
  await page.evaluate(() => (window as any).fixture.holdSend())
  await field(page).press("Enter")
  await page.waitForFunction(() => (window as any).fixture.sendHeld())
  assert.equal(await field(page).inputValue(), "")
  await insert.waitFor()
  await page.evaluate(() => (window as any).fixture.releaseSend())
  await insert.click()
  assert.equal(await field(page).inputValue(), "saved ")
}, false, undefined, false, "en", false, false, { expectedSends: ["send this draft"] }))

test("an in-flight transcription finishes after the draft is sent and waits for insertion", () => withComposer(async page => {
  await field(page).fill("send this draft")
  await start(page)
  await stop(page)
  await page.evaluate(() => (window as any).fixture.holdSend())
  await field(page).press("Enter")
  await page.waitForFunction(() => (window as any).fixture.sendHeld())
  assert.equal(await page.evaluate(() => (window as any).capture.requests[0].signal.aborted), false)
  await finish(page, "saved")
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  await insert.waitFor()
  assert.equal(await field(page).inputValue(), "")
  await page.evaluate(() => (window as any).fixture.releaseSend())
  await insert.click()
  assert.equal(await field(page).inputValue(), "saved ")
}, false, undefined, false, "en", false, false, { expectedSends: ["send this draft"] }))

test("dictation preserves the expanded pasted block from a restored queued prompt", () => withComposer(async page => {
  const payload = { text: "Inspect\n\nExpanded pasted block\n", metadata: { displayText: "Inspect" } }
  await page.evaluate(value => (window as any).fixture.restoreQueuedPrompt(value.metadata.displayText, value), payload)
  await select(page, 0, "Inspect".length)
  await start(page)
  await stop(page)
  await finish(page, "Inspect carefully")
  assert.equal(await field(page).inputValue(), "Inspect carefully ")
  await field(page).press("Enter")
  await page.waitForFunction(() => (window as any).fixture.sends.length === 1)
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.resentPayloads), [payload])
}, false, undefined, false, "en", false, false, { expectedSends: ["Inspect carefully"] }))

test("a pending transcript cannot be inserted in shell mode and remains available in normal mode", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await stop(page)
  await field(page).fill("")
  await finish(page, "dictated text")
  const insert = page.getByRole("button", { name: "Insert transcript", exact: true })
  await insert.waitFor()
  await field(page).press("!")
  await page.waitForFunction(() => document.querySelector("textarea")?.classList.contains("shell-mode"))
  assert.equal(await insert.isDisabled(), true)
  await insert.evaluate((button: HTMLButtonElement) => button.click())
  await field(page).press("Enter")
  assert.equal(await field(page).inputValue(), "")
  await field(page).press("Escape")
  await insert.click()
  assert.equal(await field(page).inputValue(), "dictated text ")
}))

test("an Electron engine read failure replaces cached API dictation with the Dictation settings action", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).speechSettings.engine = "api"; window.dispatchEvent(new Event("focus")) })
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await dictationMode(page).click()
  // The fresh read fails at admission while the menu still shows the remembered choice.
  const reads = await nativeReads(page)
  await page.evaluate(() => { (window as any).speechSettings.readFails = true })
  await holdMic(page)
  await waitForNativeRead(page, reads)
  await page.mouse.up()
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitemcheckbox", { name: /Dictation mode.*Could not check the dictation engine/ }).click()
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitemcheckbox", { name: /Dictation mode.*Could not check the dictation engine/ }).click()
  await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
  await page.getByText("Could not check the dictation engine. Check again.", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
}, false, "hex-setup"))

test("a remote engine read failure blocks the cached API choice and opens the Dictation card", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  await more.click()
  await dictationMode(page).click()
  const reads = await nativeReads(page)
  await page.evaluate(() => { (window as any).native.readFails = true })
  await holdMic(page)
  await waitForNativeRead(page, reads)
  await page.mouse.up()
  await more.click()
  await page.getByRole("menuitemcheckbox", { name: /Dictation mode.*Could not check the dictation engine/ }).click()
  await more.click()
  await page.getByRole("menuitemcheckbox", { name: /Dictation mode.*Could not check the dictation engine/ }).click()
  await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
  await page.getByText("Could not check the dictation engine. Check again.", { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
}, false, "remote-api"))

test("moving the selection invalidates insertion even if it returns to the original range", () => withComposer(async page => {
  await field(page).fill("one two")
  await select(page, 0, 3)
  await start(page)
  await stop(page)
  await field(page).evaluate(el => new Promise<void>(resolve => {
    el.addEventListener("selectionchange", () => resolve(), { once: true })
    el.setSelectionRange(4, 7)
  }))
  await select(page, 0, 3)
  await finish(page, "transcript")
  await page.getByRole("button", { name: "Discard transcript" }).click()
  assert.equal(await field(page).inputValue(), "one two")
}))

for (const cancel of ["cancel action", "different session", "same-directory retarget", "unmount"] as const) {
  test(`${cancel} aborts the request and discards a late result`, () => withComposer(async page => {
    await field(page).fill("original")
    await start(page)
    await stop(page)
    if (cancel === "cancel action") await action(page, "Cancel dictation")
    else await page.evaluate(reason => {
      const f = (window as any).fixture
      if (reason === "different session") f.setSession("ses_b")
      if (reason === "same-directory retarget") f.retarget()
      if (reason === "unmount") f.setOpen(false)
    }, cancel)
    assert.equal(await page.evaluate(() => (window as any).capture.requests[0].signal.aborted), true)
    await finish(page, "late")
    if (cancel === "unmount") await page.evaluate(() => (window as any).fixture.setOpen(true))
    assert.equal(await field(page).inputValue(), cancel === "different session" ? "" : "original")
    assert.equal(await page.getByRole("button", { name: "Insert transcript" }).count(), 0)
  }))
}

test("permission granted after the composer closes releases the new stream without recording", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).capture.deferPermission = true })
  await start(page)
  await page.waitForFunction(() => Boolean((window as any).capture.permit))
  await page.evaluate(() => {
    (window as any).fixture.setOpen(false)
  })
  const second = await page.context().newPage()
  try {
    const target = new URL(fixture.url)
    target.searchParams.set("alerts", "1")
    second.setDefaultTimeout(6000)
    await second.goto(target.toString(), { waitUntil: "domcontentloaded" })
    await second.waitForFunction(() => Boolean((window as any).fixture))
    await second.evaluate(() => (window as any).fixture.setNativeSettings(true))
    const testInput = second.getByRole("button", { name: "Test API input", exact: true })
    await testInput.click()
    const denied = second.getByRole("dialog").filter({ hasText: "Dictation is using the microphone." })
    await denied.waitFor()
    assert.equal(await second.evaluate(() => (window as any).capture.starts), 0)
    await page.evaluate(() => (window as any).capture.permit())
    await page.waitForFunction(() => (window as any).capture.tracksStopped === 1)
    await denied.getByRole("button").last().click()
    await testInput.click()
    await second.getByRole("button", { name: "Stop recording", exact: true }).waitFor()
  } finally { await second.close() }
  await page.waitForFunction(() => (window as any).capture.tracksStopped === 1)
  assert.deepEqual(await page.evaluate(() => {
    const { starts, requests } = (window as any).capture
    return [starts, requests.length]
  }), [0, 0])
}))

test("Hex captures on the local host and inserts its transcript into a WSL draft", () => withComposer(async page => {
  await field(page).fill("before replace after")
  await select(page, 7, 14)
  await start(page)
  await page.waitForFunction(() => (window as any).capture.samples > 0)
  assert.equal(await field(page).inputValue(), "before replace after")
  await page.getByRole("button", { name: "Stop recording and transcribe", exact: true }).waitFor()
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "before WSL text after")
  const { native, capture } = await page.evaluate(() => ({ native: (window as any).native.requests, capture: (window as any).capture }))
  const lease = native.find((event: any) => event.action === "claimMicrophone")
  assert.equal(lease.purpose, "dictation")
  assert.deepEqual(native.find((event: any) => event.action === "start"),
    { action: "start", engine: "hex", locale: "en", microphoneLeaseId: lease.id })
  assert.equal(capture.starts, 1)
  assert.deepEqual(capture.requests, [])
}, false, "wsl", true))

test("an unsupported saved engine requires explicit reselection before recording", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  await more.click()
  const dictate = page.locator('[data-action-key="voice"]')
  await dictate.filter({ hasText: chooseLocalEngine }).waitFor()
  await dictate.click()
  const engine = page.getByRole("combobox", { name: "Dictation engine on this device" })
  await engine.waitFor()
  assert.equal(await engine.inputValue(), "")
  assert.equal(await engine.locator("option:checked").isDisabled(), true)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
  assert.deepEqual(await page.evaluate(() => (window as any).native.requests.filter(({ action }: any) => action !== "read")), [])
  await engine.selectOption("api")
  await engine.locator('option[value=""]').waitFor({ state: "detached" })
  assert.equal(await engine.inputValue(), "api")
}, false, "hex-setup", false, "en", false, false, { unsupportedChoice: true }))

test("an older host's unsupported choice opens Dictation settings without capture", () => withComposer(async page => {
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  const dictate = page.getByRole("menuitemcheckbox", { name: /^Dictation mode/ }).filter({ hasText: chooseLocalEngine })
  await dictate.click()
  await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
  await page.getByText(chooseLocalEngine, { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => (window as any).native.requests.some(({ action }: any) => action === "begin")), false)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
}, false, "remote", false, "en", false, false, { unsupportedChoice: true }))

test("Classic conversation is available with playback but without API dictation", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  await more.click()
  await page.getByRole("menuitemcheckbox", { name: "Conversation mode", checked: false }).click()
  await more.click()
  await page.getByRole("menuitemcheckbox", { name: "Conversation mode", checked: true }).waitFor()
  assert.equal(await dictationMode(page).isDisabled(), true)
  assert.equal(await mic(page).count(), 0)
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
}, false, undefined, false, "en", true))

test("a stored live engine retires Classic without falling back on reload", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  const enable = page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true, checked: false })
  const disable = page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true, checked: true })
  await more.click()
  await enable.click()
  await more.click()
  await disable.waitFor()
  await page.evaluate(() => (window as any).fixture.setVoiceConversationEngine("gemini-live"))
  await disable.waitFor({ state: "detached" })
  await page.getByRole("menuitemcheckbox", { name: "Conversation mode — Set up Gemini Live" }).waitFor()

  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => (window as any).fixture?.voiceConversationEngineLoaded())
  await more.click()
  assert.equal(await enable.count(), 0)
  await page.evaluate(() => (window as any).fixture.setVoiceConversationEngine("classic"))
  await enable.waitFor()
}, false, undefined, false, "en", true))

test("both unavailable voice commands are reachable by keyboard and focus their own settings titles", () => withComposer(async page => {
  const more = page.getByRole("button", { name: "More actions", exact: true })
  await more.focus()
  await more.press("Enter")
  const dictate = page.getByRole("menuitemcheckbox", { name: "Dictation mode — Set up dictation" })
  await dictate.waitFor()
  await page.keyboard.press("Home")
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "voice")
  await dictate.press("Enter")
  await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
  await page.evaluate(() => (window as any).fixture.closeSettings())
  await more.focus()
  await more.press("Enter")
  await dictate.waitFor()
  await page.keyboard.press("Home")
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "voice")
  await page.keyboard.press("ArrowDown")
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "conversation")
  await page.getByRole("menuitemcheckbox", { name: "Conversation mode — Set up playback" }).press("Enter")
  await page.waitForFunction(() => document.activeElement?.id === "voice-playback")
  assert.equal(await page.evaluate(() => (window as any).capture.starts), 0)
}, false, undefined, false, "en", false, true))

test("a remote-served draft receives text only, using its original range", () => withComposer(async page => {
  await field(page).fill("before replace after")
  await select(page, 7, 14)
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some((event: any) => event.action === "begin"))
  await page.evaluate(() => (window as any).native.resolve("local text"))
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "before local text after")
  const { native, capture } = await page.evaluate(() => ({ native: (window as any).native.requests, capture: (window as any).capture }))
  assert.deepEqual(Object.keys(native.find((event: any) => event.action === "begin")).sort(), ["action", "id", "locale"])
  assert.equal(capture.starts, 0)
  assert.deepEqual(capture.requests, [])
}, false, "remote-tauri"))

test("a remote-served draft cancels the exact relay on navigation and ignores its late result", () => withComposer(async page => {
  await field(page).fill("original")
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some((event: any) => event.action === "begin"))
  await page.evaluate(() => (window as any).fixture.setSession("ses_b"))
  const cancellation = await page.waitForFunction(() => {
    const { requests } = (window as any).native
    const begin = requests.find((event: any) => event.action === "begin")
    const cancel = requests.find((event: any) => event.action === "cancel")
    return cancel ? [begin.id, cancel.id] : null
  }).then(handle => handle.jsonValue())
  assert.equal(cancellation[0], cancellation[1])
  await page.evaluate(() => (window as any).native.resolve("late"))
  assert.equal(await field(page).inputValue(), "")
  assert.equal(await page.getByRole("button", { name: "Insert transcript" }).count(), 0)
}, false, "remote"))

test("choosing API on a remote desktop keeps the existing manual speech path", () => withComposer(async page => {
  await start(page)
  await stop(page)
  await finish(page, "API text")
  assert.equal(await field(page).inputValue(), "API text ")
  const requests = await page.evaluate(() => (window as any).native.requests)
  assert.ok(requests.length >= 2)
  assert.deepEqual(requests.filter((request: any) => request.action !== "read").map((request: any) => request.action),
    ["claimMicrophone", "releaseMicrophone"])
}, false, "remote-api"))

test("local Tauri dictation claims microphone access and releases the frame on stop", () => withComposer(async page => {
    await start(page)
    await stop(page)
    await finish(page, "API text")
    assert.equal(await field(page).inputValue(), "API text ")
    assert.deepEqual(await page.evaluate(() => {
      const { frames, tracksStopped } = (window as any).capture
      const microphone = (window as any).native.requests.filter((event: any) => /ApiMicrophone/.test(event.action))
      return [frames.map((frame: HTMLIFrameElement) => frame.isConnected), tracksStopped,
        microphone.map((event: any) => event.action), microphone[0]?.id === microphone[1]?.id]
    }), [[false], 1, ["authorizeApiMicrophone", "revokeApiMicrophone"], true])
}, false, "tauri-api"))

test("remote Linux Tauri API prompts again after stop; denial sends no audio", () => withComposer(async page => {
  const attempts = () => page.evaluate(() => (window as any).native.requests.filter((event: any) =>
    ["startApiMicrophone", "finishApiMicrophone", "revokeApiMicrophone"].includes(event.action)))
  await start(page)
  await page.getByRole("button", { name: "Stop recording and transcribe", exact: true }).waitFor()
  await page.mouse.up()
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  const { mimeType, audioBase64 } = await page.evaluate(() => (window as any).capture.requests[0].input)
  assert.equal(mimeType, "audio/wav")
  assert.equal(Buffer.from(audioBase64, "base64").toString("ascii", 0, 4), "RIFF")
  await finish(page, "API text")
  assert.equal(await field(page).inputValue(), "API text ")
  await page.evaluate(() => { (window as any).native.denyMicrophone = true })
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.filter(({ action }: any) => action === "revokeApiMicrophone").length === 2)
  const calls = await attempts()
  assert.deepEqual(calls.map((event: any) => event.action), [
    "startApiMicrophone", "finishApiMicrophone", "revokeApiMicrophone", "startApiMicrophone", "revokeApiMicrophone",
  ])
  assert.equal(calls[0].id, calls[2].id)
  assert.equal(calls[3].id, calls[4].id)
  assert.notEqual(calls[0].id, calls[3].id)
  assert.deepEqual(await page.evaluate(() => {
    const { frames, tracksStopped, starts, requests } = (window as any).capture
    return [frames.length, tracksStopped, starts, requests.length]
  }), [0, 0, 0, 1])
}, false, "tauri-remote-api"))

for (const choice of ["hex", null] as const) {
  test(`remote Linux Tauri tests the API without changing the ${choice ?? "unsupported"} dictation choice`, () => withComposer(async page => {
    await field(page).fill("Original draft")
    await select(page, 0, 8)
    await page.evaluate(engine => {
      const { native, fixture } = window as any
      Object.assign(native, { choice: engine, denyMicrophone: true })
      window.dispatchEvent(new Event("focus"))
      fixture.setNativeSettings(true)
    }, choice)
    const testInput = page.getByRole("button", { name: "Test API input", exact: true })
    await testInput.click()
    await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "revokeApiMicrophone"))
    const attempts = () => page.evaluate(() => (window as any).native.requests.filter(({ action }: any) =>
      ["startApiInputTest", "startApiMicrophone", "finishApiMicrophone", "revokeApiMicrophone"].includes(action)))
    const [denied, released] = await attempts()
    assert.deepEqual(denied, { action: "startApiInputTest", id: denied.id })
    assert.deepEqual(released, { action: "revokeApiMicrophone", id: denied.id })
    assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)

    await page.evaluate(() => {
      Object.assign((window as any).native, { denyMicrophone: false, holdMicrophone: true })
    })
    await testInput.click()
    await page.getByRole("button", { name: "Starting…", exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).native.requests.filter(({ action }: any) => action === "startApiInputTest").length === 2)
    await page.evaluate(() => (window as any).native.admitMicrophone())
    await page.getByRole("button", { name: "Stop recording", exact: true }).click()
    await page.waitForFunction(() => (window as any).capture.requests.length === 1)
    assert.equal(await page.evaluate(() => (window as any).capture.requests[0].input.mimeType), "audio/wav")
    await finish(page, "API test text")
    await page.getByText("API test text", { exact: true }).waitFor()
    assert.equal(await field(page).inputValue(), "Original draft")
    assert.deepEqual(await field(page).evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 8])
    const [, , approved, finished, revoked] = await attempts()
    assert.notEqual(approved.id, denied.id)
    assert.deepEqual(approved, { action: "startApiInputTest", id: approved.id })
    assert.deepEqual(finished, { action: "finishApiMicrophone", id: approved.id })
    assert.deepEqual(revoked, { action: "revokeApiMicrophone", id: approved.id })

    await page.evaluate(() => (window as any).fixture.setNativeSettings(false))
    if (choice === "hex") {
      await start(page)
      await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "begin"))
      await page.evaluate(() => (window as any).native.resolve("Local"))
      await page.waitForFunction(() => document.querySelector("textarea")?.value === "Local draft")
    } else {
      await page.getByRole("button", { name: "More actions", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: /^Dictation mode/ }).filter({ hasText: chooseLocalEngine }).click()
      await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
      assert.equal(await page.evaluate(() => (window as any).native.requests.some(({ action }: any) => action === "begin")), false)
    }
    assert.deepEqual(await attempts(), [denied, released, approved, finished, revoked])
    assert.deepEqual(await page.evaluate(() => {
      const { native, capture } = window as any
      return [native.choice, capture.frames.length, capture.starts, capture.requests.length]
    }), [choice, 0, 0, 1])
  }, false, "tauri-remote-api"))
}

test("remote Linux Tauri API revokes on navigation and ignores a pending consent reply", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).native.holdMicrophone = true })
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "startApiMicrophone"))
  await page.evaluate(() => (window as any).fixture.setSession("ses_b"))
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "revokeApiMicrophone"))
  await page.evaluate(() => (window as any).native.admitMicrophone())
  await page.waitForFunction(() => (window as any).native.requests.filter(({ action }: any) => action === "revokeApiMicrophone").length === 2)
  assert.deepEqual(await page.evaluate(() => {
    const { starts, frames, requests } = (window as any).capture
    const [start, ...revoke] = (window as any).native.requests.filter((event: any) => /ApiMicrophone/.test(event.action))
    return [starts, frames.length, requests.length, revoke.every(event => event.id === start.id)]
  }), [0, 0, 0, true])
}, false, "tauri-remote-api"))

test("remote Linux Tauri API retains the host-bounded excerpt until explicit transcription", () => withComposer(async page => {
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "statusApiMicrophone"))
  const limited = page.getByRole("status").filter({ hasText: "Recording limit reached" })
  const setLimit = async () => {
    await page.evaluate(() => { (window as any).native.microphoneState = "limitReached" })
    await limited.waitFor()
  }
  await setLimit()
  await page.evaluate(() => { (window as any).native.microphoneState = "expired" })
  await limited.waitFor({ state: "hidden" })
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
  await start(page)
  await page.waitForFunction(() => (window as any).native.microphoneState === "recording")
  await setLimit()
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
  await page.getByRole("button", { name: "Transcribe", exact: true }).press("Enter")
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  const other = page.getByRole("button", { name: "Other control" })
  await other.focus()
  await finish(page, "bounded text")
  assert.equal(await field(page).inputValue(), "bounded text ")
  assert.ok(await other.evaluate(el => el === document.activeElement))
}, false, "tauri-remote-api"))

test("remote Linux API input test restores focus after keyboard transcription only if focus stayed unclaimed", () => withComposer(async page => {
  await page.evaluate(() => (window as any).fixture.setNativeSettings(true))
  const startTest = page.getByRole("button", { name: "Test API input", exact: true })
  const stopTest = page.getByRole("button", { name: "Stop recording", exact: true })
  const confirm = page.getByRole("button", { name: "Transcribe", exact: true })
  const other = page.getByRole("button", { name: "Other control" })
  for (const moveFocus of [false, true]) {
    await startTest.press("Enter")
    await stopTest.focus()
    assert.ok(await stopTest.evaluate(el => el === document.activeElement))
    await page.evaluate(() => { (window as any).native.microphoneState = "limitReached" })
    await confirm.waitFor()
    assert.ok(await confirm.evaluate(el => el === document.activeElement))
    await page.keyboard.press("Enter")
    await page.waitForFunction(expected => (window as any).capture.requests.length === expected, moveFocus ? 2 : 1)
    if (moveFocus) await other.focus()
    await page.evaluate(() => (window as any).capture.requests.at(-1).resolve("Keyboard test speech"))
    await page.getByText("Keyboard test speech", { exact: true }).waitFor()
    await startTest.waitFor()
    assert.ok(await (moveFocus ? other : startTest).evaluate(el => el === document.activeElement))
  }
}, false, "tauri-remote-api"))

test("sending a draft preserves the stopped Linux Tauri excerpt until explicit transcription", () => withComposer(async page => {
  await field(page).fill("send only this draft")
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "statusApiMicrophone"))
  await page.evaluate(() => { (window as any).native.microphoneState = "limitReached" })
  const confirm = page.getByRole("button", { name: "Transcribe", exact: true })
  await confirm.waitFor()
  await page.mouse.up()
  const actions = () => page.evaluate(() => (window as any).native.requests.map(({ action }: any) => action) as string[])
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "releaseMicrophone"))
  await page.evaluate(() => (window as any).fixture.holdSend())
  await field(page).press("Enter")
  await page.waitForFunction(() => (window as any).fixture.sendHeld())
  assert.equal(await confirm.isVisible(), true)
  assert.ok(!(await actions()).includes("revokeApiMicrophone"))
  assert.equal(await page.evaluate(() => (window as any).capture.requests.length), 0)
  await page.evaluate(() => (window as any).fixture.releaseSend())
  await confirm.click()
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  await finish(page, "kept excerpt")
  await page.getByRole("button", { name: "Insert transcript", exact: true }).click()
  assert.equal(await field(page).inputValue(), "kept excerpt ")
}, false, "tauri-remote-api", false, "en", false, false, { expectedSends: ["send only this draft"] }))

test("Linux Tauri revokes a late API microphone authorization without starting capture", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).native.holdMicrophone = true })
  await start(page)
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "authorizeApiMicrophone"))
  await page.mouse.up()
  await page.evaluate(() => (window as any).native.admitMicrophone())
  await page.waitForFunction(() => (window as any).native.requests.some(({ action }: any) => action === "revokeApiMicrophone"))
  assert.deepEqual(await page.evaluate(() => {
    const { starts, frames } = (window as any).capture
    const [{ id }, revoke] = (window as any).native.requests.filter((event: any) => /ApiMicrophone/.test(event.action))
    return [starts, frames.length, id === revoke.id]
  }), [0, 0, true])
}, false, "tauri-api"))

test("Linux Tauri Voice preferences tests the manual API with scoped microphone access", () => withComposer(async page => {
  await page.evaluate(() => (window as any).fixture.setNativeSettings(true))
  await page.getByRole("button", { name: "Test API input", exact: true }).click()
  await page.waitForFunction(() => (window as any).capture.samples > 0)
  await page.getByRole("button", { name: "Stop recording", exact: true }).click()
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  await finish(page, "Test speech")
  await page.getByText("Test speech", { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => {
    const { frames, tracksStopped, requests } = (window as any).capture
    const [authorize, revoke] = (window as any).native.requests.filter((event: any) => /ApiMicrophone/.test(event.action))
    return [frames.map((frame: HTMLIFrameElement) => frame.isConnected), tracksStopped, authorize.id === revoke.id, requests[0].input.mimeType]
  }), [[false], 1, true, "audio/wav"])
}, false, "tauri-preferences", true))

test("Linux Tauri without MediaRecorder codecs keeps the API provider path with PCM WAV", () => withComposer(async page => {
  await start(page)
  await page.waitForFunction(() => (window as any).capture.samples > 0)
  await stop(page)
  const [mime, audio] = await page.evaluate(() => {
    const { input } = (window as any).capture.requests[0]
    return [input.mimeType, input.audioBase64]
  })
  assert.equal(mime, "audio/wav")
  assert.equal(Buffer.from(audio, "base64").toString("ascii", 0, 4), "RIFF")
  await finish(page, "API audio")
  assert.equal(await field(page).inputValue(), "API audio ")
}, false, "tauri-api", true))

for (const surface of ["composer", "Voice settings"] as const) {
  test(`${surface}: the WAV limit releases the microphone and waits for a keyboard decision`, () => withComposer(async page => {
    await page.clock.install()
    const inComposer = surface === "composer"
    const draft = "before replace after"
    await field(page).fill(draft)
    await select(page, 7, 14)
    if (!inComposer) await page.evaluate(() => (window as any).fixture.setNativeSettings(true))

    const startCapture = inComposer ? () => start(page)
      : () => page.getByRole("button", { name: "Test API input", exact: true }).click()
    const status = page.getByRole("status").filter({ hasText: "Recording limit reached" })
    const transcribe = page.getByRole("button", { name: "Transcribe", exact: true })
    const cancel = page.getByRole("button", { name: "Cancel", exact: true })
    const other = page.getByRole("button", { name: "Other control" })
    const requests = () => page.evaluate(() => (window as any).capture.requests.length)

    for (const decision of ["cancel", "transcribe"] as const) {
      const before = await page.evaluate(() => (window as any).capture.samples)
      await startCapture()
      await page.waitForFunction(previous => (window as any).capture.samples > previous, before)
      const movesFocus = !inComposer && decision === "transcribe"
      const beforeLimit = movesFocus ? page.getByRole("button", { name: "Stop recording", exact: true }) : other
      await beforeLimit.focus()
      assert.equal(await beforeLimit.evaluate(el => el === document.activeElement), true)
      await page.clock.fastForward(24_000)
      await status.waitFor()
      assert.equal(await (movesFocus ? transcribe : other).evaluate(el => el === document.activeElement), true)
      assert.equal(await field(page).inputValue(), draft)
      assert.deepEqual(await field(page).evaluate(el => [el.selectionStart, el.selectionEnd]), [7, 14])
      assert.deepEqual(await page.evaluate(() => {
        const { frames, starts, tracksStopped, requests } = (window as any).capture
        return [frames.some((frame: HTMLIFrameElement) => frame.isConnected), tracksStopped, starts, requests.length]
      }), [false, decision === "cancel" ? 1 : 2, decision === "cancel" ? 1 : 2, 0])

      if (decision === "cancel") {
        await transcribe.focus()
        await page.keyboard.press("Tab")
        assert.equal(await cancel.evaluate(el => el === document.activeElement), true)
        await page.keyboard.press("Space")
        await status.waitFor({ state: "hidden" })
        const restored = inComposer ? field(page) : page.getByRole("button", { name: "Test API input", exact: true })
        assert.equal(await restored.evaluate(el => el === document.activeElement), true)
        await page.clock.runFor(200)
        assert.equal(await requests(), 0)
        assert.equal(await field(page).inputValue(), draft)
      } else {
        await cancel.focus()
        await page.keyboard.press("Shift+Tab")
        assert.equal(await transcribe.evaluate(el => el === document.activeElement), true)
        if (inComposer) {
          await other.focus()
          await transcribe.evaluate((button: HTMLButtonElement) => button.click())
        } else await page.keyboard.press("Enter")
        await page.waitForFunction(() => (window as any).capture.requests.length === 1)
        const { mimeType, audioBase64 } = await page.evaluate(() => (window as any).capture.requests[0].input)
        const wav = Buffer.from(audioBase64, "base64")
        assert.equal(mimeType, "audio/wav")
        assert.equal(wav.toString("ascii", 0, 4), "RIFF")
        assert.ok(wav.length > 44 && wav.length <= 44 + 24 * 16_000 * 2)
        await finish(page, "confirmed")
        if (inComposer) {
          assert.equal(await field(page).inputValue(), "before confirmed after")
          assert.ok(await other.evaluate(el => el === document.activeElement))
        } else {
          await page.getByText("confirmed", { exact: true }).waitFor()
          assert.equal(await field(page).inputValue(), draft)
        }
        assert.equal(await requests(), 1)
      }
    }
  }, false, surface === "composer" ? "tauri-api" : "tauri-preferences", true))
}

test("a stale API display cannot record after the device choice changes to Hex", () => withComposer(async page => {
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await dictationMode(page).click()
  await page.evaluate(() => { (window as any).native.choice = "hex" })
  await holdMic(page)
  await page.waitForFunction(() => (window as any).native.requests.length >= 2)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  const capture = await page.evaluate(() => (window as any).capture)
  assert.equal(capture.starts, 0)
  assert.equal(capture.requests.length, 0)
}, false, "remote-api"))

test("keyboard activation shows the approved plan, cancels and resumes, and never prepares again on reopen", () => withComposer(async page => {
  const menu = page.getByRole("button", { name: "More actions", exact: true })
  await menu.focus()
  await menu.press("Enter")
  const setup = page.getByRole("menuitemcheckbox", { name: /^Dictation mode/ }).filter({ hasText: chooseLocalEngine })
  await setup.focus()
  await setup.press("Enter")
  const activate = page.getByRole("button", { name: "Activate Hex" })
  const engine = page.getByRole("combobox", { name: "Dictation engine on this device" })
  await activate.waitFor()
  await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
  assert.equal(await engine.inputValue(), "")
  assert.equal(await engine.locator("option[value=hex]").evaluate((node: HTMLOptionElement) => node.disabled), true)
  const describedBy = await activate.getAttribute("aria-describedby")
  const description = await page.evaluate(ids => ids!.split(" ").map(id => document.getElementById(id)?.textContent).join(" "), describedBy)
  assert.match(description, /Download: 5.5 MB.*Hex engine · 0 byte.*Parakeet voice model · 5.5 MB/)
  const mutations = () => page.evaluate(() => (window as any).native.requests.filter((event: any) => event.action !== "read"))
  assert.deepEqual(await mutations(), [])
  assert.deepEqual(await page.evaluate(() => (window as any).speechSettings.opened), ["speech"])

  await activate.focus()
  await activate.press("Enter")
  const progress = page.getByRole("progressbar", { name: "Downloading Hex" })
  await progress.waitFor()
  assert.equal(await progress.getAttribute("value"), "1250000")
  assert.equal(await progress.getAttribute("max"), "5500000")
  assert.equal(await engine.isDisabled(), true)
  const cancel = page.getByRole("button", { name: "Cancel Hex activation" })
  assert.equal(await cancel.evaluate(node => node === document.activeElement), true)
  await cancel.press("Space")
  const resume = page.getByRole("button", { name: "Resume Hex activation" })
  await resume.waitFor()
  await page.getByText("Download: 4.25 MB", { exact: true }).waitFor()
  assert.equal(await engine.inputValue(), "")
  assert.equal(await resume.evaluate(node => node === document.activeElement), true)
  await page.evaluate(() => { (window as any).speechSettings.phase.state = "verifying" })
  await resume.press("Enter")
  await page.getByText("Verifying Hex…", { exact: true }).waitFor()
  await page.evaluate(() => {
    const settings = (window as any).speechSettings
    settings.phase.state = "prepared"
    settings.state = "ready"
    settings.engine = "hex"
  })
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("select")?.value === "hex")
  assert.equal(await engine.evaluate(node => node === document.activeElement), true)
  assert.deepEqual((await mutations()).filter((event: any) => event.action === "prepare"), [
    { action: "prepare", planId: "plan-initial" }, { action: "prepare", planId: "plan-resumable" },
  ])
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.setNativeSettings(false)
    f.setNativeSettings(true)
    window.dispatchEvent(new Event("focus"))
  })
  await engine.waitFor()
  assert.equal(await engine.inputValue(), "hex")
  await menu.click()
  await dictationMode(page).click()
  await holdMic(page)
  await page.waitForFunction(() => (window as any).native.requests.some((event: any) => event.action === "start"))
  const events = await mutations()
  assert.deepEqual(events.find((event: any) => event.action === "start"),
    { action: "start", engine: "hex", locale: "en",
      microphoneLeaseId: events.find((event: any) => event.action === "claimMicrophone").id })
  assert.equal((await mutations()).filter((event: any) => event.action === "prepare").length, 2)
  assert.deepEqual(await page.evaluate(() => [(window as any).capture.starts, (window as any).capture.requests.length]), [0, 0])
}, false, "hex-setup", false, "en", false, false, { unsupportedChoice: true }))

test("Hex activation leaves focus where the user moves it while waiting", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).fixture.setNativeSettings(true) })
  const activate = page.getByRole("button", { name: "Activate Hex" })
  await activate.press("Enter")
  await page.getByRole("progressbar").waitFor()
  const other = page.getByRole("button", { name: "Other control" })
  await other.focus()
  await page.evaluate(() => {
    const settings = (window as any).speechSettings
    settings.phase.state = "prepared"
    settings.state = "ready"
    settings.engine = "hex"
  })
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("select")?.value === "hex")
  assert.equal(await other.evaluate(node => node === document.activeElement), true)
}, false, "hex-setup"))

test("cancelling after Hex has been selected uses the completed receipt even after a not-owned poll", () => withComposer(async page => {
  await page.clock.install()
  await page.evaluate(() => (window as any).fixture.setNativeSettings(true))
  await page.getByRole("button", { name: "Activate Hex" }).click()
  await page.getByRole("progressbar").waitFor()
  await page.locator("button").filter({ hasText: "Cancel Hex activation" }).evaluate((button: HTMLButtonElement) => {
    const settings = (window as any).speechSettings
    settings.holdRead = settings.holdCancelReceipt = true
    settings.phase.state = "prepared"
    settings.state = "ready"
    settings.engine = "hex"
    button.click()
  })
  await page.clock.fastForward(350)
  const commands = () => page.evaluate(() => (window as any).native.requests.map(({ action }: any) => action))
  assert.deepEqual((await commands()).slice(-2), ["cancel", "status"])
  await page.evaluate(() => (window as any).speechSettings.releaseCancelReceipt())
  await page.getByRole("button", { name: "Activate Hex", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Resume Hex activation" }).count(), 0)
  await page.evaluate(() => {
    const settings = (window as any).speechSettings
    settings.holdRead = false
    settings.releaseRead()
  })
  const engine = page.getByRole("combobox", { name: "Dictation engine on this device" })
  await page.waitForFunction(() => document.querySelector("select")?.value === "hex")
  assert.equal(await engine.isEnabled(), true)
}, false, "hex-setup"))

test("Hebrew Hex progress lays out the transferred amount before the total in RTL reading order", () => withComposer(async page => {
  await page.setViewportSize({ width: 440, height: 850 })
  await page.evaluate(() => { (window as any).fixture.setNativeSettings(true) })
  await page.getByRole("button", { name: "הפעלת Hex", exact: true }).press("Enter")
  await page.getByRole("progressbar", { name: "מוריד את Hex" }).waitFor()
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl")
  const label = page.locator("progress + span")
  const [transferred, slash, total] = await label.evaluate(node => {
    const format = new Intl.NumberFormat("he", { style: "unit", unit: "megabyte", maximumFractionDigits: 2 })
    const text = node.firstChild!
    return [format.format(1.25), "/", format.format(5.5)].map(value => {
      const start = text.textContent!.indexOf(value)
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + value.length)
      const { left, right } = range.getBoundingClientRect()
      return { left, right }
    })
  })
  assert.ok(transferred.left >= slash.right && slash.left >= total.right,
    `RTL failed to keep the two amounts on either side of the separator: ${JSON.stringify({ transferred, slash, total })}`)
}, false, "hex-setup", false, "he"))

test("selecting an already prepared Hex engine makes a device choice without preparing", () => withComposer(async page => {
  await page.evaluate(() => {
    const settings = (window as any).speechSettings
    settings.engine = "api"
    settings.state = "ready"
    ;(window as any).fixture.setNativeSettings(true)
  })
  const engine = page.getByRole("combobox", { name: "Dictation engine on this device" })
  await engine.selectOption("hex")
  assert.equal(await engine.inputValue(), "hex")
  assert.equal(await page.getByRole("button", { name: "Activate Hex" }).count(), 0)
  assert.deepEqual(await page.evaluate(() => (window as any).native.requests.filter((event: any) => event.action !== "read")),
    [{ action: "select", engine: "hex" }])
}, false, "hex-setup"))

test("the local Hex selection keeps the transcription test explicitly labelled as API input", () => withComposer(async page => {
  await page.evaluate(() => {
    const { fixture, speechSettings } = window as any
    Object.assign(speechSettings, { engine: "hex", state: "ready" })
    fixture.setNativeSettings(true)
  })
  const engine = page.getByRole("combobox", { name: "Dictation engine on this device" })
  await engine.waitFor()
  assert.equal(await engine.inputValue(), "hex")
  await page.getByRole("button", { name: "Test API input", exact: true }).click()
  await page.getByRole("button", { name: "Stop recording", exact: true }).click()
  await page.waitForFunction(() => (window as any).capture.requests.length === 1)
  await finish(page, "API test only")
  await page.getByText("API test only", { exact: true }).waitFor()
  assert.equal(await engine.inputValue(), "hex")
  assert.equal(await page.evaluate(() => (window as any).native.requests.some(({ action }: any) =>
    action === "start" || action === "select")), false)
}, false, "hex-setup"))

test("a zero-byte plan still requires consent and a failed activation leaves the choice intact", () => withComposer(async page => {
  await page.evaluate(() => {
    (window as any).speechSettings.remaining = 0
    ;(window as any).fixture.setNativeSettings(true)
  })
  const activate = page.getByRole("button", { name: "Activate Hex" })
  await page.getByText(/Download: 0 byte/).waitFor()
  assert.equal(await page.evaluate(() => (window as any).native.requests.some((event: any) => event.action === "prepare")), false)
  await page.evaluate(() => { (window as any).speechSettings.phase.state = "error" })
  await activate.click()
  await page.getByRole("alert").filter({ hasText: "Could not change the dictation engine" }).waitFor()
  assert.equal(await page.getByRole("combobox", { name: "Dictation engine on this device" }).inputValue(), "api")
  assert.equal(await page.getByRole("button", { name: "Resume Hex activation" }).count(), 1)
}, false, "hex-setup"))

test("closing the voice section cancels the exact late-admitted activation", () => withComposer(async page => {
  await page.evaluate(() => {
    (window as any).speechSettings.defer = true
    ;(window as any).fixture.setNativeSettings(true)
  })
  await page.getByRole("button", { name: "Activate Hex" }).click()
  await page.evaluate(() => {
    (window as any).fixture.setNativeSettings(false)
    ;(window as any).speechSettings.acknowledge()
  })
  await page.waitForFunction(() => (window as any).native.requests.some((event: any) =>
    event.action === "cancel" && event.id === "00000000-0000-4000-8000-000000000001"))
  assert.equal(await page.evaluate(() => (window as any).native.requests.some((event: any) => event.action === "status")), false)
}, false, "hex-setup"))

test("a changed plan requires another click on the newly displayed download", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).fixture.setNativeSettings(true) })
  const activate = page.getByRole("button", { name: "Activate Hex" })
  await activate.waitFor()
  await page.evaluate(() => {
    const settings = (window as any).speechSettings
    settings.token = "plan-changed"
    settings.remaining = 7_000_000
  })
  await activate.click()
  await page.getByRole("alert").filter({ hasText: "The components changed" }).waitFor()
  await page.getByText("Download: 7 MB", { exact: true }).waitFor()
  assert.equal(await page.getByRole("combobox", { name: "Dictation engine on this device" }).inputValue(), "api")
  assert.deepEqual(await page.evaluate(() => (window as any).native.requests.filter((event: any) => event.action === "prepare")),
    [{ action: "prepare", planId: "plan-initial" }])
}, false, "hex-setup"))

test("a failed refresh preserves the display without authorizing its stale plan", () => withComposer(async page => {
  await page.evaluate(() => { (window as any).fixture.setNativeSettings(true) })
  const activate = page.getByRole("button", { name: "Activate Hex" })
  await activate.waitFor()
  await page.evaluate(() => {
    ;(window as any).speechSettings.readFails = true
    window.dispatchEvent(new Event("focus"))
  })
  await page.getByRole("alert").filter({ hasText: "Could not check the dictation engine" }).waitFor()
  assert.equal(await activate.isDisabled(), true)
  await activate.focus()
  await activate.press("Enter")
  assert.equal(await page.evaluate(() => (window as any).native.requests.some((event: any) => event.action === "prepare")), false)
  await page.evaluate(() => { (window as any).speechSettings.readFails = false })
  await page.getByRole("button", { name: "Check again" }).click()
  await page.waitForFunction(() => [...document.querySelectorAll("button")]
    .some(button => button.textContent?.includes("Activate Hex") && button.getAttribute("aria-disabled") === "false"))
}, false, "hex-setup"))
