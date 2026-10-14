import assert from "node:assert/strict"
import { afterEach, beforeEach, it } from "node:test"
import { InvalidArgumentError } from "commander"
import { parseBooleanSwitchEnv, parseCliOptions } from "./index"

const switches = [
  ["CODENOMAD_SKIP_AUTH", "--dangerously-skip-auth", "dangerouslySkipAuth"],
  ["CODENOMAD_GENERATE_TOKEN", "--generate-token", "generateToken"],
  ["CLI_UNRESTRICTED_ROOT", "--unrestricted-root", "unrestrictedRoot"],
  ["CLI_UI_NO_UPDATE", "--ui-no-update", "uiNoUpdate"],
  ["CLI_LAUNCH", "--launch", "launch"],
] as const
const values = [
  [undefined, false], ["false", false], ["0", false], ["", false], [" \t ", false],
  ["no", false], [" OFF ", false], ["1", true], [" TRUE ", true], ["yes", true], ["on", true],
] as const
let originalEnv: NodeJS.ProcessEnv
beforeEach(() => {
  originalEnv = process.env
  process.env = { ...originalEnv }
  for (const [name] of switches) delete process.env[name]
})
afterEach(() => { process.env = originalEnv })

for (const [value, expected] of values) {
  it(`strict helper parses ${JSON.stringify(value)} as ${expected}`, () => {
    assert.equal(parseBooleanSwitchEnv("FIXTURE_BOOLEAN", value), expected)
  })
}
it("strict helper rejects unknown values with the variable and accepted values", () => {
  for (const value of ["flase", "y", "2"]) {
    assert.throws(() => parseBooleanSwitchEnv("FIXTURE_BOOLEAN", value), (error: unknown) => {
      assert.ok(error instanceof InvalidArgumentError)
      assert.match(error.message, /FIXTURE_BOOLEAN.*1, true, yes, on, 0, false, no, off, or empty/)
      return true
    })
  }
})

for (const [name, flag, key] of switches) {
  for (const [value, expected] of values) {
    it(`${name}=${JSON.stringify(value)} resolves ${key} to ${expected}`, () => {
      if (value !== undefined) process.env[name] = value
      assert.equal(parseCliOptions(["--https", "true"])[key], expected)
    })
  }
  it(`${flag} overrides ${name}=false`, () => {
    process.env[name] = "false"
    assert.equal(parseCliOptions(["--https", "true", flag])[key], true)
  })
  it(`${name}=flase refuses parsing, even with its flag`, () => {
    process.env[name] = "flase"
    for (const args of [[], [flag]]) {
      assert.throws(() => parseCliOptions(["--https", "true", ...args]), new RegExp(name))
    }
  })
}
