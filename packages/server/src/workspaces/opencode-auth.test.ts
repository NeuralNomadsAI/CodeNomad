import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveOpencodeServerAuth } from "./opencode-auth"

describe("resolveOpencodeServerAuth", () => {
  it("uses configured OpenCode auth from workspace environment", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {
        OPENCODE_SERVER_USERNAME: "alice",
        OPENCODE_SERVER_PASSWORD: "secret",
      },
      processEnv: {},
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "alice", password: "secret" })
  })

  it("uses process environment when workspace environment does not provide credentials", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {},
      processEnv: {
        OPENCODE_SERVER_PASSWORD: "process-secret",
      },
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "codenomad", password: "process-secret" })
  })

  it("falls back to generated credentials", () => {
    const auth = resolveOpencodeServerAuth({
      userEnvironment: {},
      processEnv: {},
      generatePassword: () => "generated",
    })

    assert.deepEqual(auth, { username: "codenomad", password: "generated" })
  })
})
