import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")

test("WKWebView permission denial is installed from the reserved instance label", () => {
  const runtime = read("../vendor/tauri-runtime-wry-2.10.1/src/lib.rs")
  const webview = read("../vendor/wry-0.54.4/src/wkwebview/mod.rs")
  const delegate = read("../vendor/wry-0.54.4/src/wkwebview/class/wry_web_view_ui_delegate.rs")
  assert.match(runtime, /\.with_id\(&label\)/)
  assert.match(webview, /WryWebViewUIDelegate::new\([\s\S]*?webview_id.starts_with\("browser-"\) \|\| webview_id.starts_with\("embedded-remote-"\)/)
  assert.match(delegate, /deny_permissions: bool/)
  assert.match(delegate, /request_media_capture_permission[\s\S]*?self.ivars\(\).deny_permissions[\s\S]*?WKPermissionDecision::Deny[\s\S]*?WKPermissionDecision::Grant/)
})

test("Linux installs an unconditional native permission denial", () => {
  const adapter = read("../src-tauri/src/embedded_view/linux.rs")
  assert.match(adapter, /connect_permission_request\(\|_, request\|\s*\{\s*request.deny\(\);\s*true/)
})
