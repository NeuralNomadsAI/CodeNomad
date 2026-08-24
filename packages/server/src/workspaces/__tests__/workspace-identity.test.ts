import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../../events/bus"
import { WorkspaceManager } from "../manager"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function createLinkedWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-workspace-identity-"))
  temporaryDirectories.push(root)
  const target = path.join(root, "target")
  const link = path.join(root, "link")
  await mkdir(target)
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir")
  return { root, target, link }
}

function createManager(rootDir: string) {
  const logger = pino({ level: "silent" })
  const sharedService = {
    endpoint: async () => ({ url: "http://127.0.0.1:4321" }),
    client: async () => ({}),
    headers: async () => undefined,
    validateLocation: async ({ directory }: { directory: string }) => ({
      directory,
      project: { id: directory, directory, canonical: directory },
    }),
    evictLocation: async () => undefined,
    subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }),
    shutdown: async () => undefined,
  }
  const manager = new WorkspaceManager({
    rootDir,
    settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "Node.js", version: process.version }) },
    eventBus: new EventBus(logger),
    logger,
    sharedService,
  } as unknown as ConstructorParameters<typeof WorkspaceManager>[0])
  return manager
}

describe("workspace identity", () => {
  it("reuses one workspace for canonical aliases outside the configured root", async () => {
    const { root, target, link } = await createLinkedWorkspace()
    const manager = createManager(root)
    const [first, second] = await Promise.all([manager.create(target), manager.create(link)])

    assert.equal(first.workspace.id, second.workspace.id)
    assert.equal(first.workspace.path, second.workspace.path)
    assert.equal(Number(first.created) + Number(second.created), 1)
    assert.equal(manager.list().length, 1)
  })
})
