import { spawn, type ChildProcess } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { FixtureDefinition } from "./fixture-daemon/server"
import { readyDirectoryFor } from "./fixture-daemon/paths"

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const readyDirectory = readyDirectoryFor(uiRoot)
const readyFile = path.join(readyDirectory, "ready")

export interface BorrowedFixture {
  readonly url: string
  close(): Promise<void>
}

export interface BorrowOptions {
  /** Test seam for the fallback path; defaults to the host platform. */
  platform?: NodeJS.Platform
}

interface ReadyFile { port: number, pid: number, secret: string }

async function readReady(): Promise<ReadyFile | null> {
  return readFile(readyFile, "utf8").then(JSON.parse, () => null)
}

async function probe(port: number, secret: string, pathName: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathName}`, init)
}

let spawning: Promise<ReadyFile> | null = null

async function spawnDaemon(): Promise<ReadyFile> {
  const existing = await readReady()
  if (existing && await probe(existing.port, existing.secret, "/__daemon/health").then(() => true, () => false)) return existing
  await rm(readyDirectory, { recursive: true, force: true })
  const child: ChildProcess = spawn(process.execPath,
    ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-daemon", "daemon.mjs")],
    { detached: true, stdio: "ignore", cwd: uiRoot })
  child.unref()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await readReady()
    if (ready && ready.pid !== process.pid
      && await probe(ready.port, ready.secret, "/__daemon/health").then(() => true, () => false)) return ready
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`fixture daemon did not become ready at ${readyFile}`)
}

async function ensureDaemon(): Promise<ReadyFile> {
  spawning ??= spawnDaemon().catch(error => { spawning = null; throw error })
  return spawning
}

async function registerOn(ready: ReadyFile, definition: FixtureDefinition): Promise<string> {
  const response = await probe(ready.port, ready.secret, "/__daemon/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-secret": ready.secret },
    body: JSON.stringify(definition),
  })
  if (!response.ok) throw new Error(`fixture registration failed: ${await response.text()}`)
  return (await response.json()).url
}

/** Borrowed routes are namespaced under the fixture's name so distinct
 * fixtures never collide on common paths like "/fixture". The original path
 * is preserved verbatim after the prefix: tests derive sibling route URLs
 * from the borrowed url by string substitution, and a uniform prefix keeps
 * those derivations working. */
function namespaced(definition: FixtureDefinition): FixtureDefinition {
  return {
    name: definition.name,
    routes: definition.routes.map(route => ({
      path: `/${definition.name}${route.path}`,
      html: route.html,
    })),
  }
}

/** Borrows a fixture page. On Linux this registers on the machine's shared
 * fixture daemon (lazily spawned); elsewhere each borrower runs its own
 * canonical server, keeping the suite usable with zero speedup. */
export async function borrowFixture(definition: FixtureDefinition, options: BorrowOptions = {}): Promise<BorrowedFixture> {
  const request = namespaced(definition)
  const platform = options.platform ?? process.platform
  if (platform !== "linux") {
    const { startFixtureDaemon } = await import("./fixture-daemon/server")
    const local = await startFixtureDaemon({ directory: uiRoot })
    const url = await local.register(request)
    return { url, close: () => local.close() }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = await ensureDaemon()
    try {
      return { url: await registerOn(ready, request), close: async () => {} }
    } catch (error) {
      spawning = null
      if (attempt === 1) {
        throw new Error(`fixture daemon at ${readyFile} (pid ${ready.pid}, port ${ready.port}) failed twice: ${error}`)
      }
    }
  }
  throw new Error("unreachable")
}
