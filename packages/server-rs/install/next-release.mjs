// Signed release N+1 for an installed backend (serial = installed serial + 1).
//   node install/next-release.mjs --trust <release-trust> [--trust <copy>] --binary <codenomad-rs[.exe]>
//     --plugins <plugins folder> --out <parent> --tool <cnrs-release> --key <release.key> [--rotate <keys folder>]
// The version is the binary's --version (build it with CNRS_BUILD_VERSION=<v>). --rotate
// announces <keys folder>/release.pub (generated when missing): once this release is
// installed, later releases must be signed with <keys folder>/release.key.
// Windows trust: <root>\config\release-trust; Linux: ~/.config/codenomad-rs/release-trust.
// Prints {release, version, serial, nextKey} as JSON; install it with update.ps1 / update.sh.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const { values: o } = parseArgs({ options: { trust: { type: "string", multiple: true }, binary: { type: "string" }, plugins: { type: "string" },
  out: { type: "string" }, tool: { type: "string" }, key: { type: "string" }, rotate: { type: "string" } } })
for (const name of ["trust", "binary", "plugins", "out", "tool", "key"]) if (!o[name]) throw new Error(`--${name} is required`)
const here = path.dirname(fileURLToPath(import.meta.url))
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "inherit"] }).trim()
const trust = o.trust.map(p => path.resolve(p))
const status = JSON.parse(run(o.tool, ["status", trust[0], trust[1] ?? trust[0]]))
const serial = String(status.serial + 1)
const version = run(path.resolve(o.binary), ["--version"])
let nextKey = ""
if (o.rotate) {
  nextKey = path.join(path.resolve(o.rotate), "release.pub")
  if (!existsSync(nextKey)) run(o.tool, ["keygen", path.resolve(o.rotate)])
}
const args = [version, path.resolve(o.binary), path.resolve(o.plugins), path.resolve(o.out), path.resolve(o.tool), path.resolve(o.key), serial]
const release = process.platform === "win32"
  ? run("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "windows", "package.ps1"), "-Version", args[0], "-Binary", args[1], "-Plugins", args[2],
    "-Out", args[3], "-Tool", args[4], "-Key", args[5], "-Serial", args[6], ...(nextKey ? ["-NextKey", nextKey] : [])]).split(/\r?\n/).at(-1)
  : run("bash", [path.join(here, "linux", "package.sh"), ...args, ...(nextKey ? [nextKey] : [])]).split("\n").at(-1)
console.log(JSON.stringify({ release, version, serial: Number(serial), installedKey: status.key, nextKey: nextKey || null }))
