import assert from "node:assert/strict"
import type { Page } from "playwright"

// Disable just the extension's root-attribute observation before mounting it:
// theme revisions must also refresh consumers when no DOM mutation occurs.
export async function ignoreExtensionPaletteObserver(page: Page) {
  await page.evaluate(() => {
    const observe = MutationObserver.prototype.observe
    MutationObserver.prototype.observe = function (target, options) {
      if (target === document.documentElement && options?.attributeFilter?.includes("data-color-scheme")) return
      return observe.call(this, target, options)
    }
  })
}

export async function checkExtensionTheme(page: Page, fixture: "extensionFixture" | "fixture") {
  const iframe = (await page.locator("iframe[title='Session example']").elementHandle())!
  const frame = (await iframe.contentFrame())!
  const set = (method: "theme" | "contrast", value: string) =>
    page.evaluate(([fixture, method, value]) => (window as any)[fixture][method](value), [fixture, method, value])
  const state = (key: "contrast" | "forced" | "dark", value: boolean) =>
    page.waitForFunction(([fixture, key, value]) => (window as any)[fixture].themeState()[key] === value, [fixture, key, value] as const)
  const expected = () => page.evaluate(() => {
    const probe = document.createElement("span"), canvas = document.createElement("canvas")
    probe.style.forcedColorAdjust = "none"
    document.body.append(probe)
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const forced = matchMedia("(forced-colors: active)").matches
    try {
      return Object.fromEntries(Object.entries({
        background: "--surface-secondary", surface: "--surface-canvas", text: "--text-primary",
        muted: "--text-muted", border: "--border-base", focus: "--focus-ring-color",
      }).map(([key, token]) => {
        probe.style.color = forced ? ["background", "surface"].includes(key) ? "Canvas" : "CanvasText" : `var(${token})`
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = getComputedStyle(probe).color
        context.fillRect(0, 0, 1, 1)
        return [key, "#" + Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), n => n.toString(16).padStart(2, "0")).join("")]
      }))
    } finally { probe.remove() }
  })
  const check = async () => {
    const colors = await expected()
    await frame.waitForFunction(colors => JSON.stringify((window as any).codenomad.getContext()?.colors) === JSON.stringify(colors), colors)
    assert.equal(await iframe.evaluate(element => element.isConnected && element === document.querySelector("iframe")), true, "Theme changes retain the same iframe")
    for (const color of Object.values(colors)) assert.match(color, /^#[\da-f]{6}$/)
    return colors
  }
  for (const appearance of ["light", "dark"]) {
    await set("theme", appearance)
    // The theme action queues persistence and returns before its rendering settles.
    await state("dark", appearance === "dark")
    await set("contrast", "off")
    const normal = await check()
    await set("contrast", "on")
    const contrasted = await check()
    assert.notDeepEqual(contrasted, normal, `${appearance}: effective contrast colors reach the frame`)
    assert.equal(contrasted.focus, normal.focus, "Contrast retains the normal focus color")
    await set("contrast", "off")
    assert.deepEqual(await check(), normal, "Off restores all six normal colors")
    await set("contrast", "auto")
    await page.emulateMedia({ contrast: "more" })
    await state("contrast", true)
    assert.deepEqual(await check(), contrasted, "Auto follows system contrast")
    await page.emulateMedia({ contrast: "no-preference" })
    await state("contrast", false)
    assert.deepEqual(await check(), normal)
  }
  await set("theme", "system")
  let light: Record<string, string> | undefined
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ forcedColors: "active", colorScheme })
    await state("forced", true)
    await state("dark", colorScheme === "dark")
    const colors = await check()
    if (colorScheme === "light") light = colors
    else assert.notDeepEqual(colors, light, "Forced system colors follow light/dark changes")
    assert.equal(colors.surface, colors.background)
    for (const key of ["muted", "border", "focus"]) assert.equal(colors[key], colors.text)
  }
  await page.emulateMedia({ forcedColors: "none" })
  await state("forced", false)
  await check()
}
