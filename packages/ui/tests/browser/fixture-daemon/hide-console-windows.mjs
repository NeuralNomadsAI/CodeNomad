// Spawned detached on Windows, the daemon has no console of its own, so every
// console program it starts would get a new, visible one that takes the user's
// keyboard focus (Vite runs `net use` as it starts). Its child processes hide
// their windows unless a caller asks otherwise. Imported first by daemon.mjs.
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { promisify } from "node:util"

// Options follow the command, or its argument list when there is one.
function withHiddenWindow(args) {
  const at = Array.isArray(args[1]) ? 2 : 1
  const next = [...args]
  if (next[at] !== null && typeof next[at] === "object") next[at] = { windowsHide: true, ...next[at] }
  else if (next[at] == null && next.length > at) next[at] = { windowsHide: true }
  else next.splice(at, 0, { windowsHide: true })
  return next
}

if (process.platform === "win32") {
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    const original = childProcess[name]
    const hidden = function (...args) { return original.apply(this, withHiddenWindow(args)) }
    const custom = original[promisify.custom]
    if (custom) hidden[promisify.custom] = (...args) => custom(...withHiddenWindow(args))
    childProcess[name] = hidden
  }
  // ES module imports of node:child_process (Vite's) see the hidden variants too.
  syncBuiltinESMExports()
}
