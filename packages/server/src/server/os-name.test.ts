import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { describeOperatingSystem } from "./os-name"

describe("describeOperatingSystem", () => {
  it("uses the Windows product name, so Server and editions keep their real name", () => {
    assert.equal(describeOperatingSystem({ platform: "win32", release: "10.0.26200", version: "Windows 11 Pro" }), "Windows 11 Pro (10.0.26200)")
    assert.equal(describeOperatingSystem({ platform: "win32", release: "10.0.20348", version: "Windows Server 2022 Datacenter" }),
      "Windows Server 2022 Datacenter (10.0.20348)")
  })

  it("falls back to the build number, since Windows 11 kept the 10.0 kernel version", () => {
    assert.equal(describeOperatingSystem({ platform: "win32", release: "10.0.22000" }), "Windows 11 (10.0.22000)")
    assert.equal(describeOperatingSystem({ platform: "win32", release: "10.0.19045" }), "Windows 10 (10.0.19045)")
    assert.equal(describeOperatingSystem({ platform: "win32", release: "6.3.9600" }), "Windows (6.3.9600)")
  })

  it("maps Darwin to the macOS release, including the jump to 26", () => {
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "25.0.0" }), "macOS 26")
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "25.1.0" }), "macOS 26.1")
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "24.1.0" }), "macOS 15.1")
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "23.0.0" }), "macOS 14")
    // Ventura 13.0 is Darwin 22.1: the minor does not track before Darwin 23.
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "22.1.0" }), "macOS 13")
    assert.equal(describeOperatingSystem({ platform: "darwin", release: "19.6.0" }), "macOS (Darwin 19.6.0)")
  })

  it("uses the Linux distribution name, else the kernel release", () => {
    const osRelease = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n'
    assert.equal(describeOperatingSystem({ platform: "linux", release: "6.8.0-45-generic", readOsRelease: () => osRelease }), "Ubuntu 24.04.1 LTS")
    assert.equal(describeOperatingSystem({ platform: "linux", release: "6.8.0", readOsRelease: () => "PRETTY_NAME=Arch Linux\n" }), "Arch Linux")
    assert.equal(describeOperatingSystem({ platform: "linux", release: "6.8.0", readOsRelease: () => { throw new Error("ENOENT") } }), "Linux 6.8.0")
    assert.equal(describeOperatingSystem({ platform: "freebsd", release: "14.1" }), undefined)
  })
})
