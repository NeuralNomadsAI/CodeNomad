import assert from "node:assert/strict"
import { test } from "node:test"
import { sessionEnvironment } from "./session-environment"

test("Windows overrides replace case-insensitive keys without losing the base environment", async () => {
  const base = { Path: "C:\\tools", TEMP: "C:\\temp", SystemRoot: "C:\\Windows" }
  assert.deepEqual(await sessionEnvironment({ temp: "T:/", TMP: "T:/" }, { environment: base, platform: "win32" }), {
    Path: "C:\\tools", temp: "T:/", TMP: "T:/", SystemRoot: "C:\\Windows",
  })
  assert.deepEqual(await sessionEnvironment({}, { environment: base, platform: "win32" }), base)
  assert.equal(base.TEMP, "C:\\temp")
})

test("POSIX variable names retain their case and values are not shell interpolated", async () => {
  const result = await sessionEnvironment({ Path: "custom", VALUE: "a=b\n$HOME; echo nope", EMPTY: "" }, {
    environment: { PATH: "/bin", HOME: "/home/test" }, platform: "linux",
  })
  assert.deepEqual(result, { PATH: "/bin", HOME: "/home/test", Path: "custom", VALUE: "a=b\n$HOME; echo nope", EMPTY: "" })
})

test("internal authentication and storage variables cannot leak through the base or overrides", async () => {
  const variables = {
    OPENCODE_PASSWORD: "secret", opencode_server_password: "secret",
    CODENOMAD_SERVER_PASSWORD: "secret", CODENOMAD_AUTOMATION_BRIDGE_TOKEN: "secret",
    CODENOMAD_BOOTSTRAP_TOKEN: "secret", OPENCODE_DB: "private.db", XDG_STATE_HOME: "/private",
    PROVIDER_API_KEY: "intended", PATH: "/bin",
  }
  assert.deepEqual(await sessionEnvironment(variables, { environment: variables }), { PROVIDER_API_KEY: "intended", PATH: "/bin" })
})

test("invalid configured entries fail without reflecting their values", async () => {
  for (const variables of [{ "": "secret" }, { "BAD=KEY": "secret" }, { BAD: "secret\0value" }]) {
    await assert.rejects(sessionEnvironment(variables, { environment: {} }), { message: "Invalid session environment variable" })
  }
})

test("WSL uses the selected distro's full environment rather than the Windows host", async () => {
  const signal = new AbortController().signal
  const result = await sessionEnvironment({ TMPDIR: "/tmp/profile" }, {
    platform: "win32", distro: "Ubuntu", environment: { Path: "C:\\Windows", HOME: "C:\\Users\\test" }, signal,
    readWsl: async (distro, receivedSignal) => {
      assert.equal(distro, "Ubuntu")
      assert.equal(receivedSignal, signal)
      return { PATH: "/usr/bin:/bin", HOME: "/home/test", TMPDIR: "/tmp" }
    },
  })
  assert.deepEqual(result, { PATH: "/usr/bin:/bin", HOME: "/home/test", TMPDIR: "/tmp/profile" })
  await assert.rejects(sessionEnvironment({}, { distro: "Ubuntu", readWsl: async () => { throw new Error("unavailable") } }), /unavailable/)
})
