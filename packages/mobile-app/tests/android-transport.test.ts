import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { test } from "node:test"

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8")

test("production Android manifest/XML deny cleartext including loopback variants", (context) => {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java"
  const result = spawnSync(java, ["--source", "17", "tests/native/TransportPolicyTest.java"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    context.skip("JDK 17+ required for production XML parsing; Android builds must run this check")
    return
  }
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test("Android transport settings deny mixed content without replacing Wry HTTPS protocols", async () => {
  const base = "../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/"
  const plugin = await read(`${base}RecoveryPlugin.kt`)
  const load = plugin.slice(plugin.indexOf("override fun load("))
  assert.match(load, /webView\.settings\.mixedContentMode = WebSettings\.MIXED_CONTENT_NEVER_ALLOW/)
  assert(load.indexOf("MIXED_CONTENT_NEVER_ALLOW") < load.indexOf("webView.post"))
  assert.doesNotMatch(plugin, /MIXED_CONTENT_(ALWAYS_ALLOW|COMPATIBILITY_MODE)/)
  assert.match(await read("../src-tauri/src/lib.rs"), /\.use_https_scheme\(true\)/)
  const fence = await read(`${base}NavigationFence.kt`)
  assert.match(fence, /return original\.shouldInterceptRequest\(view, request\)/)
  assert.match(fence, /override fun onReceivedSslError[\s\S]*handler\.cancel\(\)/)
  assert.doesNotMatch(fence, /handler\.proceed\(/)
  // Subresource fetch login/upload/SSE and Wry IPC must not be restricted by
  // the selected-origin main-frame gate.
  assert.match(await read(`${base}ConnectionAuthority.kt`), /!mainFrame \|\| \(method == "GET" && admits\(url\)\)/)
})
