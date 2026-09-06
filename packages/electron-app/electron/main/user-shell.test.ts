import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getDefaultShellPath } from "./user-shell"

describe("desktop POSIX shell selection", () => {
  it("falls back from incompatible user shells", () => {
    assert.equal(getDefaultShellPath("darwin", "/opt/homebrew/bin/nu"), "/bin/zsh")
    assert.equal(getDefaultShellPath("linux", "/usr/bin/fish"), "/bin/bash")
    assert.equal(getDefaultShellPath("darwin", "/tmp/not-bash"), "/bin/zsh")
    assert.equal(getDefaultShellPath("darwin", "  "), "/bin/zsh")
  })

  it("preserves configured bash and zsh paths", () => {
    assert.equal(getDefaultShellPath("darwin", "/opt/homebrew/bin/bash"), "/opt/homebrew/bin/bash")
    assert.equal(getDefaultShellPath("linux", " /usr/local/bin/zsh "), "/usr/local/bin/zsh")
  })
})
