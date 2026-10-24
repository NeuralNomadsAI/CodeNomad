import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { describeClientOs, readClientOsHints, type ClientNavigator } from "./client-os"

const windows: ClientNavigator = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", userAgentData: { platform: "Windows" } }

describe("describeClientOs", () => {
  it("names the Windows release and combines the hinted architecture with its bitness", () => {
    assert.equal(describeClientOs(windows, { platformVersion: "19.0.0", architecture: "x86", bitness: "64" }), "Windows 11 x64")
    assert.equal(describeClientOs(windows, { platformVersion: "10.0.0", architecture: "x86", bitness: "64" }), "Windows 10 x64")
    assert.equal(describeClientOs(windows, { platformVersion: "15.0.0", architecture: "arm", bitness: "64" }), "Windows 11 arm64")
    assert.equal(describeClientOs(windows, { platformVersion: "0.3.0", architecture: "x86", bitness: "32" }), "Windows x86")
  })

  it("keeps the macOS version and omits unknown Linux versions", () => {
    const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", userAgentData: { platform: "macOS" } }
    assert.equal(describeClientOs(mac, { platformVersion: "15.1.0", architecture: "arm", bitness: "64" }), "macOS 15.1 arm64")
    assert.equal(describeClientOs(mac, { platformVersion: "14.0.0", architecture: "x86", bitness: "64" }), "macOS 14 x64")
    const linux = { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", userAgentData: { platform: "Linux" } }
    assert.equal(describeClientOs(linux, { platformVersion: "", architecture: "x86", bitness: "64" }), "Linux x64")
  })

  it("falls back to the platform and user-agent architecture without client hints", () => {
    assert.equal(describeClientOs(windows, null), "Windows x64")
    assert.equal(describeClientOs({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }, null), "Linux x86_64")
    assert.equal(describeClientOs({ platform: "MacIntel", userAgent: "Safari" }, null), "MacIntel")
    assert.equal(describeClientOs({ userAgent: "" }, null), "Unknown")
  })

  it("treats missing or failing client hints as absent", async () => {
    assert.equal(await readClientOsHints({ userAgentData: { platform: "Windows" } }), null)
    assert.equal(await readClientOsHints({ userAgentData: { getHighEntropyValues: async () => { throw new Error("denied") } } }), null)
    assert.deepEqual(await readClientOsHints({ userAgentData: { getHighEntropyValues: async (hints) => ({ requested: hints.join(",") }) } }),
      { requested: "platformVersion,architecture,bitness" })
  })
})
