import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8")

test("WKWebView permission denial reaches the native delegate before construction", () => {
  const builder = read("../src-tauri/src/embedded_view.rs")
  const runtime = read("../vendor/tauri-runtime-wry-2.12.3/src/lib.rs")
  const webview = read("../vendor/wry-0.57.1/src/wkwebview/mod.rs")
  const delegate = read("../vendor/wry-0.57.1/src/wkwebview/class/wry_web_view_ui_delegate.rs")
  assert.match(builder, /\.on_permission_request\(\|_, _\| tauri::webview::PermissionResponse::Deny\)/)
  assert.match(runtime, /with_permission_handler[\s\S]*?permission_request_handler\(kind\)/)
  assert.match(webview, /WryWebViewUIDelegate::new\([\s\S]*?attributes.permission_handler/)
  assert.match(delegate, /request_media_capture_permission[\s\S]*?self.ivars\(\).permission_handler[\s\S]*?PermissionResponse::Deny => WKPermissionDecision::Deny/)
})

test("Linux installs an unconditional native permission denial", () => {
  const adapter = read("../src-tauri/src/embedded_view/linux.rs")
  assert.match(adapter, /connect_permission_request\(\|_, request\|\s*\{\s*request.deny\(\);\s*true/)
})
