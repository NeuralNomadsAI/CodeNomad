import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isOpenCodeServiceCommandUnavailable, isOpenCodeServiceHelp } from "./opencode-cli-compatibility"
import { legacyHelp, serviceHelp } from "./__tests__/binary-probe-fixture"

describe("OpenCode CLI compatibility evidence", () => {
  it("recognizes V1 root help on either stream with CRLF and terminal formatting", () => {
    for (const help of [legacyHelp, `\x1b]0;OpenCode\x07\x1b[31m${legacyHelp.replace(/\n/g, "\r\n")}\x1b[0m`]) {
      assert.equal(isOpenCodeServiceCommandUnavailable(help), true)
      assert.equal(isOpenCodeServiceCommandUnavailable("", help), true)
      assert.equal(isOpenCodeServiceHelp(help), false)
    }
  })

  it("recognizes required V2 commands without a version or binary filename gate", () => {
    for (const help of [serviceHelp, serviceHelp.replaceAll("opencode2", "opencode"),
      `\x1b[32m${serviceHelp.replace(/\n/g, "\r\n")}\x1b[0m`,
      "opencode service [command]\nCommands:\n  opencode service start\n  opencode service status\n  opencode service get <key>\n",
    ]) {
      assert.equal(isOpenCodeServiceHelp(help), true)
      assert.equal(isOpenCodeServiceHelp("", help), true)
      assert.equal(isOpenCodeServiceCommandUnavailable(help), false)
    }
  })

  it("does not confuse generic failures or partial help with a compatible CLI", () => {
    for (const help of ["", "EACCES", "stopped", "http://127.0.0.1:1234", "service start status get",
      serviceHelp.replace(/  get .*\n/, ""), serviceHelp.replace("opencode2 service", "other-tool service"),
      legacyHelp + "  opencode service  manage background service\n",
    ]) {
      assert.equal(isOpenCodeServiceHelp(help), false, help)
    }
    for (const failure of ["ENOENT", "Unknown command: config", "Cannot reach daemon", "Commands:\n  other run\n"]) {
      assert.equal(isOpenCodeServiceCommandUnavailable(failure), false, failure)
    }
  })
})
