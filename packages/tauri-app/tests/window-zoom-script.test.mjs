// Runs the actual shipped initialization script, not a rewritten input handler.
// No browser, application profile, backend or OpenCode daemon is started.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const shipped = fs.readFileSync(path.join(root, "src-tauri/src/window_zoom.js"), "utf8")
const lock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8")
const version = lock.match(/name = "tauri"\r?\nversion = "([^"]+)"/)[1]
const registry = path.join(process.env.CARGO_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME, ".cargo"), "registry/src")
const pinnedPath = fs.readdirSync(registry).map((entry) => path.join(registry, entry, `tauri-${version}/src/webview/scripts/zoom-hotkey.js`)).find(fs.existsSync)
assert.ok(pinnedPath, `installed pinned Tauri ${version} script is required`)
const pinned = fs.readFileSync(pinnedPath, "utf8")

function harness(platform, { source = shipped, zoom = 1, context = "local", child = false, internals = true, reject = false } = {}) {
  const listeners = new Map()
  const packets = []
  const state = { zoom, minimum: context === "preferences" ? [760, 560] : [Math.ceil(390 * zoom), Math.ceil(600 * zoom)], persisted: zoom, inFlight: 0, maxInFlight: 0 }
  const window = {
    addEventListener(type, handler, options) {
      const list = listeners.get(type) ?? []
      list.push({ handler, options })
      listeners.set(type, list)
    },
  }
  window.top = child ? {} : window
  if (internals) window.__TAURI_INTERNALS__ = {
    async invoke(command, payload) {
      packets.push({ command, ...payload })
      state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight)
      try {
        await new Promise((resolve) => setImmediate(resolve))
        if (reject) throw new Error("no invoke authority")
        if (command === "plugin:webview|set_webview_zoom") {
          // The pinned path changes native zoom, but bypasses native host
          // bookkeeping/constraints (and lacks remote permission).
          if (context === "remote") throw new Error("generic core command denied")
          state.zoom = payload.value
          return
        }
        assert.equal(command, "owned_webview_zoom")
        assert.deepEqual(Object.keys(payload), ["action"])
        const next = payload.action === "reset" ? 1 : state.zoom + (payload.action === "in" ? .2 : -.2)
        state.zoom = Math.round(Math.min(5, Math.max(.25, next)) * 1e6) / 1e6
        state.persisted = state.zoom
        if (context !== "preferences") state.minimum = [Math.ceil(390 * state.zoom), Math.ceil(600 * state.zoom)]
        return state.zoom
      } finally { state.inFlight-- }
    },
  }
  const script = source.replace("__HOST_PLATFORM__", JSON.stringify(platform)).replace("__TEMPLATE_os_name__", JSON.stringify(platform))
  vm.runInNewContext(script, { window, Promise, Number, Math }, { filename: source === shipped ? "window_zoom.js" : `tauri-${version}/zoom-hotkey.js` })
  let clock = 100
  function emit(type, values = {}) {
    const event = { type, isTrusted: true, key: "", ctrlKey: false, metaKey: false, altKey: false, deltaY: 0, clientX: 30, clientY: 50, timeStamp: clock += 20, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopImmediatePropagation() { this.stopped = true }, ...values }
    for (const listener of listeners.get(type) ?? []) { listener.handler(event); if (event.stopped) break }
    return event
  }
  async function flush() {
    for (let count = 0; count < 40; count++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(state.inFlight, 0)
  }
  return { emit, flush, state, packets, listeners, window }
}

