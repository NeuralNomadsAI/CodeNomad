// POSIX fallback supervisor when the Rust fixture job binary is not built in JS-only CI jobs.
import { spawn } from "node:child_process"

const parentPid = Number(process.env.CODENOMAD_FIXTURE_PARENT_PID || 0)
delete process.env.CODENOMAD_FIXTURE_PARENT_PID
const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("Fixture supervisor: expected an executable and its arguments")
  process.exit(1)
}

const child = spawn(command, args, { detached: true, stdio: "inherit", env: process.env })
let terminating = false

function killGroup() {
  if (!child.pid) return
  try { process.kill(-child.pid, "SIGKILL") } catch {}
}

function shutdown(code) {
  if (terminating) return
  terminating = true
  clearInterval(watch)
  killGroup()
  const deadline = Date.now() + 5000
  const wait = setInterval(() => {
    let alive = false
    if (child.pid) {
      try { process.kill(-child.pid, 0); alive = true } catch (error) { alive = error.code === "EPERM" }
    }
    if (!alive || Date.now() >= deadline) {
      clearInterval(wait)
      process.exit(code)
    }
    killGroup()
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
  clearInterval(watch)
  killGroup()
  process.exit(code ?? (signal ? 1 : 0))
})

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => shutdown(1))
}

const watch = setInterval(() => {
  if (!parentPid) return
  if (process.ppid !== parentPid) { shutdown(1); return }
  try { process.kill(parentPid, 0) } catch { shutdown(1) }
}, 50)
