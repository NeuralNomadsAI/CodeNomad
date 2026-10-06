import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const workflow = readFileSync(new URL("../../../.github/workflows/mobile-android.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n")
const source = workflow.slice(workflow.indexOf("  source-validation:"), workflow.indexOf("  debug-apk:"))
const native = workflow.slice(workflow.indexOf("  debug-apk:"))

test("Android PR CI keeps source checks unconditional and native SDK consent explicit", () => {
  assert.match(workflow, /^  pull_request:\n    paths:/m)
  assert.match(workflow, /^  workflow_dispatch:/m)
  assert.match(workflow, /accept_sdk_licenses:[\s\S]*?type: boolean[\s\S]*?default: false/)
  assert.match(native, /^    needs: source-validation$/m)
  assert.doesNotMatch(source, /^    if:/m)
  const gate = native.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1]
  assert(gate, "native job must have an explicit consent gate")
  assert(source.includes(`SDK_LICENSE_AUTHORIZED: \${{ ${gate} }}`), "summary must report the actual job gate")
  for (const event of ["pull_request", "workflow_dispatch", "push"]) {
    for (const consent of [undefined, "false", "TRUE", "true"]) {
      for (const checkbox of [undefined, false, true]) {
        const actual = runInNewContext(gate, {
          github: { event_name: event },
          // GitHub expression string equality is case-insensitive.
          vars: { CODENOMAD_ANDROID_ACCEPT_SDK_LICENSES: consent?.toLowerCase() },
          inputs: { accept_sdk_licenses: checkbox },
        }, { timeout: 100 })
        assert.equal(actual, (event === "pull_request" && consent?.toLowerCase() === "true") ||
          (event === "workflow_dispatch" && checkbox === true), `${event}/${consent}/${checkbox}`)
      }
    }
  }
  for (const command of ["npm run typecheck:mobile", "npm run test:mobile", "npm run ios:verify",
    "npm run test:browser", "cargo test --locked --manifest-path packages/mobile-app/src-tauri/policy/Cargo.toml"]) {
    assert(source.includes(command), `missing source check: ${command}`)
  }
  assert.doesNotMatch(source, /setup-android@|npm run android:(init|debug)/)
  assert.match(source, /working-directory: packages\/mobile-app\n        run: java --source 17 tests\/native\/TransportPolicyTest.java/)
  assert.match(native, /npm run android:init --workspace @codenomad\/mobile-app -- --ci --skip-targets-install/)
  assert.match(native, /npm run android:debug --workspace @codenomad\/mobile-app -- --ci/)
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.scripts["android:debug"], "tauri android build --debug --apk --target aarch64")
})

test("Android PR CI pins actions, checks the merge SHA and has no privileged publication path", () => {
  assert.match(workflow, /^permissions:\n  contents: read\n/m)
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|continue-on-error|cache:|actions\/cache@|npm run android:(release|bundle)|write-all|contents: write/)
  const actions = [...workflow.matchAll(/uses: ([^\s]+)(?: #.*)?/g)].map((match) => match[1])
  assert(actions.length >= 6)
  for (const action of actions) assert.match(action, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/)
  assert.equal(workflow.match(/ref: \$\{\{ github.sha \}\}/g)?.length, 2)
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 2)
  assert.equal(workflow.match(/run: npm ci --ignore-scripts/g)?.length, 2)
  assert.match(native, /if \(\$apks.Count -eq 0\) \{ throw/)
  assert.match(native, /if-no-files-found: error/)
  assert.match(native, /retention-days: 7/)
  assert.match(source, /APK job SKIPPED/)
})
