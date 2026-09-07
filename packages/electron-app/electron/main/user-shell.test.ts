import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildUserShellCommand, getDefaultShellPath } from "./user-shell"
import { parseShellEnvironment, resolveShellEnvironment, shellEnvironmentScript } from "./shell-environment"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

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

describe("bounded desktop shell environment", () => {
  it("ignores banners and preserves multiline values without interpreting shell syntax", () => {
    const snapshot = { executable: "/usr/bin/node", env: { PATH: "/custom/bin", SECRET: "a=b\n'$(not-a-command)'" } }
    const frame = `banner\n\0CODENOMAD_SHELL_ENV\0${JSON.stringify(snapshot)}\0trailing noise`
    assert.deepEqual(parseShellEnvironment(frame), snapshot)
    for (let length = 0; length < frame.indexOf("\0trailing") + 1; length++) {
      assert.equal(parseShellEnvironment(frame.slice(0, length)), null)
    }
    assert.equal(parseShellEnvironment("banner only"), null)
    for (const json of ['null', '{"executable":"relative","env":{}}', '{"executable":"/node","env":{"X":42}}', '{"executable":"/node\\u0000","env":{}}']) {
      assert.throws(() => parseShellEnvironment(`\0CODENOMAD_SHELL_ENV\0${json}\0`))
    }
  })

  it("quotes the runtime path as one literal shell argument", () => {
    assert.ok(shellEnvironmentScript("/a b/'$x;node").startsWith("exec '/a b/'\\''$x;node' -e '"))
  })

  it("does not source startup files a second time", { skip: process.platform === "win32" }, () => {
    const original = process.env.SHELL
    try {
      process.env.SHELL = "/bin/zsh"
      const command = buildUserShellCommand("exec node")
      assert.equal(command.args.at(-1), "exec node")
      assert.ok(command.args.includes("-i"))
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
    }
  })

  it("bounds a blocked shell and aborts an active probe", { skip: process.platform === "win32", timeout: 10000 }, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-shell-test-"))
    const original = process.env.SHELL
    try {
      const shell = path.join(directory, "bash")
      writeFileSync(shell, "#!/bin/sh\nsleep 30 &\nwait\n", { mode: 0o700 })
      process.env.SHELL = shell
      const start = Date.now()
      await assert.rejects(resolveShellEnvironment(process.execPath, new AbortController().signal), /timed out/)
      assert.ok(Date.now() - start < 5000)
      const controller = new AbortController()
      const pending = resolveShellEnvironment(process.execPath, controller.signal)
      controller.abort()
      await assert.rejects(pending, /cancelled/)
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("loads real zshrc once, preserves PATH and bounds a prompt in zshrc", {
    skip: process.platform === "win32",
    timeout: 10000,
  }, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-zsh-test-"))
    const original = { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR }
    try {
      process.env.SHELL = process.env.CODENOMAD_TEST_ZSH || "/bin/zsh"
      assert.ok(existsSync(process.env.SHELL), "Install zsh or set CODENOMAD_TEST_ZSH for the POSIX regression suite")
      process.env.ZDOTDIR = directory
      writeFileSync(path.join(directory, ".zshrc"), 'print loaded >> "$ZDOTDIR/count"\nexport PATH="/fixture/bin:$PATH"\nexport FIXTURE_VALUE="line one\nline two"\n')
      const env = await resolveShellEnvironment(process.execPath, new AbortController().signal)
      assert.equal(env.executable, process.execPath)
      assert.ok(env.env.PATH?.startsWith("/fixture/bin:"))
      assert.equal(env.env.FIXTURE_VALUE, "line one\nline two")
      assert.equal(readFileSync(path.join(directory, "count"), "utf8"), "loaded\n")
      writeFileSync(path.join(directory, ".zshrc"), 'export FIXTURE_VALUE=background\nsleep 30 &\n')
      const backgroundStart = Date.now()
      const background = await resolveShellEnvironment(process.execPath, new AbortController().signal)
      assert.equal(background.env.FIXTURE_VALUE, "background")
      assert.ok(Date.now() - backgroundStart < 2500, "a complete frame must not wait for a background child's EOF")
      // Represents a pinentry/GPG wait, not merely a read that exits on stdin EOF.
      writeFileSync(path.join(directory, ".zshrc"), "sleep 30 &\nwait\n")
      const start = Date.now()
      await assert.rejects(resolveShellEnvironment(process.execPath, new AbortController().signal), /timed out/)
      assert.ok(Date.now() - start < 5000)
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("preserves Bash rc exports when the login profile does not source them", { skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-bash-test-"))
    const original = { SHELL: process.env.SHELL, HOME: process.env.HOME }
    try {
      process.env.SHELL = "/bin/bash"
      process.env.HOME = directory
      writeFileSync(path.join(directory, ".bash_profile"), "export FIXTURE_PROFILE=loaded\n")
      writeFileSync(path.join(directory, ".bashrc"), 'export FIXTURE_RC=loaded\nexport PATH="/fixture/bash/bin:$PATH"\n')
      const result = await resolveShellEnvironment(process.execPath, new AbortController().signal)
      assert.equal(result.env.FIXTURE_PROFILE, "loaded")
      assert.equal(result.env.FIXTURE_RC, "loaded")
      assert.ok(result.env.PATH?.startsWith("/fixture/bash/bin:"))
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
