import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_PREVIEW_SETTINGS,
  isLoopbackHostname,
  normalizePreviewSettings,
  previewDocumentSandbox,
  previewDocumentSandboxForTarget,
  resolvePreviewSettings,
} from "./policy"

describe("preview policy", () => {
  it("accepts only literal loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "[::1]"]) {
      assert.equal(isLoopbackHostname(host), true, host)
    }
    for (const host of ["127.evil.com", "127.0.0.1.example.com", "sub.localhost", "localhost.evil.com", "192.168.1.5"]) {
      assert.equal(isLoopbackHostname(host), false, host)
    }
  })

  it("defaults to opaque and preserves configured values", () => {
    assert.deepEqual(normalizePreviewSettings(undefined), DEFAULT_PREVIEW_SETTINGS)
    assert.deepEqual(normalizePreviewSettings({
      originMode: "custom",
      customOrigin: "https://preview.example.com",
      sandbox: { forms: false },
      features: { camera: true },
    }), {
      ...DEFAULT_PREVIEW_SETTINGS,
      originMode: "custom",
      customOrigin: "https://preview.example.com",
      sandbox: { ...DEFAULT_PREVIEW_SETTINGS.sandbox, forms: false },
      features: { ...DEFAULT_PREVIEW_SETTINGS.features, camera: true },
    })
  })

  it("rejects non-origin custom values and unknown modes", () => {
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://preview.example.com/path" }).customOrigin, "")
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://user:pass@preview.example.com" }).customOrigin, "")
    assert.equal(normalizePreviewSettings({ originMode: "unknown" }).originMode, "opaque")
    assert.equal(normalizePreviewSettings({ originMode: "custom", customOrigin: "https://preview.example.com/" }).customOrigin, "https://preview.example.com")
  })

  it("builds sandbox flags from the configured capabilities", () => {
    assert.equal(previewDocumentSandbox(false, { forms: false, modals: true, popups: false, downloads: true }),
      "sandbox allow-scripts allow-modals allow-downloads")
    assert.equal(previewDocumentSandbox(true, { forms: false, modals: true, popups: false, downloads: true }),
      "sandbox allow-scripts allow-modals allow-downloads allow-same-origin")
  })

  it("never trusts an app origin as a custom origin", () => {
    assert.equal(resolvePreviewSettings(
      { originMode: "custom", customOrigin: "https://app.example.com" },
      ["https://app.example.com"],
    ).originMode, "opaque")
    assert.equal(resolvePreviewSettings(
      { originMode: "custom", customOrigin: "https://preview.example.com" },
      ["https://app.example.com"],
    ).originMode, "custom")
    assert.equal(resolvePreviewSettings(
      { originMode: "custom", customOrigin: "https://app.example.com:8443" },
      ["https://app.example.com"],
    ).originMode, "opaque")
  })

  it("degrades an unusable custom mode to the opaque default", () => {
    assert.deepEqual(
      resolvePreviewSettings({ originMode: "custom", customOrigin: "" }, ["https://app.example.com"]),
      DEFAULT_PREVIEW_SETTINGS,
    )
    assert.deepEqual(
      resolvePreviewSettings(
        { originMode: "custom", customOrigin: "https://preview.example.com/path", sandbox: { forms: false } },
        [],
      ),
      DEFAULT_PREVIEW_SETTINGS,
    )
    assert.deepEqual(
      resolvePreviewSettings({ originMode: "custom", customOrigin: "https://app.example.com" }, ["https://app.example.com"]),
      DEFAULT_PREVIEW_SETTINGS,
    )
  })

  it("uses the request host for custom-origin trust", () => {
    const settings = resolvePreviewSettings(
      { originMode: "custom", customOrigin: "https://preview.example.com" },
      ["https://app.example.com"],
    )
    assert.match(previewDocumentSandboxForTarget("http://127.0.0.1:3000/", settings, "preview.example.com"), /allow-same-origin/)
    assert.doesNotMatch(previewDocumentSandboxForTarget("http://127.0.0.1:3000/", settings, "app.example.com"), /allow-same-origin/)
    assert.doesNotMatch(previewDocumentSandboxForTarget("https://example.com/", settings, "preview.example.com"), /allow-same-origin/)
  })

  it("keeps opaque mode independent of the target and host", () => {
    assert.doesNotMatch(previewDocumentSandboxForTarget("http://localhost:3000/", DEFAULT_PREVIEW_SETTINGS, "localhost"), /allow-same-origin/)
    assert.doesNotMatch(previewDocumentSandboxForTarget("https://example.com/", DEFAULT_PREVIEW_SETTINGS, "localhost"), /allow-same-origin/)
  })
})
