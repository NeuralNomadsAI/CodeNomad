import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PreviewSettings } from "../../../server/src/api-types"
import {
  getBrowserFramePolicy,
  getPreviewFrameSource,
  getPreviewMessageOrigin,
  isCapabilityPreviewFrame,
  isLoopbackHttpUrl,
  isLoopbackPreviewUrl,
  isTrustedPreviewSameOrigin,
  normalizeBrowserPreviewUrl,
  previewAllowAttribute,
  previewSandboxFlags,
} from "./browser-frame-security.ts"

function previewSettings(overrides: Partial<PreviewSettings> = {}): PreviewSettings {
  return {
    originMode: "opaque",
    customOrigin: "",
    sandbox: { forms: true, modals: true, popups: true, downloads: true },
    features: {
      camera: false,
      microphone: false,
      clipboardRead: false,
      clipboardWrite: false,
      geolocation: false,
      notifications: false,
      fullscreen: false,
    },
    ...overrides,
  }
}

const preview = {
  token: "12345678-1234-1234-1234-123456789abc",
  targetUrl: "http://localhost:3000/app?q=1#hash",
  proxyUrl: "/previews/token/app",
}

const capabilityFrame = "http://12345678-1234-1234-1234-123456789abc.preview.localhost:9899/app?q=1#hash"

