import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Context, Effect } from "effect"
import { readPluginPackageVersions } from "./plugin-package-versions"

test("Git display versions come from the installed manifest, keeping the native revision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "plugin-versions-"))
  const target = "git+https://github.com/acme/plugin.git", revision = "a".repeat(40)
  const source = { type: "package", target, version: revision }
  let resolves = 0
  const run = (installedRevision = revision) => Effect.runPromise(readPluginPackageVersions({
    list: () => Effect.succeed({ data: [
      { source }, { source },
      { source: { type: "package", target: "npm-plugin", version: "4.13.0" } },
      { source: { type: "local", path: directory } },
    ] }),
  } as any).pipe(Effect.provideService(Context.Service<never, unknown>("@opencode/Npm"), {
    resolve: (spec: string) => { resolves++; assert.equal(spec, target); return Effect.succeed({ directory, version: installedRevision }) },
  })))
  try {
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }))
    assert.deepEqual(await run(), [{ target, revision, version: "1.2.3" }])
    assert.equal(resolves, 1, "one read per native Git target; npm and local plugins are untouched")
    assert.deepEqual(await run("b".repeat(40)), [], "a newer cache generation cannot label an older runtime")
    for (const manifest of ['{}', '{"version":42}', '{"version":"bad\\nvalue"}', "{", JSON.stringify({ version: "x".repeat(65_536) })]) {
      await writeFile(path.join(directory, "package.json"), manifest)
      assert.deepEqual(await run(), [], manifest.slice(0, 40))
    }
    await rm(path.join(directory, "package.json"))
    await writeFile(path.join(directory, "other.json"), '{"version":"9.0.0"}')
    await symlink(path.join(directory, "other.json"), path.join(directory, "package.json"))
    assert.deepEqual(await run(), [], "manifest links are refused")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("missing native cache capability fails closed", async () => {
  assert.deepEqual(await Effect.runPromise(readPluginPackageVersions({ list: () => Effect.die("must not list") } as any)), [])
})

test("cache reads are bounded by Git target count and the native read deadline", async () => {
  const service = Context.Service<never, unknown>("@opencode/Npm")
  let resolves = 0
  const resolver = { resolve: () => { resolves++; return Effect.never } }
  const source = { type: "package", target: "github:acme/plugin", version: "a".repeat(40) }
  const inventory = (count: number) => ({ list: () => Effect.succeed({ data: Array.from({ length: count }, (_, index) => ({
    source: { ...source, target: `${source.target}${index}` },
  })) }) }) as any
  assert.deepEqual(await Effect.runPromise(readPluginPackageVersions(inventory(65)).pipe(Effect.provideService(service, resolver))), [])
  assert.equal(resolves, 0, "oversized inventory performs no cache IO")
  assert.deepEqual(await Effect.runPromise(readPluginPackageVersions(inventory(1)).pipe(Effect.provideService(service, resolver))), [])
  assert.equal(resolves, 1, "a stalled resolver is interrupted by the deadline")
})
