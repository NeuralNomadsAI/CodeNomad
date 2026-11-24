// POSIX fallback supervisor when the Rust fixture job binary is not built in JS-only CI jobs.
import { spawn } from "node:child_process"

const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID || 0)
delete process.env.CODENOMAD_FIXTURE_PARENT_PID
const rawArgs = process.argv.slice(2)
const sameGroup = rawArgs[0] === "--same-group"
const [command, ...args] = sameGroup ? rawArgs.slice(1) : rawArgs
if (!command) {
  console.error("Fixture supervisor: expected an executable and its arguments")
  process.exit(1)
}

const child = spawn(command, args, { detached: !sameGroup, stdio: "inherit", env: process.env })
let terminating = false
let childExited = false

function signalFamily(signal) {
  if (!child.pid) return
  if (sameGroup) {
    try { process.kill(child.pid, signal) } catch {}
    // In a PTY session, this supervisor is the process group leader; avoid killing self on SIGKILL.
    if (signal === "SIGTERM") {
      try { process.kill(-process.pid, "SIGTERM") } catch {}
    }
    return
  }
  try { process.kill(-child.pid, signal) } catch {}
}

function familyAlive() {
  if (!child.pid) return false
  if (sameGroup) {
    if (childExited) return false
    try { process.kill(child.pid, 0); return true } catch (error) { return error.code === "EPERM" }
  }
  try { process.kill(-child.pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

function shutdown(code, graceMs = 150) {
  if (terminating) return
  terminating = true
  clearInterval(watch)
  signalFamily("SIGTERM")
  const graceUntil = Date.now() + graceMs
  const deadline = Date.now() + 5000
  let escalated = false
  const wait = setInterval(() => {
    const alive = familyAlive()
    if (!alive) {
      clearInterval(wait)
      if (sameGroup) {
        // Ensure any remaining same-group descendants in the PTY session receive SIGKILL as we exit.
        try { process.kill(-process.pid, "SIGKILL") } catch {}
      }
      process.exit(code)
    }
    if (Date.now() >= deadline) {
      clearInterval(wait)
      process.exit(1)
    }
    if (!escalated && Date.now() >= graceUntil) {
      escalated = true
      signalFamily("SIGKILL")
    } else if (escalated) {
      signalFamily("SIGKILL")
    }
  }, 20)
}

child.once("spawn", () => {
  process.stderr.write(`CODENOMAD_FIXTURE_PID=${child.pid}\n`)
})
child.once("error", error => {
  console.error(`Fixture supervisor: ${error.message}`)
  clearInterval(watch)
  process.exit(1)
})
child.once("exit", (code, signal) => {
  childExited = true
  shutdown(code ?? (signal ? 1 : 0), 250)
})

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (terminating) return
    shutdown(1, 150)
  })
}

const watch = setInterval(() => {
  if (!parentPid) return
  if (process.ppid !== parentPid) { shutdown(1); return }
  try { process.kill(parentPid, 0) } catch { shutdown(1) }
}, 50)
