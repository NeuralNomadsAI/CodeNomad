import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { FixtureDefinition } from "./fixture-daemon/server"
import { readyDirectoryFor } from "./fixture-daemon/paths"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export interface BorrowedFixture {
  readonly url: string
  close(): Promise<void>
}

export interface BorrowOptions {
  /** Test seam: probe a private discovery directory instead of the machine's. */
  readyDirectory?: string
  /** Test seam: where the per-process fallback daemon announces itself.
   * Production callers leave this unset and get a fresh temporary directory,
   * so a borrower never claims the shared discovery location a runner owns. */
  privateDirectory?: string
}

interface ReadyFile { port: number, pid: number, secret: string }

/** Borrowed routes are namespaced under the fixture's name so distinct
 * fixtures never collide on common paths like "/fixture". The original path
 * is preserved verbatim after the prefix: tests derive sibling route URLs
 * from the borrowed url by string substitution, and a uniform prefix keeps
 * those derivations working. (A fixture whose own name contained a replaced
 * substring would still be at risk — keep names free of route fragments.) */
function namespaced(definition: FixtureDefinition): FixtureDefinition {
  return {
    name: definition.name,
    routes: definition.routes.map(route => ({
      path: `/${definition.name}${route.path}`,
      html: route.html,
    })),
  }
}

async function healthy(ready: ReadyFile): Promise<boolean> {
  return fetch(`http://127.0.0.1:${ready.port}/__daemon/health`)
    .then(response => (response.ok ? response.json() : null))
    .then((body: { ready?: boolean } | null) => body?.ready === true)
    .catch(() => false)
}

async function readReady(readyFile: string): Promise<ReadyFile | null> {
  return readFile(readyFile, "utf8").then(JSON.parse, () => null)
}

async function registerOn(ready: ReadyFile, definition: FixtureDefinition): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${ready.port}/__daemon/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-secret": ready.secret },
    body: JSON.stringify(definition),
  })
  if (!response.ok) throw new Error(`fixture registration failed: ${await response.text()}`)
  return (await response.json()).url
}

interface PrivateDaemon { ready: ReadyFile }
const privateDaemons = new Map<string, Promise<PrivateDaemon>>()

async function ensurePrivateDaemon(directory?: string): Promise<PrivateDaemon> {
  const key = directory ?? "default"
  let entry = privateDaemons.get(key)
  if (!entry) {
    entry = spawnPrivateDaemon(directory).catch(error => { privateDaemons.delete(key); throw error })
    privateDaemons.set(key, entry)
  }
  return entry
}

/** The fallback when no shared daemon is serving: one private daemon child
 * per borrower process, in its own temporary discovery directory (never the
 * shared one — claiming that is the runners' job). The child skips warmup
 * (the first fixture page pays the cold graph, exactly like the old
 * per-file owned servers) and follows its parent to the grave through
 * CODENOMAD_FIXTURE_PARENT_PID, so the borrower process never holds Vite
 * handles that outlive it. */
async function spawnPrivateDaemon(directory?: string): Promise<PrivateDaemon> {
  const readyDirectory = directory ?? await mkdtemp(path.join(tmpdir(), "codenomad-fixture-private-"))
  const readyFile = path.join(readyDirectory, "ready")
  const child: ChildProcess = spawn(process.execPath,
    ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-daemon", "daemon.mjs")],
    { detached: true, stdio: "ignore", cwd: uiRoot, env: {
      ...process.env,
      CODENOMAD_FIXTURE_READY_DIR: readyDirectory,
      CODENOMAD_FIXTURE_WARMUP: "0",
      CODENOMAD_FIXTURE_PARENT_PID: String(process.pid),
    } })
  child.unref()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await readReady(readyFile)
    if (ready && await healthy(ready)) return { ready }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`private fixture daemon did not become ready at ${readyFile}`)
}

/** Borrows a fixture page. A runner-owned shared daemon (shard.mjs, run.mjs)
 * serves when healthy; otherwise this process gets a private daemon child
 * that dies with it. Borrowers never spawn or claim the shared discovery
 * directory themselves — that is what kept stale module graphs alive across
 * runs. */
export async function borrowFixture(definition: FixtureDefinition, options: BorrowOptions = {}): Promise<BorrowedFixture> {
  const request = namespaced(definition)
  const sharedDirectory = options.readyDirectory ?? readyDirectoryFor(uiRoot)
  const sharedReady = await readReady(path.join(sharedDirectory, "ready"))
  if (sharedReady && await healthy(sharedReady)) {
    try {
      return { url: await registerOn(sharedReady, request), close: async () => {} }
    } catch { /* the daemon fell over mid-flight; the private fallback takes it */ }
  }
  const priv = await ensurePrivateDaemon(options.privateDirectory)
  return { url: await registerOn(priv.ready, request), close: async () => {} }
}
