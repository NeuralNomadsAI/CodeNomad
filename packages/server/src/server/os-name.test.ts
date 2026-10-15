import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { describeOperatingSystem } from "./os-name"

describe("describeOperatingSystem", () => {
  it("names Windows 11 by build number, since it kept the 10.0 kernel version", () => {
    assert.equal(describeOperatingSystem("win32", "10.0.26200"), "Windows 11 (10.0.26200)")
    assert.equal(describeOperatingSystem("win32", "10.0.22000"), "Windows 11 (10.0.22000)")
    assert.equal(describeOperatingSystem("win32", "10.0.19045"), "Windows 10 (10.0.19045)")
    assert.equal(describeOperatingSystem("win32", "6.3.9600"), "Windows (6.3.9600)")
  })

  it("maps Darwin to the macOS release", () => {
    assert.equal(describeOperatingSystem("darwin", "24.1.0"), "macOS 15.1")
    assert.equal(describeOperatingSystem("darwin", "23.0.0"), "macOS 14")
    assert.equal(describeOperatingSystem("darwin", "19.6.0"), "macOS (Darwin 19.6.0)")
  })

  it("uses the Linux distribution name, else the kernel release", () => {
    const osRelease = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n'
    assert.equal(describeOperatingSystem("linux", "6.8.0-45-generic", () => osRelease), "Ubuntu 24.04.1 LTS")
    assert.equal(describeOperatingSystem("linux", "6.8.0", () => "PRETTY_NAME=Arch Linux\n"), "Arch Linux")
    assert.equal(describeOperatingSystem("linux", "6.8.0", () => { throw new Error("ENOENT") }), "Linux 6.8.0")
    assert.equal(describeOperatingSystem("freebsd", "14.1"), undefined)
  })
})
