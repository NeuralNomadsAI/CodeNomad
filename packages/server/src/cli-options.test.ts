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
  for (const name of ["CODENOMAD_REMOTE_CONTROL", "CODENOMAD_LOCKED_HOST", "CLI_HOST"]) delete process.env[name]
})

it("an administrator-locked host wins over --host and CLI_HOST and is validated like --host", () => {
  assert.deepEqual([parseCliOptions(["--https", "true", "--host", "0.0.0.0"])].map(({ host, hostLocked }) => ({ host, hostLocked })),
    [{ host: "0.0.0.0", hostLocked: false }])
  process.env.CODENOMAD_LOCKED_HOST = " LOCALHOST "
  process.env.CLI_HOST = "0.0.0.0"
  for (const args of [[], ["--host", "0.0.0.0"], ["--host", "10.0.0.5"]]) {
    const options = parseCliOptions(["--https", "true", ...args])
    assert.deepEqual({ host: options.host, hostLocked: options.hostLocked }, { host: "127.0.0.1", hostLocked: true }, args.join(" "))
  }
  process.env.CODENOMAD_LOCKED_HOST = "10.20.0.7"
  assert.equal(parseCliOptions(["--https", "true", "--host", "127.0.0.1"]).host, "10.20.0.7")
  process.env.CODENOMAD_LOCKED_HOST = "fe80::1%eth0"
  assert.throws(() => parseCliOptions(["--https", "true"]), /CODENOMAD_LOCKED_HOST/)
  // A whitespace-only address never falls back to --host.
  process.env.CODENOMAD_LOCKED_HOST = " \t "
  assert.throws(() => parseCliOptions(["--https", "true", "--host", "0.0.0.0"]), /CODENOMAD_LOCKED_HOST must be an address/)
  process.env.CODENOMAD_LOCKED_HOST = ""
  assert.deepEqual([parseCliOptions(["--https", "true", "--host", "0.0.0.0"])].map(({ host, hostLocked }) => ({ host, hostLocked })),
    [{ host: "0.0.0.0", hostLocked: false }], "exactly empty means no policy")
})

it("CODENOMAD_REMOTE_CONTROL accepts only disabled, and any other value refuses startup", () => {
  assert.equal(parseCliOptions(["--https", "true"]).remoteControlDisabled, false)
  for (const value of ["disabled", " DISABLED "]) {
    process.env.CODENOMAD_REMOTE_CONTROL = value
    assert.equal(parseCliOptions(["--https", "true"]).remoteControlDisabled, true)
  }
  process.env.CODENOMAD_REMOTE_CONTROL = ""
  assert.equal(parseCliOptions(["--https", "true"]).remoteControlDisabled, false, "exactly empty means no policy")
  for (const value of ["off", "false", "disable", "enabled", " ", " \t "]) {
    process.env.CODENOMAD_REMOTE_CONTROL = value
    assert.throws(() => parseCliOptions(["--https", "true"]), (error: unknown) =>
      error instanceof InvalidArgumentError && /CODENOMAD_REMOTE_CONTROL accepts only "disabled"/.test(error.message))
  }
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
