// Read-only executable used by the foreground OS guard. Bundle it with the
// client; never resolve dependencies from an open project or a user's PATH.
import { readFile, lstat } from "node:fs/promises"
import path from "node:path"
import { parseSupervisionManifest, SUPERVISION_MANIFEST_BYTES } from "./service-supervision-contract"
import { readSupervisionHealth, nativeSupervisionStartPermitted } from "./service-supervision-health"
import { wslRuntimeSchema, readWslSupervisionSample } from "./service-supervision-wsl"
import { supervisionTargetReady } from "./service-supervision-target"
import { execFile } from "node:child_process"

async function probe() {
  const [directory, key] = process.argv.slice(2)
  if (!directory || !path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(key)) throw new Error()
  const file = path.join(directory, "manifest.json")
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > SUPERVISION_MANIFEST_BYTES) throw new Error()
  const bytes = await readFile(file)
  if (bytes.length > SUPERVISION_MANIFEST_BYTES) throw new Error()
  const manifest = parseSupervisionManifest(JSON.parse(bytes.toString("utf8")))
  if (manifest.key !== key) throw new Error()
  if (manifest.namespace.platform === "wsl") {
    const descriptorFile = path.join(directory, "windows.json"), descriptorStat = await lstat(descriptorFile)
    if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.size > 32768) throw new Error()
    const descriptor = JSON.parse(await readFile(descriptorFile, "utf8"))
    if (descriptor.key !== key || descriptor.directory !== directory) throw new Error()
    return readWslSupervisionSample(manifest, wslRuntimeSchema.parse(descriptor.wsl), undefined, process.argv[4] === "--start")
  }
  if (manifest.namespace.platform !== "win32") throw new Error()
  const registration = path.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
  const health = await readSupervisionHealth(registration)
  const permitted = await nativeSupervisionStartPermitted(path.join(manifest.namespace.configDirectory, manifest.namespace.registrationName))
  // Selection, preference and health are non-secret. No registration/auth bytes
  // or exception text cross into the wrapper or its status file.
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile(manifest.target.binary, args,
    { env: process.env, windowsHide: true, timeout: 2000, maxBuffer: 65536 },
    (error, stdout) => error ? reject(new Error("supervision-target-unavailable")) : resolve(stdout.trim())))
  return { revision: manifest.revision, desired: manifest.desired, binary: manifest.target.binary, health, permitted,
    ...(process.argv[4] === "--start" ? { targetReady: await supervisionTargetReady(manifest.target, undefined,
      { namespace: manifest.namespace, run }) } : {}) }
}
probe().then(result => console.log(JSON.stringify(result))).catch(() => {
  console.log(JSON.stringify({ health: { state: "unknown" } }))
  process.exitCode = 1
})
