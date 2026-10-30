import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { nativePluginBuild } from "./native-plugin-build.mjs"

test("native plugin builds never embed a second Effect runtime or OpenCode adapter", async () => {
  for (const entry of ["session-pruning/desktop-plugin", "automation/desktop-plugin", "missions/managed-owner-plugin"]) {
    const result = await build({ ...nativePluginBuild,
      entryPoints: [fileURLToPath(new URL(`../src/opencode/${entry}.ts`, import.meta.url))],
      write: false, metafile: true })
    const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"))
    assert.equal(inputs.some(value => /node_modules\/(?:effect|@opencode\/plugin)\//.test(value)), false, entry)
    assert(result.outputFiles[0].text.includes("desktopPlugin"), entry)
    if (entry === "session-pruning/desktop-plugin") {
      assert(result.outputFiles[0].text.includes('name: "session_search"'))
      assert(result.outputFiles[0].text.includes("codemode: true"))
      assert.equal(inputs.some(value => value.endsWith("workspaces/git-process.ts")), false, "Ranked ownership stays filesystem-only")
    }
  }
})

test("the Design content loads from a self-contained bundle, notices included, outside the checkout", async () => {
  const design = fileURLToPath(new URL("../src/opencode/design/", import.meta.url))
  const result = await build({ ...nativePluginBuild, entryPoints: [path.join(design, "content.ts")], write: false, metafile: true })
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports), [], "every file is inlined")
  const text = result.outputFiles[0].text
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const isolated = await mkdtemp(path.join(parent, "design-content-"))
  try {
    const bundle = path.join(isolated, "plugin.mjs")
    await writeFile(bundle, text)
    const { loadDesignContent, DESIGN_CONTENT_MARK, DESIGN_SKILL_IDS } = await import(pathToFileURL(bundle).href)
    const content = await loadDesignContent()
    assert.equal(await loadDesignContent(), content, "loaded once per process")
    assert.equal(content.agent.id, "design")
    assert.ok(content.agent.system.startsWith(`${DESIGN_CONTENT_MARK}\n`))
    assert.deepEqual(content.skills.map(skill => [skill.id, skill.autoinvoke]), DESIGN_SKILL_IDS.map(id => [id, false]))
    for (const skill of content.skills) assert.ok(skill.content.length > 500 && !skill.content.startsWith("---"), skill.id)
    assert.equal(content.notices.notice, await readFile(path.join(design, "opencode/NOTICE.md"), "utf8"))
    assert.equal(content.notices.apacheLicense, await readFile(path.join(design, "opencode/LICENSE-APACHE-2.0.txt"), "utf8"))
    // The per-file notices travel in the distributed bytes, not only in NOTICE.md.
    assert.ok(text.split("# Copyright (c) 2026 Leonxlnx").length - 1 === 2, "both MIT-derived skills keep their notice")
    assert.ok(text.includes("# Copyright 2026 Open Design contributors") && text.includes("# This file is a modified work."))
    assert.ok(text.includes("END OF TERMS AND CONDITIONS"))
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
})