for (const platform of ["macos", "linux"]) {
  const modifier = platform === "macos" ? { metaKey: true } : { ctrlKey: true }

  test(`${platform}: pinned ${version} script reproduces stale CSS minimum at 120%`, async () => {
    const h = harness(platform, { source: pinned })
    h.emit("keydown", { key: "+", ...modifier })
    await h.flush()
    assert.equal(h.state.zoom, 1.2)
    assert.deepEqual(h.state.minimum, [390, 600])
    assert.deepEqual(h.state.minimum.map((value) => value / h.state.zoom), [325, 500])
  })

  for (const context of ["local", "remote", "preferences"]) {
    test(`${platform}/${context}: actual owned script starts at restored host zoom and tracks gestures`, async () => {
      const h = harness(platform, { context, zoom: 1.6 })
      const plus = h.emit("keydown", { key: "=", ...modifier })
      assert.ok(plus.defaultPrevented && plus.stopped)
      await h.flush()
      assert.equal(h.state.zoom, 1.8)
      assert.equal(h.state.persisted, 1.8)
      assert.deepEqual(h.state.minimum, context === "preferences" ? [760, 560] : [702, 1080])
      // Native menu changes between gestures must not be overwritten by a JS counter.
      h.state.zoom = 2.5
      h.emit("keydown", { key: "-", ...modifier })
      await h.flush()
      assert.equal(h.state.zoom, 2.3)
      const wheel = h.emit("mousewheel", { ctrlKey: true, deltaY: -120 })
      assert.ok(wheel.defaultPrevented && wheel.stopped)
      await h.flush()
      assert.equal(h.state.zoom, 2.5)
      h.emit("wheel", { ctrlKey: true, deltaY: 120 })
      await h.flush()
      assert.equal(h.state.zoom, 2.3)
      h.emit("keydown", { key: "0", ...modifier })
      await h.flush()
      assert.equal(h.state.zoom, 1)
      assert.deepEqual(h.state.minimum, context === "preferences" ? [760, 560] : [390, 600])
      assert.ok(h.packets.every((p) => p.command === "owned_webview_zoom" && !("label" in p) && !("value" in p)))
    })
  }

  test(`${platform}: standard/legacy paired wheel events mutate once, in either order`, async () => {
    const h = harness(platform)
    for (const [first, second, timeStamp] of [["wheel", "mousewheel", 100], ["mousewheel", "wheel", 200]]) {
      assert.ok(h.emit(first, { ctrlKey: true, deltaY: -120, timeStamp }).defaultPrevented)
      assert.ok(h.emit(second, { ctrlKey: true, deltaY: -100, timeStamp: timeStamp + 1 }).defaultPrevented)
    }
    await h.flush()
    assert.equal(h.packets.length, 2)
    assert.equal(h.state.zoom, 1.4)
    for (const type of ["wheel", "mousewheel"]) assert.equal(h.listeners.get(type)[0].options.passive, false)
  })

  test(`${platform}: rapid input serializes; bounds and native defaults are not doubled`, async () => {
    const h = harness(platform, { zoom: 4.8 })
    for (const key of ["+", "+", "-", "0", "-"]) h.emit("keydown", { key, ...modifier })
    await h.flush()
    assert.equal(h.state.maxInFlight, 1)
    assert.equal(h.state.zoom, .8)
    h.state.zoom = .25
    h.emit("mousewheel", { ctrlKey: true, deltaY: 120 })
    await h.flush()
    assert.equal(h.state.zoom, .25)
  })

  test(`${platform}: unrelated, synthetic and handled input stays untouched`, async () => {
    const h = harness(platform)
    for (const values of [{ key: "+" }, { key: "x", ...modifier }, { key: "+", ...modifier, altKey: true }, { key: "+", ...modifier, isTrusted: false }]) {
      assert.equal(h.emit("keydown", values).defaultPrevented, false)
    }
    assert.equal(h.emit("wheel", { deltaY: -120 }).defaultPrevented, false)
    assert.equal(h.emit("wheel", { ctrlKey: true, deltaY: 0 }).defaultPrevented, false)
    await h.flush()
    assert.equal(h.packets.length, 0)
  })

  test(`${platform}: bootstrap/denied invoke fails closed without replay or generic fallback`, async () => {
    for (const options of [{ internals: false }, { reject: true }]) {
      const h = harness(platform, options)
      assert.ok(h.emit("keydown", { key: "+", ...modifier }).defaultPrevented)
      await h.flush()
      assert.equal(h.state.zoom, 1)
      assert.ok(h.packets.length <= 1)
      assert.ok(h.packets.every((p) => p.command === "owned_webview_zoom"))
    }
    const h = harness(platform, { reject: true })
    h.emit("keydown", { key: "+", ...modifier })
    await h.flush()
    // A later fresh gesture can succeed; the failed mutation is never replayed.
    h.window.__TAURI_INTERNALS__.invoke = async (command, payload) => h.packets.push({ command, ...payload })
    h.emit("keydown", { key: "-", ...modifier })
    await h.flush()
    assert.deepEqual(h.packets.map((p) => p.action), ["in", "out"])
  })
}

test("Windows and preview subframes get no custom input listener", async () => {
  for (const h of [harness("windows"), harness("linux", { child: true }), harness("macos", { child: true })]) {
    assert.equal(h.listeners.size, 0)
    h.emit("keydown", { key: "+", ctrlKey: true, metaKey: true })
    h.emit("mousewheel", { ctrlKey: true, deltaY: -120 })
    await h.flush()
    assert.equal(h.packets.length, 0)
  }
})
