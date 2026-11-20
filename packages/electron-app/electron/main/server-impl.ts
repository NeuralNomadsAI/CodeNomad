import { existsSync, statSync } from "fs"
import path from "path"

/** `CODENOMAD_SERVER_IMPL=rust` launches the Rust server binary instead of the Node server. */
export function usesRustServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODENOMAD_SERVER_IMPL?.trim().toLowerCase() === "rust"
}

export function rustServerFile(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codenomad-rs.exe" : "codenomad-rs"
}

interface RustServerLocation {
  dev: boolean
  /** Folders holding the packaged `server/` resources, in preference order. */
  resourceRoots: string[]
  /** The repository checkout, for Cargo's output in development. */
  workspaceRoot: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** The packaged binary sits in `server/dist` beside the Node entry, so it finds `../public` and
 * `plugins/` like `dist/bin.js`. Development prefers the newest Cargo build (debug or release). */
export function resolveRustServer({ dev, resourceRoots, workspaceRoot, env = process.env, platform = process.platform }: RustServerLocation): string | undefined {
  const file = rustServerFile(platform)
  const packaged = resourceRoots.map((root) => path.join(root, "server", "dist", file)).find((candidate) => existsSync(candidate))
  const targets = [env.CARGO_TARGET_DIR, path.join(workspaceRoot, "packages", "server-rs", "target")].filter((dir): dir is string => Boolean(dir))
  const built = targets.flatMap((dir) => ["debug", "release"].map((profile) => path.resolve(dir, profile, file)))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  return dev ? built ?? packaged : packaged ?? built
}
