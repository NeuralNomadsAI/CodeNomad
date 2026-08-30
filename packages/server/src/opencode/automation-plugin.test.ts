import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { installAutomationPlugin, parseDeveloperAction, setupAutomationPlugin } from "./automation-plugin"

test("validates developer automation actions", () => {
  assert.deepEqual(parseDeveloperAction({ action: "type", ref: "e4", text: "CodeNomad" }), {
    action: "type",
    ref: "e4",
    text: "CodeNomad",
  })
  assert.deepEqual(parseDeveloperAction({ action: "restart" }), { action: "restart" })
  assert.throws(() => parseDeveloperAction({ action: "click" }), /click requires ref/)
})

test("registers developer tools while execution remains session-gated", async () => {
  let skill: Record<string, unknown> | undefined
  const tools: string[] = []
  await setupAutomationPlugin({
    location: { directory: "D:\\project" },
    skill: { transform: async (callback) => callback({ add: (value) => { skill = value } }) },
    tool: { transform: async (callback) => callback({ add: (value) => tools.push(value.name) }) },
  })

  assert.equal(skill?.id, "codenomad-automation")
  assert.equal(skill?.autoinvoke, true)
  assert.match(String(skill?.content), /codenomad\.inspect/)
  assert.deepEqual(tools, ["inspect", "act", "screenshot"])

})

test("installs the automation plugin and removes obsolete browser wrappers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-plugin-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = root

  try {
    const directory = path.join(root, "opencode", "plugins")
    const legacySkill = path.join(root, "opencode", "skills", "codenomad-browser")
    await installAutomationPlugin()
    await writeFile(path.join(directory, "codenomad-browser.mjs"), "legacy")
    await mkdir(legacySkill, { recursive: true })
    await writeFile(path.join(legacySkill, "SKILL.md"), "legacy")
    await installAutomationPlugin()

    assert.match(await readFile(path.join(directory, "codenomad-automation.ts"), "utf8"), /^export \{ default \} from "file:/)
    await assert.rejects(readFile(path.join(directory, "codenomad-browser.mjs"), "utf8"), { code: "ENOENT" })
    await assert.rejects(readFile(path.join(legacySkill, "SKILL.md"), "utf8"), { code: "ENOENT" })
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
