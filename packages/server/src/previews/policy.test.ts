import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_PREVIEW_SETTINGS,
  isLoopbackHostname,
  normalizePreviewSettings,
  previewDocumentSandbox,
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
})
