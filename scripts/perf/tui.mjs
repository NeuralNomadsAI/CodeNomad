import { createRequire } from "node:module"
import { MARKER, now } from "./lib.mjs"

const require = createRequire(import.meta.url)

export async function withTui(cli, daemon, session, run) {
  const pty = require("./tools/node_modules/@lydell/node-pty")
  const { Terminal } = require("./tools/node_modules/@xterm/headless")
  const cols = 200, rows = 60
  const p = pty.spawn(cli, ["--server", daemon.url, "--session", session, daemon.project], {
    name: "xterm-256color", cols, rows, cwd: daemon.project,
    env: { ...daemon.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  })
  const exited = new Promise(resolve => p.onExit(resolve))
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
    p.kill()
    let timer
    try {
      await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Fixture TUI did not exit")), 5000) })])
    } finally { clearTimeout(timer) }
  }
}
