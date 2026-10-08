import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8")

test("bundled launcher is the only capability; no server/CLI resources", async () => {
  const config = JSON.parse(await read("../src-tauri/tauri.conf.json"))
  const capability = JSON.parse(await read("../src-tauri/capabilities/launcher.json"))
  assert.deepEqual(config.app.security.capabilities, ["launcher"])
  assert.equal(config.app.withGlobalTauri, false)
  assert.equal(config.bundle.resources, undefined)
  assert.equal(config.bundle.externalBin, undefined)
  assert.equal(config.bundle.android.minSdkVersion, 26)
  assert.equal(capability.local, true)
  assert.equal(capability.remote, undefined)
  assert.deepEqual(capability.webviews, ["main"])
  assert.deepEqual(capability.permissions, ["allow-connect-server"])
  assert.match(config.app.security.csp, /frame-src 'none'/)
})

test("native mobile recovery uses fixed bundled destinations, not remote DOM/IPC", async () => {
  const kotlin = await read("../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/RecoveryPlugin.kt")
  const fence = await read("../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/NavigationFence.kt")
  const swift = await read("../src-tauri/recovery/ios/Sources/RecoveryPlugin.swift")
  assert.match(kotlin, /root\.addView\(button/)
  assert.match(kotlin, /current\.view\.loadUrl\(NavigationFence\.LAUNCHER\)/)
  assert.match(kotlin, /DOCUMENT_START_SCRIPT/)
  assert.match(fence, /LAUNCHER = ConnectionAuthority\.LAUNCHER/)
  assert.match(fence, /authority\.allowsRequest\(request\.url\.toString\(\), request\.method, request\.isForMainFrame\)/)
  assert.match(swift, /root\.addSubview\(control\)/)
  assert.match(swift, /tauri:\/\/localhost\/index\.html/)
  assert.doesNotMatch(kotlin + swift, /evaluateJavaScript|evaluateJavascript|goBack\(/)
})

test("iOS app and recovery package share the approved iOS 15 minimum", async () => {
  const config = JSON.parse(await read("../src-tauri/tauri.conf.json"))
  const swiftPackage = await read("../src-tauri/recovery/ios/Package.swift")
  assert.equal(config.bundle.iOS.minimumSystemVersion, "15.0")
  assert.match(swiftPackage, /platforms: \[\.iOS\("15\.0"\)\]/)
})

test("host flags use the actual hosted UI override names", async () => {
  const rust = await read("../src-tauri/src/lib.rs")
  assert.match(rust, /__CODENOMAD_RUNTIME_HOST__.*value: 'web'/)
  assert.match(rust, /__CODENOMAD_WINDOW_CONTEXT__.*value: 'remote'/)
  assert.match(rust, /\.initialization_script\(HOSTED_CONTEXT\)/)
  assert.match(rust, /tauri_plugin_mobile_recovery::connect\(/)
  assert.match(await read("../src-tauri/build.rs"), /AppManifest::new\(\)\.commands\(&\["connect_server"\]\)/)
})

test("Android rejects non-GET main-frame requests before delegating networking (307/308)", async () => {
  const base = "../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/"
  const fence = await read(`${base}NavigationFence.kt`)
  const authority = await read(`${base}ConnectionAuthority.kt`)
  const intercept = fence.slice(fence.indexOf("override fun shouldInterceptRequest"), fence.indexOf("override fun onPageStarted"))
  assert.match(authority, /!mainFrame \|\| \(method == "GET" && admits\(url\)\)/)
  assert.match(intercept, /if \(!authority\.interceptRequest[\s\S]*return WebResourceResponse/)
  assert.match(authority, /if \(!allowsRequest\(url, method, mainFrame\)\) return false/)
  assert(intercept.indexOf("return WebResourceResponse") < intercept.indexOf("original.shouldInterceptRequest"))
  const tests = await read("./native/ConnectionAuthorityTest.kt")
  assert.match(tests, /listOf\(307, 308\)/)
  assert.match(tests, /initialRequests == 0 && redirectedRequests == 0/)
  const login = await read("../../server/src/server/routes/auth-pages/login.html")
  assert.match(login, /fetch\("\/api\/auth\/login",\s*\{\s*method: "POST"/)
  assert.match(login, /window\.location\.replace\("\/"\)/)
})

test("native readiness is read-only and commit/load shares the platform UI transaction", async () => {
  const kotlin = await read("../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/RecoveryPlugin.kt")
  const readiness = kotlin.slice(kotlin.indexOf("fun readiness("), kotlin.indexOf("fun connect("))
  assert.match(readiness, /activity\.runOnUiThread/)
  assert.match(readiness, /authority\.snapshot\(\)/)
  assert.doesNotMatch(readiness, /\.commit\(|\.select\(|loadUrl\(|webViewClient =/)
  const connect = kotlin.slice(kotlin.indexOf("fun connect("), kotlin.indexOf("override fun load("))
  assert.match(connect, /activity\.runOnUiThread/)
  assert.match(connect, /authority\.commit\(args\.generation, args\.endpoint\)/)
  assert(connect.indexOf("authority.commit") < connect.indexOf("current.view.loadUrl(args.endpoint)"))
  const rust = await read("../src-tauri/src/lib.rs")
  assert(rust.indexOf("guard.commit_connection") < rust.indexOf("tauri_plugin_mobile_recovery::connect("))
  assert.match(rust, /guard\.abort_connection\(&committed\)/)
})

test("Android renderer death revokes, destroys and closes; never reuses dead WebView", async () => {
  const kotlin = await read("../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/RecoveryPlugin.kt")
  const fence = await read("../src-tauri/recovery/android/src/main/java/ai/neuralnomads/codenomad/recovery/NavigationFence.kt")
  const callback = fence.slice(fence.indexOf("override fun onRenderProcessGone"))
  assert.match(callback, /authority\.disconnect\(\)/)
  assert.match(callback, /rendererGone\(view\)/)
  assert.match(callback, /return true/)
  assert.doesNotMatch(callback, /original\.onRenderProcessGone|\.loadUrl\(/)
  assert.match(kotlin, /binding = null[\s\S]*removeView\(dead\)[\s\S]*dead\.destroy\(\)[\s\S]*activity\.finish\(\)/)
})

test("iOS readiness and connection UIKit access/resolve are on the main queue", async () => {
  const swift = await read("../src-tauri/recovery/ios/Sources/RecoveryPlugin.swift")
  const readiness = swift.slice(swift.indexOf("@objc public func readiness"), swift.indexOf("@objc public func connect"))
  assert.match(readiness, /DispatchQueue\.main\.async[\s\S]*self\.launcherReady\(\)/)
  assert(readiness.indexOf("DispatchQueue.main.async") < readiness.indexOf("invoke.resolve"))
  const connect = swift.slice(swift.indexOf("@objc public func connect"), swift.indexOf("override func load"))
  assert.match(connect, /DispatchQueue\.main\.async[\s\S]*args\.generation == self\.generation/)
  assert.match(swift, /webview\.observe\(\\\.isLoading/)
  assert.match(swift, /webview\.observe\(\\\.url/)
})
