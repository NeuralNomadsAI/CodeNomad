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

test("every signed binary of a build is restricted to the same product version", () => {
  const configurations = path.join(__dirname, "../../.signpath/artifact-configurations")
  for (const file of fs.readdirSync(configurations)) {
    const xml = fs.readFileSync(path.join(configurations, file), "utf8")
    assert.deepEqual([...xml.matchAll(/<parameter name="([^"]+)"/g)].map((m) => m[1]), ["version"], file)
    const restrictions = [...xml.matchAll(/<pe-file [^>]*>/g)].map(([element]) => element)
    assert.ok(restrictions.length > 0, file)
    for (const element of restrictions) {
      assert.match(element, /product-name="CodeNomad"/, file)
      assert.match(element, /product-version="\$\{version\}"/, file)
    }
  }
  // The full version reaches the resource editor before signing.
  const electron = JSON.parse(fs.readFileSync(path.join(__dirname, "../../packages/electron-app/package.json"), "utf8"))
  assert.equal(electron.build.afterSign, undefined)
  assert.equal(electron.build.afterAllArtifactBuild, undefined)
  const build = fs.readFileSync(path.join(__dirname, "../../packages/electron-app/scripts/build.js"), "utf8")
  assert.match(build, /args\.includes\("--win"\) \? \[`-c\.extraMetadata\.shortVersionWindows=\$\{version\}`\] : \[\]/)
  assert.match(build, /"electron-builder", "--publish=never", \.\.\.job\.args, \.\.\.windowsVersionArgs\(job\.args, version\)/)
  assert.equal(electron.devDependencies["electron-builder"], "26.18.0")
  const patch = build.indexOf('"patch-builder-resources.cjs"')
  assert.ok(patch >= 0 && patch < build.indexOf('["electron-builder", "--publish=never"'))
  // Every Windows build checks the result before any SignPath submission.
  const check = workflow("build-and-upload.yml").jobs["build-windows"].steps.find((step) => step.name === "Check Electron executable metadata")
  assert.equal(check.if, undefined)
  assert.match(check.run, /-ProductVersion \$env:SIGNING_VERSION -Unsigned/)
})

test("the reviewed Windows editor preserves strings and numeric versions before signing", async () => {
  const { createRequire } = require("node:module")
  const os = require("node:os")
  const appRequire = createRequire(path.join(__dirname, "../../packages/electron-app/package.json"))
  const builderRequire = createRequire(appRequire.resolve("electron-builder/package.json"))
  const { patchSource, patchBuilderResources } = appRequire("./scripts/patch-builder-resources.cjs")
  const editor = builderRequire.resolve("app-builder-lib/out/util/resEdit.js")
  const patched = patchSource(fs.readFileSync(editor, "utf8"))
  assert.equal(patchSource(patched), patched, "idempotent")
  assert.throws(() => patchSource(`${patched}\n`), /Unreviewed/, "unknown source fails closed")
  patchBuilderResources()
  builderRequire("app-builder-lib")
  const { WinPackager } = builderRequire("app-builder-lib/out/winPackager.js")
  const { NtExecutable, NtExecutableResource, Resource } = builderRequire("resedit")
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "builder-resource-"))
  try {
    for (const version of ["1.0.1", "1.0.1-dev-20261110-example", "1.0.1-beta.2+build.3"]) {
      const file = path.join(directory, `${version}.exe`)
      fs.writeFileSync(file, Buffer.from(NtExecutable.createEmpty(false).generate()))
      let signed = false
      await WinPackager.prototype.signAndEditResources.call({
        appInfo: { productName: "CodeNomad", buildVersion: version, shortVersionWindows: version },
        platformSpecificBuildOptions: {},
        config: { electronDist: directory },
        getIconPath: async () => null,
        signIf: async (target) => {
          assert.equal(target, file)
          const exe = NtExecutable.from(fs.readFileSync(target))
          const resources = NtExecutableResource.from(exe)
          const info = Resource.VersionInfo.fromEntries(resources.entries)[0]
          for (const lang of info.getAllLanguagesForStringValues()) {
            const strings = info.getStringValues(lang)
            assert.equal(strings.ProductVersion, version)
            assert.equal(strings.FileVersion, version)
            assert.equal(strings.ProductName, "CodeNomad")
          }
          assert.equal(info.fixedInfo.fileVersionMS, 0x10000)
          assert.equal(info.fixedInfo.fileVersionLS, 0x10000)
          assert.equal(info.fixedInfo.productVersionMS, 0x10000)
          assert.equal(info.fixedInfo.productVersionLS, 0x10000)
          signed = true
        },
      }, file, 1, directory)
      assert.equal(signed, true, "the actual packager signs only after the resource assertions")
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
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
