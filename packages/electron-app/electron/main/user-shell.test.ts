import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildUserShellCommand, getDefaultShellPath } from "./user-shell"
import { parseShellEnvironment, resolveShellEnvironment, restoreDesktopProfileEnvironment, shellEnvironmentScript } from "./shell-environment"
import { resolveSelectedConfig } from "./startup"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

const processState = (pid: number) => {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
  assert.ifError(result.error)
  assert.ok(result.status === 0 || result.status === 1)
  return result.stdout.trim()
}

async function assertProcessesGone(pids: number[]) {
  for (let attempt = 0; attempt < 40 && pids.some(pid => processState(pid)); attempt++) await delay(25)
  for (const pid of pids) assert.equal(processState(pid), "", `owned process ${pid} must be reaped`)
}

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
  it("initial/replacement shell discovery cannot replace the captured desktop profile or JSON source", () => {
    const config = resolveSelectedConfig("Émilie/custom.json", process.cwd())!
    const selected = { CODENOMAD_UPDATE_CHANNEL: "dev-v2", CODENOMAD_PROFILE_CONFIG_IDENTITY: "owned-config.yaml", CLI_CONFIG: config }
    for (const replacement of [false, true]) {
      const env = { PATH: "/shell/tools", CODENOMAD_UPDATE_CHANNEL: "stable", CODENOMAD_PROFILE_CONFIG_IDENTITY: "foreign", CLI_CONFIG: "/foreign.yaml" }
      restoreDesktopProfileEnvironment(env, selected)
      assert.deepEqual(env, { PATH: "/shell/tools", ...selected }, String(replacement))
      assert.ok(path.isAbsolute(env.CLI_CONFIG)); assert.ok(env.CLI_CONFIG.endsWith("custom.json"))
      restoreDesktopProfileEnvironment(env, { ...selected, CLI_CONFIG: undefined })
      assert.equal(env.CLI_CONFIG, undefined)
    }
    const manager = readFileSync(new URL("./process-manager.ts", import.meta.url), "utf8")
    assert.ok(manager.indexOf("restoreDesktopProfileEnvironment(env, this.desktopProfile)") > manager.indexOf("env = discovered.env"))
  })
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

  for (const background of [false, true]) it(`keeps the framed emitter alive for a delayed consumer${background ? " with a descendant" : ""} and removes its group`, {
    skip: process.platform === "win32", timeout: 5000,
  }, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-lifetime-"))
    const original = { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR }
    const kill = process.kill.bind(process)
    const owned: number[] = []
    let state = ""
    try {
      process.env.SHELL = process.env.CODENOMAD_TEST_ZSH || "/bin/zsh"
      process.env.ZDOTDIR = directory
      writeFileSync(path.join(directory, ".zshrc"), 'print banner\nexport FIXTURE_VALUE="owned\nvalue"\n'
        + (background ? 'sleep 30 &\nprint $! > "$ZDOTDIR/background"\n' : ""))
      const hook = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        assert.ok(pid < -1 && signal === "SIGKILL")
        owned.push(-pid)
        if (background) owned.push(Number(readFileSync(path.join(directory, "background"), "utf8").trim()))
        // Delay the real consumer, not the emitter or the kernel's signal result.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        state = processState(-pid)
        return kill(pid, signal)
      })
      try {
        const result = await resolveShellEnvironment(process.execPath, new AbortController().signal)
        assert.equal(result.executable, process.execPath)
        assert.equal(result.env.FIXTURE_VALUE, "owned\nvalue")
        assert.ok(state && !state.includes("Z"), "emitter must remain live until group cleanup")
      } finally {
        hook.mock.restore()
      }
      assert.equal(owned.length, background ? 2 : 1)
      await assertProcessesGone(owned)
      t.diagnostic(`owned processes ${owned.join("/")}: live emitter ${state}, all reaped after cleanup`)
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("bounds an emitter even without its discovery parent", {
    skip: process.platform === "win32", timeout: 5000,
  }, async () => {
    const start = Date.now()
    const child = spawn("/bin/sh", ["-c", shellEnvironmentScript(process.execPath)], {
      detached: true, stdio: ["ignore", "pipe", "ignore"],
    })
    const closed = once(child, "close")
    try {
      const [frame] = await once(child.stdout, "data")
      assert.ok(parseShellEnvironment(frame.toString()))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
      assert.ok(processState(child.pid!) && !processState(child.pid!).includes("Z"))
      await closed
      assert.equal(child.exitCode, 0)
      assert.ok(Date.now() - start < 4000)
      await assertProcessesGone([child.pid!])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    }
  })

  it("rejects a real permission-denied shell", { skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-denied-"))
    const original = process.env.SHELL
    try {
      process.env.SHELL = path.join(directory, "bash")
      writeFileSync(process.env.SHELL, "#!/bin/sh\n", { mode: 0o600 })
      const denied = spawnSync(process.env.SHELL)
      assert.equal((denied.error as NodeJS.ErrnoException)?.code, "EACCES")
      await assert.rejects(resolveShellEnvironment(process.execPath, new AbortController().signal), /spawn failed/)
    } finally {
      if (original === undefined) delete process.env.SHELL
      else process.env.SHELL = original
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects cleanup refusals without exposing their message", { skip: process.platform === "win32" }, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-cleanup-denied-"))
    const original = { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR }
    const kill = process.kill.bind(process)
    try {
      process.env.SHELL = process.env.CODENOMAD_TEST_ZSH || "/bin/zsh"
      process.env.ZDOTDIR = directory
      for (const code of ["EPERM", "EACCES"]) {
        const owned: number[] = []
        const hook = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
          assert.ok(pid < -1 && signal === "SIGKILL")
          owned.push(-pid)
          kill(pid, signal) // Clean the actual owned process before injecting a refusal.
          throw Object.assign(new Error("private environment must stay hidden"), { code })
        })
        try {
          await assert.rejects(resolveShellEnvironment(process.execPath, new AbortController().signal), { message: "Shell environment cleanup failed" })
        } finally {
          hook.mock.restore()
        }
        assert.equal(owned.length, 1)
        await assertProcessesGone(owned)
      }
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(directory, { recursive: true, force: true })
    }
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

  it("bounds a blocked shell and aborts an active probe", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codenomad-shell-test-"))
    const original = process.env.SHELL
    try {
      const shell = path.join(directory, "bash")
      const pids = path.join(directory, "pids")
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
      writeFileSync(shell, `#!/bin/sh\nsleep 30 &\nprintf '%s %s' "$$" "$!" > ${quote(pids)}\nwait\n`, { mode: 0o700 })
      process.env.SHELL = shell
      const start = Date.now()
      await assert.rejects(resolveShellEnvironment(process.execPath, new AbortController().signal), /timed out/)
      assert.ok(Date.now() - start < 5000)
      const timedOut = readFileSync(pids, "utf8").split(" ").map(Number)
      await assertProcessesGone(timedOut)
      rmSync(pids)
      const controller = new AbortController()
      const pending = resolveShellEnvironment(process.execPath, controller.signal)
      for (let attempt = 0; attempt < 40 && !existsSync(pids); attempt++) await delay(25)
      assert.ok(existsSync(pids), "abort must exercise an active shell and descendant")
      const aborted = readFileSync(pids, "utf8").split(" ").map(Number)
      controller.abort()
      await assert.rejects(pending, /cancelled/)
      await assertProcessesGone(aborted)
      t.diagnostic(`timeout group ${timedOut.join("/")} and aborted group ${aborted.join("/")}: all reaped`)
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
