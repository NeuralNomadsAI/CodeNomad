import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MISSION_JOURNAL_STORAGE_PREFIX } from "../../missions/journal"
import { desktopPlugin } from "./desktop-plugin"

const RETIRED = "codenomad-missions/authority-"

test("presence-owned setup registers one-time Missions without touching the retired authority namespace", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(path.join(temporary, "missions-retired-authority-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  const tools: string[] = [], touched: string[] = []
  // Old stored bytes, damaged and well-formed alike, must stay unread and unchanged.
  const old = new Map<string, unknown>([[`${RETIRED}v2/namespace`, "damaged"], [`${RETIRED}v2/project/x`, { grants: [] }]])
  const values = new Map<string, unknown>(old)
  const trap = (key: string) => {
    touched.push(key)
    if (key.startsWith(RETIRED)) throw new Error(`Retired authority namespace accessed: ${key}`)
  }
  const registrations = { dispose: async () => {} }
  let snapshot: (() => Promise<unknown>) | undefined
  try {
    const cleanup = await desktopPlugin(directory).setup({
      location: { directory: directory, project: { id: "owned-project", canonical: directory } },
      storage: {
        get: async (key: string) => { trap(key); return values.get(key) },
        set: async (key: string, value: unknown) => { trap(key); values.set(key, value) },
        remove: async (key: string) => { trap(key); values.delete(key) },
        scan: async ({ prefix }: { prefix: string }) => { trap(prefix); return { entries: [] } },
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
      assert.deepEqual(tools, ["inspect", "delegate", "revise", "report", "briefing"])
      assert.deepEqual((await snapshot!() as { missions: unknown[] }).missions, [])
    } finally { await cleanup?.() }
    assert.deepEqual(touched.filter(key => key.startsWith(RETIRED)), [], "no retired namespace read, create or repair")
    assert.ok(touched.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`) || key === MISSION_JOURNAL_STORAGE_PREFIX), touched.join(", "))
    for (const [key, value] of old) assert.deepEqual(values.get(key), value)
    assert.equal([...values.keys()].filter(key => key.startsWith(RETIRED)).length, old.size, "nothing created under the old namespace")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
