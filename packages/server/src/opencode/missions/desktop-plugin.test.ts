import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { desktopPlugin } from "./desktop-plugin"

test("damaged owner authority does not disable existing independent one-shot Missions", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(path.join(temporary, "missions-damaged-owner-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  const tools: string[] = []
  const values = new Map<string, unknown>([[`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`, "damaged"]])
  const registrations = { dispose: async () => {} }
  let snapshot: (() => Promise<unknown>) | undefined, ready: boolean | undefined
  try {
    const cleanup = await desktopPlugin(directory, value => { ready = value }).setup({
      location: { directory: directory, project: { id: "owned-project", canonical: directory } },
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => { values.set(key, value) },
        scan: async () => ({ entries: [] }),
      },
      session: { hook: async () => registrations },
      rpc: { register: async (_: unknown, handlers: { snapshot(): Promise<unknown> }) => {
        snapshot = handlers.snapshot
        return { ...registrations, events: { emit: async () => {} } }
      } },
      tool: { transform: async (callback: (draft: { namespace(): void; add(input: { name: string }): void }) => void) => {
        callback({ namespace: () => {}, add: item => { tools.push(item.name) } })
        return registrations
      } },
    } as never)
    assert.equal(typeof cleanup, "function")
    try {
      assert.equal(ready, false)
      assert.deepEqual(tools, ["inspect", "delegate", "revise", "report", "briefing"])
      assert.deepEqual((await snapshot!() as { missions: unknown[] }).missions, [])
      assert.equal(values.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`), "damaged", "never repair unknown authority")
    } finally { await cleanup?.(); assert.equal(ready, false) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
