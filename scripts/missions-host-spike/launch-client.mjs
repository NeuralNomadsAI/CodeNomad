import { attachPersistentHost } from "./host-client.mjs"

const [profileDirectory, profile, sharedDaemonMarker] = process.argv.slice(2)
try {
  const attached = await attachPersistentHost({ profileDirectory, profile, sharedDaemonMarker })
  process.stdout.write(`${JSON.stringify(attached)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
