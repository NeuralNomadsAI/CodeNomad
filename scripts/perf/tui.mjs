import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fixtureJobExecutable } from "../native-fixture-guards.mjs"
import { resolveWorktreePackage, withoutFixtureProxy } from "../native-fixture-http.mjs"
import { registerFixtureChild } from "../../packages/rune-app/fixtures/fixture-host.mjs"
import { MARKER, now } from "./lib.mjs"

const require = createRequire(import.meta.url)
const toolsNodeModules = path.resolve(fileURLToPath(new URL("./tools/node_modules", import.meta.url)))
const posixSupervisor = fileURLToPath(new URL("../native-fixture-posix-supervisor.mjs", import.meta.url))

export async function withTui(cli, daemon, session, run) {
  const pty = require(fileURLToPath(resolveWorktreePackage("@lydell/node-pty", toolsNodeModules)))
  const { Terminal } = require(fileURLToPath(resolveWorktreePackage("@xterm/headless", toolsNodeModules)))
  const cols = 200, rows = 60
  const isWin = process.platform === "win32"
  const command = isWin ? fixtureJobExecutable() : process.execPath
  const serverUrl = daemon.relayUrl ?? daemon.url
  const pidDir = await mkdtemp(path.join(os.tmpdir(), "cn-tui-pid-"))
  const pidFile = path.join(pidDir, "pid")
  const args = isWin
    ? ["--inherit-console", "--pid-file", pidFile, cli, "--server", serverUrl, "--session", session, daemon.project]
    : [posixSupervisor, "--same-group", "--pid-file", pidFile, cli, "--server", serverUrl, "--session", session, daemon.project]
  const tuiPid = Promise.withResolvers()
  let tuiPidSettled = false
  const settleTuiPid = value => { if (!tuiPidSettled) { tuiPidSettled = true; tuiPid.resolve(value) } }
  let p
  try {
    p = pty.spawn(command, args, {
      name: "xterm-256color", cols, rows, cwd: daemon.project,
      env: withoutFixtureProxy({
        ...daemon.env,
        CODENOMAD_FIXTURE_PARENT_PID: String(process.pid),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      }),
    })
  } catch (error) {
    settleTuiPid(null)
    await rm(pidDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  let didExit = false
  const exited = new Promise(resolve => p.onExit(info => { didExit = true; settleTuiPid(null); resolve(info) }))
  daemon.allowRelayClient?.(tuiPid.promise, exited)
  const pollPid = (async () => {
    const deadline = Date.now() + 15_000
    while (!tuiPidSettled && !didExit && Date.now() < deadline) {
      try {
        const raw = await readFile(pidFile, "utf8")
        const match = /^CODENOMAD_FIXTURE_PID=(\d+)\r?\n$/.exec(raw)
        if (match) { settleTuiPid(Number(match[1])); return }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    settleTuiPid(null)
  })()
  const stopTui = async () => {
    if (didExit) return
    if (process.platform === "win32") {
      try { p.kill() } catch {}
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
      return
    }
    try { p.kill("SIGTERM") } catch {}
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    if (!didExit && p.pid) {
      try { process.kill(-p.pid, "SIGKILL") } catch {}
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
    }
  }
  const untrack = registerFixtureChild(() => stopTui())
  void exited.finally(untrack)
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
  let screen = "", seen, waiter
  const data = p.onData(raw => {
    term.write(raw, () => {
      const b = term.buffer.active
      screen = ""
      for (let y = 0; y < rows; y++) {
        const line = b.getLine(b.viewportY + y)
        if (y > 0 && !line?.isWrapped) screen += "\n"
        screen += line?.translateToString(!b.getLine(b.viewportY + y + 1)?.isWrapped) ?? ""
      }
      const at = now()
      if (seen) for (const marker of screen.match(MARKER) ?? []) seen[marker] ??= at
      waiter?.(screen, at)
    })
  })
  async function when(predicate, timeout = 10_000) {
    let timer
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error("TUI screen wait timed out")), timeout)
          waiter = (text, at) => { if (predicate(text)) resolve(at) }
          waiter(screen, now())
        }),
        exited.then(({ exitCode }) => { throw Error(`Fixture TUI exited (${exitCode})`) }),
      ])
    } finally {
      clearTimeout(timer)
      waiter = undefined
    }
  }
  try {
    await when(text => text.includes("Foreground history") || /SEED\d+/.test(text), 60_000)
    let typed = ""
    await run({
      arm: () => { seen = {} },
      collect: () => ({ shown: seen }),
      async typeKey(i) {
        const char = "жщфывапролдэюбь"[i % 14]
        typed += char
        const at = now()
        p.write(char)
        return { at, elapsed: await when(text => text.includes(typed)) - at }
      },
      async clear() {
        p.write("\x7f".repeat(typed.length))
        if (typed) await when(text => !text.includes(typed))
        typed = ""
      },
    })
  } finally {
    data.dispose()
    term.dispose()
    // The PTY owns just this child. Refuse to leave it running after the sample.
    await stopTui()
    settleTuiPid(null)
    await pollPid
    await rm(pidDir, { recursive: true, force: true }).catch(() => {})
    if (!didExit) {
      let timer
      try {
        await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Fixture TUI did not exit")), 5000) })])
      } finally { clearTimeout(timer) }
    }
  }
}
