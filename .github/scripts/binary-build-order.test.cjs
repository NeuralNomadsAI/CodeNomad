const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")

const workflow = (name) => yaml.parse(fs.readFileSync(path.join(__dirname, "../workflows", name), "utf8"))

test("Tauri Windows is the first binary build and gates every other platform", () => {
  const { jobs } = workflow("build-and-upload.yml")
  const first = jobs["build-tauri-windows"]
  assert.match(first["runs-on"], /^windows-/)
  assert.equal(first.needs, undefined)
  assert.equal(first.if, undefined)
  assert.equal(first["continue-on-error"], undefined)
  for (const [id, job] of Object.entries(jobs)) {
    if (!id.startsWith("build-") || id === "build-tauri-windows") continue
    assert.equal(job.needs, "build-tauri-windows", id)
    assert.equal(job["continue-on-error"], undefined, id)
  }
  assert.deepEqual(jobs["publish-tauri-updater"].needs, [
    "build-tauri-windows", "build-tauri-macos", "build-tauri-macos-arm64", "build-tauri-linux",
  ])
})

test("PR builds and both release channels share the ordering without bypassing PR tests", () => {
  const pr = workflow("pr-build.yml").jobs.build
  const release = workflow("reusable-release.yml").jobs["build-and-upload"]
  assert.equal(pr.uses, "./.github/workflows/build-and-upload.yml")
  assert.equal(release.uses, pr.uses)
  assert.equal(workflow("dev-release.yml").jobs.prerelease.uses, "./.github/workflows/reusable-release.yml")
  assert.equal(workflow("release.yml").jobs.release.uses, "./.github/workflows/reusable-release.yml")
  assert.deepEqual(pr.needs, [
    "authorize", "tests", "tests-tauri-windows", "tests-opencode-compatibility",
    "tests-session-pruning-native", "tests-runtime-contracts", "tests-tauri-macos",
  ])
  assert.equal(pr.with.upload, false)
  assert.equal(pr.with.set_versions, false)
})