describe("getBrowserFramePolicy", () => {
  it("isolates local native frames from the parent bridge", () => {
    for (const host of ["electron", "tauri"] as const) {
      const policy = getBrowserFramePolicy({ host, windowContext: "local" })
      const permissions = new Set(policy.sandbox?.split(" "))

      assert.deepEqual(permissions, new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads"]))
      assert.equal(permissions.has("allow-same-origin"), false)
      assert.equal([...permissions].some((permission) => permission.startsWith("allow-top-navigation")), false)
      assert.equal(policy.canInspectDom, false)
    }
  })

  it("isolates browser-hosted frames from the authenticated parent", () => {
    assert.deepEqual(getBrowserFramePolicy({ host: "web", windowContext: "remote" }), {
      sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-downloads",
      canInspectDom: false,
    })
  })

  it("keeps app-proxied SideCar frames same-origin so their requests carry the session cookie", () => {
    for (const host of ["web", "electron", "tauri"] as const) {
      const policy = getBrowserFramePolicy({ host, windowContext: "local" }, { trustedSameOrigin: true })
      const permissions = new Set(policy.sandbox?.split(" "))

      assert.deepEqual(
        permissions,
        new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-same-origin"]),
      )
      assert.equal(policy.canInspectDom, false)
    }
  })

  it("uses caller-provided sandbox flags", () => {
    assert.deepEqual(
      getBrowserFramePolicy({ host: "web", windowContext: "remote" }, { sandboxFlags: "allow-scripts allow-forms" }),
      { sandbox: "allow-scripts allow-forms", canInspectDom: false },
    )
    assert.deepEqual(
      getBrowserFramePolicy({ host: "web", windowContext: "remote" }, { sandboxFlags: "allow-scripts", trustedSameOrigin: true }),
      { sandbox: "allow-scripts allow-same-origin", canInspectDom: false },
    )
  })

  it("uses a token-scoped localhost origin for native previews", () => {
    assert.equal(
      getPreviewFrameSource(
        { host: "tauri", windowContext: "local" },
        preview,
        "http://127.0.0.1:9899/",
        previewSettings(),
      ),
      capabilityFrame,
    )
    assert.equal(
      getPreviewFrameSource({ host: "web", windowContext: "remote" }, preview, "https://app.example/", previewSettings()),
      preview.proxyUrl,
    )
    assert.equal(
      getPreviewFrameSource({ host: "tauri", windowContext: "local" }, preview, "https://localhost:9898/", previewSettings()),
      preview.proxyUrl,
    )
    assert.equal(
      getPreviewFrameSource({ host: "tauri", windowContext: "local" }, preview, "http://192.168.1.10:9899/", previewSettings()),
      preview.proxyUrl,
    )
  })
})

describe("previewSandboxFlags", () => {
  it("serializes the configured sandbox capabilities after scripts", () => {
    assert.equal(
      previewSandboxFlags({ forms: true, modals: true, popups: true, downloads: true }),
      "allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    )
    assert.equal(
      previewSandboxFlags({ forms: false, modals: true, popups: false, downloads: false }),
      "allow-scripts allow-modals",
    )
  })
})

describe("previewAllowAttribute", () => {
  it("serializes disabled features as an explicit none", () => {
    assert.equal(
      previewAllowAttribute({
        camera: false,
        microphone: false,
        clipboardRead: false,
        clipboardWrite: false,
        geolocation: false,
        notifications: false,
        fullscreen: false,
      }),
      "camera 'none'; microphone 'none'; clipboard-read 'none'; clipboard-write 'none'; geolocation 'none'; notifications 'none'; fullscreen 'none'",
    )
  })

  it("delegates enabled features by name", () => {
    assert.equal(
      previewAllowAttribute({
        camera: true,
        microphone: false,
        clipboardRead: true,
        clipboardWrite: false,
        geolocation: true,
        notifications: false,
        fullscreen: true,
      }),
      "camera; microphone 'none'; clipboard-read; clipboard-write 'none'; geolocation; notifications 'none'; fullscreen",
    )
  })
})

describe("getPreviewFrameSource", () => {
  it("uses the app path for opaque and app modes", () => {
    for (const originMode of ["opaque", "app"] as const) {
      assert.equal(
        getPreviewFrameSource(
          { host: "web", windowContext: "remote" },
          preview,
          "https://app.example/",
          previewSettings({ originMode, customOrigin: "https://preview.example.com" }),
        ),
        preview.proxyUrl,
      )
    }
  })

  it("uses the configured custom origin for custom mode", () => {
    assert.equal(
      getPreviewFrameSource(
        { host: "web", windowContext: "remote" },
        preview,
        "https://app.example/",
        previewSettings({ originMode: "custom", customOrigin: "https://preview.example.com" }),
      ),
      `https://preview.example.com${preview.proxyUrl}`,
    )
  })

  it("keeps the desktop capability host ahead of the origin mode", () => {
    assert.equal(
      getPreviewFrameSource(
        { host: "electron", windowContext: "local" },
        preview,
        "http://127.0.0.1:9899/",
        previewSettings({ originMode: "custom", customOrigin: "https://preview.example.com" }),
      ),
      capabilityFrame,
    )
  })
})

describe("isCapabilityPreviewFrame", () => {
  it("recognizes the desktop capability host", () => {
    for (const host of ["electron", "tauri"] as const) {
      assert.equal(isCapabilityPreviewFrame({ host, windowContext: "local" }, capabilityFrame), true)
    }
  })

  it("rejects capability frames outside the local desktop host", () => {
    assert.equal(isCapabilityPreviewFrame({ host: "web", windowContext: "remote" }, capabilityFrame), false)
    assert.equal(isCapabilityPreviewFrame({ host: "tauri", windowContext: "remote" }, capabilityFrame), false)
  })

  it("rejects app and custom path frames", () => {
    assert.equal(isCapabilityPreviewFrame({ host: "tauri", windowContext: "local" }, "/previews/token/app"), false)
    assert.equal(
      isCapabilityPreviewFrame({ host: "tauri", windowContext: "local" }, "http://127.0.0.1:9899/previews/token/app"),
      false,
    )
    assert.equal(
      isCapabilityPreviewFrame({ host: "tauri", windowContext: "local" }, "https://preview.example.com/previews/token/app"),
      false,
    )
  })
})

describe("isTrustedPreviewSameOrigin", () => {
  it("never trusts opaque previews", () => {
    assert.equal(isTrustedPreviewSameOrigin("http://localhost:3000/app", previewSettings()), false)
  })

  it("trusts loopback targets in app and custom modes", () => {
    for (const originMode of ["app", "custom"] as const) {
      assert.equal(
        isTrustedPreviewSameOrigin(
          "http://127.0.0.1:3000/app",
          previewSettings({ originMode, customOrigin: "https://preview.example.com" }),
        ),
        true,
      )
    }
  })

  it("does not trust external targets", () => {
    for (const originMode of ["app", "custom"] as const) {
      assert.equal(
        isTrustedPreviewSameOrigin(
          "https://example.com/",
          previewSettings({ originMode, customOrigin: "https://preview.example.com" }),
        ),
        false,
      )
    }
  })

  it("does not trust custom mode without a custom origin", () => {
    assert.equal(isTrustedPreviewSameOrigin("http://localhost:3000/app", previewSettings({ originMode: "custom" })), false)
  })
})

describe("getPreviewMessageOrigin", () => {
  it("expects an opaque origin for opaque previews", () => {
    assert.equal(
      getPreviewMessageOrigin(
        { host: "web", windowContext: "remote" },
        preview.proxyUrl,
        preview.targetUrl,
        previewSettings(),
        "https://app.example",
      ),
      "null",
    )
  })

  it("expects the parent origin for app mode", () => {
    assert.equal(
      getPreviewMessageOrigin(
        { host: "web", windowContext: "remote" },
        preview.proxyUrl,
        preview.targetUrl,
        previewSettings({ originMode: "app" }),
        "https://app.example",
      ),
      "https://app.example",
    )
  })

  it("expects the custom origin for custom mode", () => {
    assert.equal(
      getPreviewMessageOrigin(
        { host: "web", windowContext: "remote" },
        `/previews/${preview.token}/app`,
        preview.targetUrl,
        previewSettings({ originMode: "custom", customOrigin: "https://preview.example.com" }),
        "https://app.example",
      ),
      "https://preview.example.com",
    )
  })

  it("expects an opaque origin for external targets", () => {
    for (const originMode of ["app", "custom"] as const) {
      assert.equal(
        getPreviewMessageOrigin(
          { host: "web", windowContext: "remote" },
          preview.proxyUrl,
          "https://example.com/",
          previewSettings({ originMode, customOrigin: "https://preview.example.com" }),
          "https://app.example",
        ),
        "null",
      )
    }
  })

  it("expects the capability origin for desktop capability frames", () => {
    assert.equal(
      getPreviewMessageOrigin(
        { host: "tauri", windowContext: "local" },
        capabilityFrame,
        preview.targetUrl,
        previewSettings(),
        "http://127.0.0.1:9899",
      ),
      "http://12345678-1234-1234-1234-123456789abc.preview.localhost:9899",
    )
  })
})

describe("isLoopbackPreviewUrl", () => {
  it("separates local previews from public browser pages", () => {
    assert.equal(isLoopbackPreviewUrl("http://localhost:3000/app"), true)
    assert.equal(isLoopbackPreviewUrl("localhost:5173"), true)
    assert.equal(isLoopbackPreviewUrl("http://127.0.0.8:5173/"), true)
    assert.equal(isLoopbackPreviewUrl("127.0.0.1:5173/app"), true)
    assert.equal(isLoopbackPreviewUrl("[::1]:4173"), true)
    assert.equal(isLoopbackPreviewUrl("http://127.evil.com"), false)
    assert.equal(isLoopbackPreviewUrl("https://github.com/"), false)
  })
})

describe("isLoopbackHttpUrl", () => {
  it("accepts only explicit http(s) URLs whose host is loopback", () => {
    assert.equal(isLoopbackHttpUrl("http://localhost:3000/app"), true)
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:8080"), true)
    assert.equal(isLoopbackHttpUrl("http://127.1.2.3:80/"), true)
    assert.equal(isLoopbackHttpUrl("https://localhost/"), true)
    assert.equal(isLoopbackHttpUrl("http://[::1]:5173/"), true)
    assert.equal(isLoopbackHttpUrl("http://0.0.0.0:3000/"), true)
    assert.equal(isLoopbackHttpUrl("https://example.com/"), false)
    assert.equal(isLoopbackHttpUrl("localhost:3000"), false)
    assert.equal(isLoopbackHttpUrl("/relative"), false)
    assert.equal(isLoopbackHttpUrl("#anchor"), false)
    assert.equal(isLoopbackHttpUrl("mailto:a@b.c"), false)
    assert.equal(isLoopbackHttpUrl("http://192.168.1.5:3000/"), false)
    assert.equal(isLoopbackHttpUrl("http://127.evil.com"), false)
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1.example.com"), false)
    assert.equal(isLoopbackHttpUrl(""), false)
  })
})

describe("normalizeBrowserPreviewUrl", () => {
  it("defaults public hosts to HTTPS and loopback hosts to HTTP", () => {
    assert.equal(normalizeBrowserPreviewUrl("github.com"), "https://github.com/")
    assert.equal(normalizeBrowserPreviewUrl("localhost:5173/app"), "http://localhost:5173/app")
    assert.throws(() => normalizeBrowserPreviewUrl("file:///tmp/index.html"))
    assert.throws(() => normalizeBrowserPreviewUrl("https://user:pass@example.com"))
  })
})
