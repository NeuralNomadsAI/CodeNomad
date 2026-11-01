const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const yaml = require("yaml")

const workflow = (name) => yaml.parse(fs.readFileSync(path.join(__dirname, "../workflows", name), "utf8"))
const SIGN_ACTION = "./.github/actions/signpath-sign"

test("only maintainer-controlled channels request SignPath signing", () => {
  assert.equal(workflow("pr-build.yml").jobs.build.with.windows_signing_policy, undefined)
  assert.equal(workflow("pr-build.yml").jobs.build.secrets, undefined, "PR builds receive no SignPath token")
  assert.equal(
    workflow("release.yml").jobs.release.with.windows_signing_policy,
    "${{ vars.SIGNPATH_RELEASE_SIGNING == 'true' && 'release-signing' || '' }}",
  )
  assert.equal(
    workflow("dev-release.yml").jobs.prerelease.with.windows_signing_policy,
    "${{ inputs.signpath_test_signing && 'test-signing' || '' }}",
  )
  const testSigning = workflow("signpath-test-signing.yml").jobs.build.with
  assert.equal(testSigning.windows_signing_policy, "test-signing")
  assert.equal(testSigning.upload, false, "test signing publishes nothing")
})

test("every SignPath submission is gated, verified and limited to the Windows jobs", () => {
  const { jobs } = workflow("build-and-upload.yml")
  const signing = Object.entries(jobs).filter(([, job]) => job.steps?.some((step) => step.uses === SIGN_ACTION))
  assert.deepEqual(signing.map(([id]) => id).sort(), ["build-tauri-windows", "build-windows"])
  for (const [id, job] of signing) {
    const ids = job.steps.map((step) => step.id)
    assert.ok(ids.includes("signing"), id)
    job.steps.forEach((step, index) => {
      if (step.uses !== SIGN_ACTION) return
      assert.equal(step.if, "${{ steps.signing.outputs.enabled == 'true' }}", `${id}: ${step.name}`)
      const verify = job.steps[index + 1]
      assert.equal(verify.if, step.if, `${id}: ${step.name} is followed by its verification`)
      assert.match(verify.run, /verify-authenticode\.ps1 .*-Policy \$env:POLICY/, `${id}: ${step.name}`)
    })
  }
})

test("the Tauri executable is marked and signed before NSIS bundles it unpatched", () => {
  const steps = workflow("build-and-upload.yml").jobs["build-tauri-windows"].steps
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run ?? step.with?.["artifact-configuration"] ?? ""))
  const build = index(/tauri build --no-bundle/)
  const patch = index(/patch-bundle-type\.mjs .*codenomad-tauri\.exe nsis/)
  const signApp = index(/^tauri-app-exe$/)
  const bundle = index(/tauri bundle --bundles nsis --no-binary-patching/)
  const signInstaller = index(/^tauri-installer$/)
  const resign = index(/tauri signer sign --app-version/)
  const stage = index(/updater-artifacts\.mjs stage windows-x86_64/)
  assert.ok(build >= 0 && build < patch && patch < signApp && signApp < bundle, "executable signed before bundling")
  assert.ok(bundle < signInstaller && signInstaller < resign && resign < stage, "updater signature covers the signed installer")
})
