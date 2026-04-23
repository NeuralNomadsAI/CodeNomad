import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { applyConfiguredPorts, readAppConfigFromPaths, resolveConfiguredPortsFromConfig } from "./cli-config"

describe("resolveConfiguredPortsFromConfig", () => {
  it("prefers server port values over preferences", () => {
    const ports = resolveConfiguredPortsFromConfig({
      preferences: {
        httpPort: 3000,
        httpsPort: 3443,
      },
      server: {
        httpPort: 4000,
        httpsPort: 4443,
      },
    })

    assert.deepEqual(ports, [4443, 4000])
  })
})

describe("applyConfiguredPorts", () => {
  it("keeps env vars as the highest-priority override", () => {
    const args = ["serve"]

    applyConfiguredPorts(args, {
      httpsPortEnv: "8443",
      configuredHttpsPort: 4443,
      configuredHttpPort: 4000,
    })

    assert.deepEqual(args, ["serve", "--http-port", "4000"])
  })
})

describe("readAppConfigFromPaths", () => {
  it("reads configured ports from yaml config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-electron-cli-config-"))
    const yamlPath = path.join(dir, "config.yaml")
    const jsonPath = path.join(dir, "config.json")

    try {
      fs.writeFileSync(
        yamlPath,
        "server:\n  httpsPort: 60598\n  httpPort: 60599\npreferences:\n  httpsPort: 7443\n  httpPort: 7000\n",
      )

      const config = readAppConfigFromPaths(yamlPath, jsonPath)
      assert.deepEqual(resolveConfiguredPortsFromConfig(config), [60598, 60599])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
