import os from "node:os"
import path from "node:path"

// Match OpenCode's daemon-side data-directory and channel filename conventions.
// The fresh storage challenge still verifies the chosen file before any write.
export function pruningDatabasePath(
  configured: unknown,
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): unknown {
  if (configured !== undefined) return configured
  const data = path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.join(home, ".local", "share"), "opencode")
  if (env.OPENCODE_DB) return env.OPENCODE_DB === ":memory:" || path.isAbsolute(env.OPENCODE_DB)
    ? env.OPENCODE_DB : path.join(data, env.OPENCODE_DB)
  const shared = ["latest", "beta", "prod"].includes(channel)
    || env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  return path.join(data, shared ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}
