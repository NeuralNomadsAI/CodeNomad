import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { physical as physicalIdentity } from "./physical-path"
import type { MissionConfiguration } from "./launch-policy"
import { canonicalAuthority } from "./authority-protocol"

const entry = z.object({ directory: z.string().min(1).max(4096), physical: z.string().min(1).max(4096),
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^[1-9]\d*$/), birth: z.string().regex(/^\d+$/) }).strict()
export const missionCalendarPlacementSchema = z.object({ rootsDigest: z.string().regex(/^[a-f0-9]{64}$/), roots: z.array(entry).min(1).max(128),
  routing: z.array(z.object({ file: z.string().min(1).max(4096), digest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(128),
  gitEnvironmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type MissionCalendarPlacement = z.infer<typeof missionCalendarPlacementSchema>
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const environment = () => hash(JSON.stringify(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")).sort(([a], [b]) => a.localeCompare(b))))
const capture = (directory: string) => {
  const named = lstatSync(directory, { bigint: true }), physical = realpathSync(directory), stat = statSync(physical, { bigint: true })
  if (!path.isAbsolute(directory) || !named.isDirectory() || named.isSymbolicLink() || !stat.isDirectory() || stat.ino <= 0n)
    throw new Error("Mission calendar physical root unavailable")
  return { directory, physical: physicalIdentity(physical), dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) }
}
const routingBytes = (file: string, maximum = 64 * 1024): Buffer | undefined => {
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd), named = lstatSync(file)
    if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > maximum)
      throw new Error("Mission calendar Git routing unavailable")
    const result = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < result.length) { const count = readSync(fd, result, size, result.length - size, null); if (!count) break; size += count }
    const after = fstatSync(fd)
    if (size > maximum || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new Error("Mission calendar Git routing changed")
    return result.subarray(0, size)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
  finally { if (fd !== undefined) closeSync(fd) }
}
const bytes = (file: string) => { const result = routingBytes(file); return result === undefined ? null : hash(result) }
export function captureMissionCalendarPlacement(roots: MissionConfiguration["roots"]): MissionCalendarPlacement {
  const directories = new Set(roots.map(root => root.directory)), routing = new Set<string>()
  for (const root of roots) if (root.mode === "git") {
    directories.add(root.checkout); directories.add(root.family)
    const dotGit = path.join(root.checkout, ".git"), stat = lstatSync(dotGit)
    let git = dotGit
    if (stat.isFile() && !stat.isSymbolicLink()) {
      if (stat.size > 8192) throw new Error("Mission calendar Git routing unavailable")
      const line = routingBytes(dotGit, 8192)?.toString("utf8").trim() ?? ""
      if (!line.startsWith("gitdir: ")) throw new Error("Mission calendar Git routing unavailable")
      routing.add(dotGit); git = path.resolve(root.checkout, line.slice(8))
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Mission calendar Git routing unavailable")
    const commonFile = path.join(git, "commondir")
    const route = routingBytes(commonFile, 8192)
    const common = route === undefined ? git : path.resolve(git, route.toString("utf8").trim())
    if (physicalIdentity(realpathSync(common)) !== physicalIdentity(realpathSync(root.family))) throw new Error("Mission calendar Git family differs")
    directories.add(git); routing.add(commonFile); routing.add(path.join(common, "config")); routing.add(path.join(git, "config.worktree"))
  }
  return missionCalendarPlacementSchema.parse({ rootsDigest: hash(canonicalAuthority(roots)), roots: [...directories].map(capture),
    routing: [...routing].map(file => ({ file, digest: bytes(file) })), gitEnvironmentDigest: environment() })
}
export function assertMissionCalendarPlacement(proof: MissionCalendarPlacement, roots: MissionConfiguration["roots"]): true {
  if (JSON.stringify(captureMissionCalendarPlacement(roots)) !== JSON.stringify(proof)) throw new Error("Mission calendar physical root changed")
  return true
}
