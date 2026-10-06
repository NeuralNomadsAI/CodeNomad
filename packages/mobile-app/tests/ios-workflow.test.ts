import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("iOS workflow stays read-only Linux SOURCE validation with no native/export steps", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/mobile-ios.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  assert.match(workflow, /^name: Mobile iOS SOURCE validation \(no native build\)$/m)
  assert.match(workflow, /^    name: SOURCE validation only — not an iOS app build$/m)
  assert.match(workflow, /^    runs-on: ubuntu-24\.04$/m)
  assert.match(workflow, /^permissions:\n  contents: read\n/m)
  assert.equal([...workflow.matchAll(/^\s*permissions:/gm)].length, 1)
  assert.equal([...workflow.matchAll(/^\s*runs-on:/gm)].length, 1)
  assert.match(workflow, /^          persist-credentials: false$/m)
  assert.equal(workflow.match(/\non:\n([\s\S]*?)\npermissions:/)?.[1], [
    "  pull_request:", "    paths:",
    "      - '.github/workflows/mobile-ios.yml'",
    "      - 'packages/mobile-app/**'",
    "      - 'packages/ui/src/lib/i18n/messages/**/remoteAccess.ts'",
    "      - 'packages/ui/src/styles/tokens.css'",
    "      - 'packages/server/src/server/routes/auth-pages/login.html'",
    "      - 'package.json'", "      - 'package-lock.json'",
    "  workflow_dispatch:", "",
  ].join("\n"))
  assert.deepEqual([...workflow.matchAll(/^\s+- uses: (\S+)/gm)].map((match) => match[1]), [
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  ])
  assert.deepEqual([...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]), [
    "npm ci --ignore-scripts --workspace @codenomad/mobile-app --include-workspace-root --no-audit --no-fund",
    "npm run typecheck --workspace @codenomad/mobile-app",
    "npm run test --workspace @codenomad/mobile-app",
    "npm run build --workspace @codenomad/mobile-app",
    "npm run ios:verify --workspace @codenomad/mobile-app",
    "rustup toolchain install 1.94.0 --profile minimal",
    "cargo +1.94.0 test --locked --manifest-path packages/mobile-app/src-tauri/policy/Cargo.toml",
  ])
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|write-all|contents: write|ios:(?:init|build)|app-store-connect|macos-|xcodebuild|sudo|ssh|sandbox-exec/)
})
